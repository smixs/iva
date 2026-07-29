import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  link,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acknowledgeQueueHead,
  createQueueItem,
  enqueueItem,
  enqueueQueueFile,
  loadQueueFile,
  materializeQueueItem,
  migrateQueueFile,
  normalizeQueueDocument,
  queueCount,
  queueHead,
  queueKeys,
  removeQueueHead,
  shouldQueueBusyUpdate,
  TELEGRAM_QUEUE_ACK_ROLLED_BACK,
  TELEGRAM_QUEUE_FATAL_DURABILITY,
} from "./telegram-queue.mjs";

process.env.TELEGRAM_BOT_TOKEN ??= "999:test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN ??= "test-secret";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.TELEGRAM_POLL_SETTLE_MS = "0";
const statusDataDir = mkdtempSync(join(tmpdir(), "iva-telegram-queue-status-"));
process.env.ASSISTANT_DATA_DIR = statusDataDir;
after(() => rmSync(statusDataDir, { recursive: true, force: true }));
const status = await import("./run-status.mjs");
const { drainReadyQueueHeads, routeMessageUpdate } = await import("../telegram-poll.mjs");

const privateUpdate = (updateId, text) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1,
    chat: { id: 1, type: "private" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
    text,
  },
});

async function queueFile(t) {
  const dir = await mkdtemp(join(tmpdir(), "iva-telegram-queue-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "telegram-queue.json");
}

async function waitForFile(file, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${file}`);
}

test("versioned FIFO items preserve update ids, order and duplicate retries across reload", async (t) => {
  const file = await queueFile(t);
  await enqueueQueueFile(file, "1:", privateUpdate(101, "first"), { now: () => 1 });
  await enqueueQueueFile(file, "1:", privateUpdate(102, "second"), { now: () => 2 });
  const duplicate = await enqueueQueueFile(file, "1:", privateUpdate(101, "first"), {
    now: () => 3,
  });

  assert.equal(duplicate.added, false);
  const { document } = await loadQueueFile(file, { strict: true });
  assert.equal(document.version, 1);
  assert.equal(queueCount(document, "1:"), 2);
  assert.deepEqual(
    document.queues["1:"].map((item) => [item.version, item.updateId, item.enqueuedAt]),
    [
      [1, 101, 1],
      [1, 102, 2],
    ],
  );
});

test("failed head removal leaves the whole FIFO byte-for-byte intact", async (t) => {
  const file = await queueFile(t);
  await enqueueQueueFile(file, "1:", privateUpdate(101, "first"));
  await enqueueQueueFile(file, "1:", privateUpdate(102, "second"));
  const before = await readFile(file, "utf8");

  await assert.rejects(
    acknowledgeQueueHead(file, "1:", 101, {
      renameImpl: async () => {
        throw new Error("injected ack rename failure");
      },
    }),
    /injected ack rename failure/,
  );

  assert.equal(await readFile(file, "utf8"), before);
  const { document } = await loadQueueFile(file, { strict: true });
  assert.equal(queueHead(document, "1:").updateId, 101);
});

test("ack directory-sync failure durably rolls back the original FIFO head", async (t) => {
  const file = await queueFile(t);
  await enqueueQueueFile(file, "1:", privateUpdate(101, "first"));
  await enqueueQueueFile(file, "1:", privateUpdate(102, "second"));
  let directorySyncs = 0;

  await assert.rejects(
    acknowledgeQueueHead(file, "1:", 101, {
      openImpl: async (path, flags) => {
        const handle = await open(path, flags);
        if (String(path) !== dirname(file) || flags !== "r") return handle;
        return {
          sync: async () => {
            directorySyncs++;
            if (directorySyncs === 2) throw new Error("injected ack directory sync failure");
            await handle.sync();
          },
          close: () => handle.close(),
        };
      },
    }),
    (error) => error?.code === TELEGRAM_QUEUE_ACK_ROLLED_BACK,
  );

  assert.equal(
    directorySyncs,
    4,
    "pending publication, failed removal, rollback and pending cleanup must all be ordered",
  );
  const { document } = await loadQueueFile(file, { strict: true });
  assert.deepEqual(
    document.queues["1:"].map((item) => item.updateId),
    [101, 102],
  );
});

test("SIGKILL after acknowledgement rename restores the pending original queue on load", async (t) => {
  const file = await queueFile(t);
  const marker = join(dirname(file), "ack-renamed");
  await enqueueQueueFile(file, "1:", privateUpdate(101, "first"));
  await enqueueQueueFile(file, "1:", privateUpdate(102, "second"));
  const child = spawn(
    process.execPath,
    [
      join(import.meta.dirname, "../fixtures/telegram-queue-ack-crash-child.mjs"),
      file,
      marker,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });

  await waitForFile(marker);
  child.kill("SIGKILL");
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: null, signal: "SIGKILL" }, stderr);

  const { document } = await loadQueueFile(file, { strict: true });
  assert.deepEqual(
    document.queues["1:"].map((item) => item.updateId),
    [101, 102],
    "recovery may duplicate accepted head 101 but must not lose it",
  );
  assert.equal(existsSync(`${file}.ack-pending`), false);
});

test("failed ack rollback becomes fatal and stops drain before another queue", async (t) => {
  const file = await queueFile(t);
  await enqueueQueueFile(file, "1:", privateUpdate(101, "first"));
  await enqueueQueueFile(file, "1:", privateUpdate(102, "second"));
  let directorySyncs = 0;

  await assert.rejects(
    acknowledgeQueueHead(file, "1:", 101, {
      openImpl: async (path, flags) => {
        const handle = await open(path, flags);
        if (String(path) !== dirname(file) || flags !== "r") return handle;
        return {
          sync: async () => {
            directorySyncs++;
            if (directorySyncs >= 2) {
              throw new Error("injected persistent directory sync failure");
            }
            await handle.sync();
          },
          close: () => handle.close(),
        };
      },
    }),
    (error) => error?.code === TELEGRAM_QUEUE_FATAL_DURABILITY,
  );

  const fatal = Object.assign(new Error("ack durability is unknown"), {
    code: TELEGRAM_QUEUE_FATAL_DURABILITY,
  });
  const delivered = [];
  const document = {
    version: 1,
    queues: Object.fromEntries([
      ["1:", [createQueueItem(privateUpdate(101, "first"), 1)]],
      ["2:", [createQueueItem(privateUpdate(201, "must not pass"), 2)]],
    ]),
  };
  await assert.rejects(
    drainReadyQueueHeads({
      loadImpl: async () => document,
      runningImpl: () => false,
      deliverImpl: async (update) => {
        delivered.push(update.update_id);
        return true;
      },
      acknowledgeImpl: async () => {
        throw fatal;
      },
      settleUntil: new Map(),
    }),
    (error) => error === fatal,
  );
  assert.deepEqual(delivered, [101]);
});

test("drain keeps the head before acceptance and advances exactly one item after acceptance", async () => {
  let document = enqueueItem(
    enqueueItem(
      { version: 1, queues: {} },
      "1:",
      createQueueItem(privateUpdate(101, "first"), 1),
    ).document,
    "1:",
    createQueueItem(privateUpdate(102, "second"), 2),
  ).document;
  const delivered = [];
  const loadImpl = async () => document;
  const acknowledgeImpl = async (key, updateId) => {
    document = removeQueueHead(document, key, updateId);
  };

  const rejectedCount = await drainReadyQueueHeads({
    loadImpl,
    runningImpl: () => false,
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      return false;
    },
    acknowledgeImpl,
    settleUntil: new Map(),
  });
  assert.equal(rejectedCount, 2);
  assert.equal(queueHead(document, "1:").updateId, 101);

  const acceptedCount = await drainReadyQueueHeads({
    loadImpl,
    runningImpl: () => false,
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      return true;
    },
    acknowledgeImpl,
    settleUntil: new Map(),
  });
  assert.equal(acceptedCount, 1);
  assert.equal(queueHead(document, "1:").updateId, 102);
  assert.deepEqual(delivered, [101, 101], "a retry may duplicate only the durable head");
});

test("an accepted head must observe its turn running and then idle before the next FIFO head", async () => {
  let document = enqueueItem(
    enqueueItem(
      { version: 1, queues: {} },
      "1:",
      createQueueItem(privateUpdate(101, "first"), 1),
    ).document,
    "1:",
    createQueueItem(privateUpdate(102, "second"), 2),
  ).document;
  let running = false;
  const delivered = [];
  const inFlight = new Map();
  const options = {
    loadImpl: async () => document,
    runningImpl: () => running,
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      return true;
    },
    acknowledgeImpl: async (key, updateId) => {
      document = removeQueueHead(document, key, updateId);
    },
    settleUntil: new Map(),
    inFlight,
  };

  assert.equal(await drainReadyQueueHeads(options), 1);
  assert.deepEqual(delivered, [101]);

  await drainReadyQueueHeads(options);
  assert.deepEqual(delivered, [101], "idle before turn.started must keep the next head gated");

  running = true;
  await drainReadyQueueHeads(options);
  assert.deepEqual(delivered, [101], "the accepted turn itself must keep the next head gated");

  running = false;
  assert.equal(await drainReadyQueueHeads(options), 0);
  assert.deepEqual(delivered, [101, 102]);
});

test("drain removes an orphaned running gate after the last queued turn becomes idle", async () => {
  const key = "1:";
  let document = enqueueItem(
    { version: 1, queues: {} },
    key,
    createQueueItem(privateUpdate(101, "queued"), 1),
  ).document;
  let running = false;
  const delivered = [];
  const inFlight = new Map();
  const options = {
    loadImpl: async () => document,
    runningImpl: () => running,
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      running = true;
      return true;
    },
    acknowledgeImpl: async (chatKey, updateId) => {
      document = removeQueueHead(document, chatKey, updateId);
    },
    settleUntil: new Map(),
    inFlight,
  };

  assert.equal(await drainReadyQueueHeads(options), 0);
  assert.equal(inFlight.get(key)?.state, "running");

  await drainReadyQueueHeads(options);
  assert.equal(inFlight.get(key)?.state, "running", "the active turn must keep its gate");
  assert.deepEqual(delivered, [101]);

  running = false;
  await drainReadyQueueHeads(options);
  assert.equal(inFlight.has(key), false);

  const fresh = privateUpdate(102, "fresh");
  const routed = await routeMessageUpdate(fresh, {
    chatKeyImpl: () => key,
    loadQueueImpl: async () => document,
    runningImpl: () => running,
    inFlight,
    queueCountImpl: queueCount,
    replyToBotImpl: () => false,
    shouldQueueImpl: () => true,
    enqueueImpl: async () => ({ count: 1 }),
    acknowledgeImpl: async () => {},
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      return true;
    },
  });

  assert.equal(routed, "delivered");
  assert.deepEqual(delivered, [101, 102]);
});

test("a completed run-status generation releases a turn whose running state fell between polls", async () => {
  let document = enqueueItem(
    enqueueItem(
      { version: 1, queues: {} },
      "1:",
      createQueueItem(privateUpdate(101, "first"), 1),
    ).document,
    "1:",
    createQueueItem(privateUpdate(102, "second"), 2),
  ).document;
  let currentStatus = { status: "idle", generation: 10 };
  const delivered = [];
  const options = {
    loadImpl: async () => document,
    statusImpl: () => currentStatus,
    runningImpl: () => currentStatus.status === "running",
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      if (update.update_id === 101) {
        // turn.started and turn.completed both happened while acceptance was pending.
        currentStatus = { status: "idle", generation: 12 };
      }
      return true;
    },
    acknowledgeImpl: async (key, updateId) => {
      document = removeQueueHead(document, key, updateId);
    },
    settleUntil: new Map(),
    inFlight: new Map(),
  };

  assert.equal(await drainReadyQueueHeads(options), 1);
  assert.equal(await drainReadyQueueHeads(options), 0);
  assert.deepEqual(delivered, [101, 102]);
});

test("an accepted turn with no observable status transition releases only after the stale bound", async () => {
  let document = enqueueItem(
    enqueueItem(
      { version: 1, queues: {} },
      "1:",
      createQueueItem(privateUpdate(101, "first"), 1),
    ).document,
    "1:",
    createQueueItem(privateUpdate(102, "second"), 2),
  ).document;
  let nowMs = 1_000;
  const delivered = [];
  const options = {
    loadImpl: async () => document,
    statusImpl: () => ({ status: "idle", generation: 5 }),
    runningImpl: () => false,
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      return true;
    },
    acknowledgeImpl: async (key, updateId) => {
      document = removeQueueHead(document, key, updateId);
    },
    now: () => nowMs,
    settleUntil: new Map(),
    inFlight: new Map(),
    gateWaitMs: 100,
  };

  await drainReadyQueueHeads(options);
  nowMs += 99;
  await drainReadyQueueHeads(options);
  assert.deepEqual(delivered, [101]);

  nowMs += 1;
  await drainReadyQueueHeads(options);
  assert.deepEqual(delivered, [101, 102]);
});

test("a drain pass has one global delivery budget and rotates a stalled first key", async () => {
  let nowMs = 0;
  const attempts = [];
  const rotationState = { afterKey: null };
  const document = {
    version: 1,
    queues: Object.fromEntries(
      [1, 2, 3].map((chatId) => {
        const update = privateUpdate(chatId, `head ${chatId}`);
        update.message.chat.id = chatId;
        return [`${chatId}:`, [createQueueItem(update, chatId)]];
      }),
    ),
  };
  const options = {
    loadImpl: async () => document,
    runningImpl: () => false,
    deliverImpl: async (update, { timeoutMs }) => {
      attempts.push([update.message.chat.id, timeoutMs]);
      nowMs += timeoutMs;
      return false;
    },
    acknowledgeImpl: async () => assert.fail("a stalled head must remain durable"),
    now: () => nowMs,
    settleUntil: new Map(),
    inFlight: new Map(),
    rotationState,
    passBudgetMs: 5_000,
    deliveryTimeoutMs: 5_000,
  };

  await drainReadyQueueHeads(options);
  assert.deepEqual(attempts, [[1, 5_000]]);

  await drainReadyQueueHeads(options);
  assert.deepEqual(
    attempts,
    [
      [1, 5_000],
      [2, 5_000],
    ],
    "the next pass must give the next chat the global timeout budget",
  );

  await drainReadyQueueHeads(options);
  assert.deepEqual(
    attempts,
    [
      [1, 5_000],
      [2, 5_000],
      [3, 5_000],
    ],
  );
});

test("a missing terminal event becomes drainable after the run-status TTL", async () => {
  const key = "9:";
  status.setChatStatus(key, {
    status: "running",
    continuationToken: "9::",
    sessionId: "orphaned-session",
    turnId: "orphaned-turn",
  });
  const staleAt = status.getChatStatus(key).updatedAt + status.RUN_STALE_MS + 1;
  let document = enqueueItem(
    { version: 1, queues: {} },
    key,
    createQueueItem(privateUpdate(301, "recover after stale status"), 1),
  ).document;
  const delivered = [];

  const remaining = await drainReadyQueueHeads({
    loadImpl: async () => document,
    runningImpl: (chatKey) => status.isRunning(chatKey, staleAt),
    deliverImpl: async (update) => {
      delivered.push(update.update_id);
      return true;
    },
    acknowledgeImpl: async (chatKey, updateId) => {
      document = removeQueueHead(document, chatKey, updateId);
    },
    settleUntil: new Map(),
  });

  assert.deepEqual(delivered, [301]);
  assert.equal(remaining, 0);
});

test("legacy string arrays preserve private owner text but never invent a group author", async (t) => {
  const file = await queueFile(t);
  await writeFile(
    file,
    JSON.stringify({
      "42:": ["first", "second"],
      "-100:7": ["topic follow-up"],
    }),
  );

  const document = await migrateQueueFile(file);
  assert.equal(document.version, 1);
  assert.equal(queueCount(document), 2);
  assert.deepEqual(
    document.queues["42:"].map((item) => item.legacyText),
    ["first", "second"],
  );
  const privateReplay = materializeQueueItem("42:", document.queues["42:"][0], {
    legacyAllowedUserIds: new Set(["42"]),
  });
  assert.equal(privateReplay.message.text, "first");
  assert.equal(privateReplay.message.chat.id, 42);
  assert.equal(privateReplay.message.from.id, 42);
  const legacyGroupItem = normalizeQueueDocument({
    "-100:7": ["topic follow-up"],
  }).document.queues["-100:7"][0];
  assert.equal(
    materializeQueueItem("-100:7", legacyGroupItem, {
      legacyAllowedUserIds: new Set(["42"]),
    }),
    null,
  );

  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(queueCount(persisted), 2);
  const [quarantineName] = (await readdir(dirname(file))).filter((name) =>
    name.includes(".legacy-unattributed-"));
  const quarantined = JSON.parse(await readFile(join(dirname(file), quarantineName), "utf8"));
  assert.equal(queueCount(quarantined), 1);
  assert.equal(quarantined.queues["-100:7"][0].legacyText, "topic follow-up");
});

test("legacy group quarantine failure leaves the original queue active for retry", async (t) => {
  const file = await queueFile(t);
  const original = JSON.stringify({
    "42:": ["private follow-up"],
    "-100:": ["group text with unknown author"],
  });
  await writeFile(file, original);

  await assert.rejects(
    migrateQueueFile(file, {
      linkImpl: async (source, target) => {
        if (target.includes(".legacy-unattributed-")) {
          throw new Error("quarantine link failed");
        }
        await link(source, target);
      },
    }),
    /quarantine link failed/,
  );

  assert.equal(await readFile(file, "utf8"), original);
  assert.deepEqual(
    (await readdir(dirname(file))).filter((name) => name.includes(".legacy-unattributed-")),
    [],
  );
});

test("failed active migration keeps both the old queue and its group quarantine", async (t) => {
  const file = await queueFile(t);
  const original = JSON.stringify({
    "42:": ["private follow-up"],
    "-100:": ["group text with unknown author"],
  });
  await writeFile(file, original);

  await assert.rejects(
    migrateQueueFile(file, {
      renameImpl: async (source, target) => {
        if (target === file) throw new Error("active rename failed");
        await rename(source, target);
      },
    }),
    /active rename failed/,
  );

  assert.equal(await readFile(file, "utf8"), original);
  const [quarantineName] = (await readdir(dirname(file))).filter((name) =>
    name.includes(".legacy-unattributed-"));
  const quarantined = JSON.parse(await readFile(join(dirname(file), quarantineName), "utf8"));
  assert.equal(quarantined.queues["-100:"][0].legacyText, "group text with unknown author");
});

test("separate legacy migrations never overwrite an earlier group quarantine", async (t) => {
  const file = await queueFile(t);
  const first = JSON.stringify({ "-100:": ["first byte set"] });
  const second = JSON.stringify({ "-100:": ["second byte set"] });
  const logged = [];
  const options = {
    quarantineNow: () => 123,
    quarantineNonce: () => "same",
    onLegacyQuarantine: (path) => logged.push(path),
  };

  await writeFile(file, first);
  await migrateQueueFile(file, options);
  await writeFile(file, second);
  await migrateQueueFile(file, options);

  assert.equal(logged.length, 2);
  assert.notEqual(logged[0], logged[1]);
  assert.match(logged[0], /\.legacy-unattributed-/);
  assert.match(logged[1], /\.legacy-unattributed-/);
  const preserved = await Promise.all(
    logged.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
  );
  assert.deepEqual(
    preserved.map((document) => document.queues["-100:"][0].legacyText),
    ["first byte set", "second byte set"],
  );
});

test("drain leaves legacy group text with unknown author undelivered", async () => {
  let document = normalizeQueueDocument({
    "-100:": ["unaddressed group text"],
  }).document;
  const delivered = [];
  const acknowledged = [];

  const remaining = await drainReadyQueueHeads({
    loadImpl: async () => document,
    runningImpl: () => false,
    legacyAllowedUserIds: new Set(["42"]),
    deliverImpl: async (update) => {
      delivered.push(update);
      return true;
    },
    acknowledgeImpl: async (chatKey, updateId) => {
      acknowledged.push([chatKey, updateId]);
      document = removeQueueHead(document, chatKey, updateId);
    },
    settleUntil: new Map(),
  });

  assert.deepEqual(delivered, []);
  assert.deepEqual(acknowledged, []);
  assert.equal(remaining, 1);
  assert.equal(queueHead(document, "-100:").legacyText, "unaddressed group text");
});

test("queued media and quoted metadata replay from the durable update without transformation", async (t) => {
  const file = await queueFile(t);
  const update = {
    update_id: 201,
    message: {
      message_id: 9,
      date: 1,
      chat: { id: 1, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Owner" },
      caption: "look at this",
      photo: [{ file_id: "small" }, { file_id: "large" }],
      reply_to_message: {
        message_id: 8,
        from: { id: 7, is_bot: false, first_name: "Quoted" },
        text: "quoted source",
      },
    },
  };
  await enqueueQueueFile(file, "1:", update);
  const { document } = await loadQueueFile(file, { strict: true });

  assert.deepEqual(materializeQueueItem("1:", queueHead(document, "1:")), update);
});

test("busy routing is fail-closed and keeps addressed private, group and topic updates", () => {
  const allowedUserIds = new Set(["42"]);
  const options = { allowedUserIds, botUsername: "my_bot" };
  const group = (text, threadId, userId = 42) => ({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: -100, type: "supergroup" },
      from: { id: userId, is_bot: false },
      text,
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
    },
  });

  assert.equal(shouldQueueBusyUpdate(privateUpdate(1, "private"), options), true);
  assert.equal(
    shouldQueueBusyUpdate(
      {
        ...privateUpdate(1, "untrusted"),
        message: { ...privateUpdate(1, "untrusted").message, from: { id: 7 } },
      },
      options,
    ),
    false,
  );
  assert.equal(shouldQueueBusyUpdate(group("group noise"), options), false);
  assert.equal(shouldQueueBusyUpdate(group("@my_bot addressed"), options), true);
  assert.equal(shouldQueueBusyUpdate(group("/task topic", 7), options), true);
  assert.equal(shouldQueueBusyUpdate(group("@my_bot untrusted", 7, 7), options), false);
  assert.equal(shouldQueueBusyUpdate(group("x@my_botany.example"), options), false);
  assert.equal(shouldQueueBusyUpdate(group("@my_bot_suffix"), options), false);
});

test("busy group routing sees mentions and commands in collected iva_parts", () => {
  const options = { allowedUserIds: new Set(["42"]), botUsername: "my_bot" };
  const collected = (text) => ({
    update_id: 2,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: -100, type: "supergroup" },
      from: { id: 42, is_bot: false },
      photo: [{ file_id: "photo" }],
      iva_parts: [
        {
          message_id: 1,
          date: 1,
          chat: { id: -100, type: "supergroup" },
          from: { id: 42, is_bot: false },
          photo: [{ file_id: "photo" }],
        },
        {
          message_id: 2,
          date: 1,
          chat: { id: -100, type: "supergroup" },
          from: { id: 42, is_bot: false },
          text,
        },
      ],
    },
  });

  assert.equal(shouldQueueBusyUpdate(collected("@my_bot see album"), options), true);
  assert.equal(shouldQueueBusyUpdate(collected("/task save album"), options), true);
  assert.equal(shouldQueueBusyUpdate(collected("unaddressed caption"), options), false);
  const malformed = collected("unaddressed caption");
  malformed.message.iva_parts.splice(1, 0, null, "broken");
  assert.doesNotThrow(() => shouldQueueBusyUpdate(malformed, options));
  assert.equal(shouldQueueBusyUpdate(malformed, options), false);
});

test("group routing validates exact Telegram entities across Unicode and malformed input", () => {
  const options = { allowedUserIds: new Set(["42"]), botUsername: "my_bot" };
  const group = (text, entities) => ({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: -100, type: "supergroup" },
      from: { id: 42, is_bot: false },
      text,
      entities,
    },
  });

  const unicodeText = "🙂 ask @my_bot now";
  assert.equal(
    shouldQueueBusyUpdate(
      group(unicodeText, [{
        type: "mention",
        offset: unicodeText.indexOf("@my_bot"),
        length: "@my_bot".length,
      }]),
      options,
    ),
    true,
  );
  assert.equal(shouldQueueBusyUpdate(group("İ @MY_BOT", undefined), options), true);
  assert.equal(
    shouldQueueBusyUpdate(
      group("Ж@my_bot", [{ type: "mention", offset: 1, length: 7 }]),
      options,
    ),
    false,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      group("@my_bot_suffix", [{ type: "mention", offset: 0, length: 7 }]),
      options,
    ),
    false,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      group("@my_bot", [{ type: "mention", offset: -1, length: 999 }]),
      options,
    ),
    false,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      group("/task@my_bot", [{
        type: "bot_command",
        offset: 0,
        length: "/task@my_bot".length,
      }]),
      options,
    ),
    true,
  );
  assert.equal(
    shouldQueueBusyUpdate(
      group("/task@my_bot_suffix", [{
        type: "bot_command",
        offset: 0,
        length: "/task@my_bot".length,
      }]),
      options,
    ),
    false,
  );
  assert.doesNotThrow(() =>
    shouldQueueBusyUpdate(group("@my_bot", { offset: 0, length: 7 }), options));
  assert.equal(
    shouldQueueBusyUpdate(group("@my_bot", { offset: 0, length: 7 }), options),
    false,
  );
});

test("__proto__ is persisted as a queue data key without prototype mutation or loss", async (t) => {
  const file = await queueFile(t);
  await enqueueQueueFile(file, "__proto__", privateUpdate(401, "prototype-safe"));

  const { document } = await loadQueueFile(file, { strict: true });
  assert.equal(Object.hasOwn(document.queues, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(document.queues), Object.prototype);
  assert.equal(queueCount(document, "__proto__"), 1);
  assert.equal(queueHead(document, "__proto__").updateId, 401);
  assert.deepEqual(queueKeys(document), ["__proto__"]);

  await acknowledgeQueueHead(file, "__proto__", 401);
  const after = await loadQueueFile(file, { strict: true });
  assert.equal(Object.hasOwn(after.document.queues, "__proto__"), false);
  assert.equal(queueCount(after.document), 0);
});
