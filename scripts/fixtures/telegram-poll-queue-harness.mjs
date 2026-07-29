import { mock } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [mode, dataDir, fault = "none"] = process.argv.slice(2);
if (!mode || !dataDir) throw new Error("usage: harness <mode> <data-dir> [fault]");

process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.ASSISTANT_HOST = "http://iva-red.invalid";
process.env.TELEGRAM_BOT_TOKEN = "999:test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.TELEGRAM_POLL_SETTLE_MS = "0";
process.env.TELEGRAM_COLLECT_QUIET_MS ??= "0";
process.env.AGENT_LANGUAGE = "en";

mkdirSync(dataDir, { recursive: true });
const offsetFile = join(dataDir, "telegram-offset.json");
const queueFile = join(dataDir, "telegram-queue.json");
const resultFile = join(dataDir, "queue-harness-result.json");
if (!existsSync(offsetFile)) writeFileSync(offsetFile, JSON.stringify({ offset: 100 }));
let queueDirSyncAttempts = 0;
let queueDirSyncSuccesses = 0;

const status = await import("../lib/run-status.mjs");
const privateKey = "1:";
const groupKey = "-100:";
const topicKey = "-100:7";

if (
  mode === "disk-failure" ||
  mode === "dir-sync-retry" ||
  mode === "auto-drain" ||
  mode === "collect-burst" ||
  mode === "restart-persist" ||
  mode === "routing"
) {
  status.setChatStatus(privateKey, {
    status: "running",
    continuationToken: "1::",
    sessionId: "session-1",
    turnId: "turn-1",
  });
} else if (mode === "restart-drain") {
  status.setChatStatus(privateKey, {
    status: "idle",
    continuationToken: "1::",
    sessionId: null,
    turnId: null,
  });
}
if (mode === "group-noise" || mode === "routing") {
  status.setChatStatus(groupKey, {
    status: "running",
    continuationToken: "-100::reply-anchor",
    sessionId: "session-group",
    turnId: "turn-group",
  });
}
if (mode === "routing") {
  status.setChatStatus(topicKey, {
    status: "running",
    continuationToken: "-100:7:reply-anchor",
    sessionId: "session-topic",
    turnId: "turn-topic",
  });
}

if (fault !== "none") {
  const fsPromises = await import("node:fs/promises");
  const namedExports = Object.fromEntries(
    Object.entries(fsPromises).filter(([name]) => name !== "default"),
  );
  const originalWriteFile = fsPromises.writeFile;
  const originalRename = fsPromises.rename;
  const originalOpen = fsPromises.open;
  namedExports.writeFile = async (path, ...args) => {
    if (fault === "write" && String(path).startsWith(`${queueFile}.tmp-`)) {
      throw Object.assign(new Error("injected queue write failure"), { code: "ENOSPC" });
    }
    return originalWriteFile(path, ...args);
  };
  namedExports.rename = async (from, to, ...args) => {
    if (fault === "rename" && String(to) === queueFile) {
      throw Object.assign(new Error("injected queue rename failure"), { code: "EIO" });
    }
    return originalRename(from, to, ...args);
  };
  namedExports.open = async (path, flags, ...args) => {
    const handle = await originalOpen(path, flags, ...args);
    if (fault !== "dir-sync-once" || String(path) !== dataDir || flags !== "r") {
      return handle;
    }
    return {
      sync: async () => {
        queueDirSyncAttempts++;
        if (queueDirSyncAttempts === 1) {
          throw Object.assign(new Error("injected queue directory sync failure"), {
            code: "EIO",
          });
        }
        await handle.sync();
        queueDirSyncSuccesses++;
      },
      close: () => handle.close(),
    };
  };
  mock.module("node:fs/promises", {
    defaultExport: fsPromises.default,
    namedExports,
  });
}

const privateUpdate = (updateId, text, chatId = 1) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1,
    chat: { id: chatId, type: "private" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
    text,
  },
});
const groupNoiseUpdate = {
  update_id: 102,
  message: {
    message_id: 102,
    date: 1,
    chat: { id: -100, type: "supergroup", title: "Test group" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
    text: "side conversation, not addressed to Iva",
  },
};
const groupUpdate = (updateId, text, threadId) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1,
    chat: { id: -100, type: "supergroup", title: "Test group" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
    text,
    ...(threadId === undefined ? {} : { message_thread_id: threadId }),
  },
});

const deliveries = [];
const deliveryRoutes = [];
const reactions = [];
const queueStatuses = [];
const requestedOffsets = [];
let getUpdatesCalls = 0;

const jsonResponse = (payload, statusCode = 200) => ({
  ok: statusCode >= 200 && statusCode < 300,
  status: statusCode,
  headers: {
    get: (name) =>
      statusCode === 204 && String(name).toLowerCase() === "x-iva-telegram-acceptance"
        ? "turn"
        : null,
  },
  body: null,
  json: async () => payload,
});

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function finish() {
  writeFileSync(
    resultFile,
    JSON.stringify({
      deliveries,
      deliveryRoutes,
      reactions,
      queueStatuses,
      requestedOffsets,
      queueDirSyncAttempts,
      queueDirSyncSuccesses,
      offset: readJson(offsetFile, null),
      queue: readJson(queueFile, {}),
    }),
  );
  process.exit(0);
}

if (mode === "fair-drain") {
  writeFileSync(queueFile, JSON.stringify({
    version: 1,
    queues: {
      "1:": [{
        version: 1,
        updateId: 101,
        enqueuedAt: 1,
        update: privateUpdate(101, "poison head", 1),
      }],
      "2:": [{
        version: 1,
        updateId: 102,
        enqueuedAt: 2,
        update: privateUpdate(102, "healthy head", 2),
      }],
    },
  }));
}

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.startsWith("http://iva-red.invalid/")) {
    deliveryRoutes.push(new URL(target).pathname);
    const delivery = JSON.parse(options.body);
    deliveries.push(delivery);
    if (
      mode === "fair-drain" &&
      new URL(target).pathname === "/eve/v1/telegram/accepted" &&
      delivery.message?.chat?.id === 1
    ) {
      return jsonResponse({}, 503);
    }
    if (
      (mode === "auto-drain" || mode === "collect-burst" || mode === "restart-drain") &&
      new URL(target).pathname === "/eve/v1/telegram/accepted"
    ) {
      status.setChatStatus(privateKey, {
        status: "running",
        sessionId: `session-${delivery.update_id}`,
        turnId: `turn-${delivery.update_id}`,
      });
    }
    return jsonResponse(
      {},
      new URL(target).pathname === "/eve/v1/telegram/accepted" ? 204 : 200,
    );
  }

  const method = new URL(target).pathname.split("/").at(-1);
  const body = options.body ? JSON.parse(options.body) : {};
  if (method === "getUpdates") {
    getUpdatesCalls++;
    requestedOffsets.push(body.offset);

    if (mode === "disk-failure") {
      if (getUpdatesCalls === 1) return jsonResponse({ ok: true, result: [privateUpdate(101, "persist me")] });
      finish();
    }
    if (mode === "dir-sync-retry") {
      if (getUpdatesCalls <= 2) {
        return jsonResponse({ ok: true, result: [privateUpdate(101, "persist me")] });
      }
      finish();
    }
    if (mode === "auto-drain") {
      if (getUpdatesCalls === 1) {
        return jsonResponse({
          ok: true,
          result: [privateUpdate(101, "first"), privateUpdate(102, "second")],
        });
      }
      if (getUpdatesCalls === 2) {
        status.setChatStatus(privateKey, {
          status: "idle",
          sessionId: null,
          turnId: null,
        });
      }
      if (getUpdatesCalls > 2 && status.isRunning(privateKey)) {
        status.setChatStatus(privateKey, {
          status: "idle",
          sessionId: null,
          turnId: null,
        });
      }
      if (getUpdatesCalls >= 6) finish();
      return jsonResponse({ ok: true, result: [] });
    }
    if (mode === "collect-burst") {
      if (getUpdatesCalls === 1) {
        return jsonResponse({
          ok: true,
          result: [privateUpdate(101, "first"), privateUpdate(102, "second")],
        });
      }
      if (getUpdatesCalls === 2) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
      }
      if (getUpdatesCalls === 3 || (getUpdatesCalls > 3 && status.isRunning(privateKey))) {
        status.setChatStatus(privateKey, {
          status: "idle",
          sessionId: null,
          turnId: null,
        });
      }
      if (getUpdatesCalls >= 5) finish();
      return jsonResponse({ ok: true, result: [] });
    }
    if (mode === "restart-persist") {
      if (getUpdatesCalls === 1) {
        return jsonResponse({
          ok: true,
          result: [privateUpdate(101, "first"), privateUpdate(102, "second")],
        });
      }
      finish();
    }
    if (mode === "restart-drain") {
      if (status.isRunning(privateKey)) {
        status.setChatStatus(privateKey, {
          status: "idle",
          sessionId: null,
          turnId: null,
        });
      }
      if (getUpdatesCalls >= 6) finish();
      return jsonResponse({ ok: true, result: [] });
    }
    if (mode === "group-noise") {
      if (getUpdatesCalls === 1) return jsonResponse({ ok: true, result: [groupNoiseUpdate] });
      finish();
    }
    if (mode === "routing") {
      if (getUpdatesCalls === 1) {
        return jsonResponse({
          ok: true,
          result: [
            privateUpdate(101, "private follow-up"),
            groupNoiseUpdate,
            groupUpdate(103, "@my_bot group follow-up"),
            groupUpdate(104, "/task topic follow-up", 7),
          ],
        });
      }
      finish();
    }
    if (mode === "fair-drain") finish();
    throw new Error(`unknown harness mode: ${mode}`);
  }
  if (method === "setMessageReaction") reactions.push(body);
  if (method === "sendMessage" && /^Queued \(\d+\)/.test(body.text || "")) {
    queueStatuses.push(body);
  }
  return jsonResponse({ ok: true, result: { message_id: 1 } });
};

const pollPath = resolve("scripts/telegram-poll.mjs");
process.argv[1] = pollPath;
await import(pathToFileURL(pollPath).href);
