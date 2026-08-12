/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registration promises and the harness preserves production async seams. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramChannel } from "eve/channels/telegram";
import type {
  TelegramChannelState,
  TelegramContext,
  TelegramMessage,
} from "eve/channels/telegram";
import type { RouteHandlerArgs, Session } from "eve/channels";
import {
  createQueueItem,
  enqueueItem,
  queueHead,
  removeQueueHead,
} from "./lib/telegram-queue.ts";
import {
  addTelegramQueueReceipt,
  handleAcceptedTelegramWebhook,
  TELEGRAM_QUEUE_RECEIPT_FIELD,
  wrapTelegramQueueOnMessage,
} from "#lib/telegram-acceptance.ts";

const WEBHOOK_SECRET = "test-secret";
type TestUpdate = {
  update_id: number;
  message: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    from: { id: number; is_bot: boolean; first_name: string };
    text?: string;
    [key: string]: unknown;
  };
};
type DeliveryResult = true | false | "handled";
type SendImpl = (
  update: TestUpdate,
  input: unknown,
  options: unknown,
) => Promise<unknown>;
type DeliveryOptions = {
  webhookVerifier?: (
    request: Request,
    rawBody: string,
  ) => Promise<string | boolean>;
  onMessage?: (context: TelegramContext, message: TelegramMessage) => unknown;
  marked?: boolean;
  webhookSecretHeader?: string;
  completedUpdatesFile?: string;
};
type DrainReadyQueueHeads = (
  options: Record<string, unknown>,
) => Promise<number>;

const isCompletedLedger = (
  value: unknown,
): value is { botId: string; updates: number[] } =>
  value !== null &&
  typeof value === "object" &&
  "botId" in value &&
  typeof value.botId === "string" &&
  "updates" in value &&
  Array.isArray(value.updates) &&
  value.updates.every((id) => typeof id === "number");

const fakeBotToken = (id: number, label: string): string =>
  `${id}:${Buffer.from(label).toString("base64url")}`;
const fakeSession = (id: string): Session => ({
  id,
  continuationToken: id,
  cancel: () => {
    throw new Error("not used");
  },
  getEventStream: () => {
    throw new Error("not used");
  },
  getStreamTailIndex: () => {
    throw new Error("not used");
  },
});
process.env.TELEGRAM_BOT_TOKEN = fakeBotToken(999, "acceptance-default");
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = WEBHOOK_SECRET;
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.TELEGRAM_POLL_SETTLE_MS = "0";
const pollModulePath = "./telegram-poll.mjs";
const { drainReadyQueueHeads } = (await import(pollModulePath)) as {
  drainReadyQueueHeads: DrainReadyQueueHeads;
};

const privateUpdate = (updateId: number, text?: string): TestUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1,
    chat: { id: 1, type: "private" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
    text,
  },
});

function deferred(): {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: unknown) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function productionTelegramDelivery(
  sendImpl: SendImpl,
  {
    webhookVerifier,
    onMessage = () => ({ auth: null }),
    marked = true,
    webhookSecretHeader = WEBHOOK_SECRET,
    completedUpdatesFile = join(
      mkdtempSync(join(tmpdir(), "iva-completed-updates-test-")),
      "completed-updates.json",
    ),
  }: DeliveryOptions = {},
): (update: TestUpdate) => Promise<DeliveryResult> {
  const channel = telegramChannel({
    credentials: {
      webhookVerifier:
        webhookVerifier ?? (async (_request, rawBody) => rawBody),
    },
    onMessage: wrapTelegramQueueOnMessage(
      onMessage as Parameters<typeof wrapTelegramQueueOnMessage>[0],
    ),
  });
  const route = channel.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" &&
      candidate.method === "POST" &&
      candidate.path === "/eve/v1/telegram",
  );
  assert.ok(route && route.transport !== "websocket");

  return async (update: TestUpdate) => {
    const routeArgs: RouteHandlerArgs<TelegramChannelState> = {
      send: async (input, options) => {
        await sendImpl(update, input, options);
        return fakeSession(`test-session-${update.update_id}`);
      },
      resolveActiveSession: () => {
        throw new Error("not used");
      },
      cancel: () => {
        throw new Error("not used");
      },
      clear: () => {
        throw new Error("not used");
      },
      compact: () => {
        throw new Error("not used");
      },
      reset: () => {
        throw new Error("not used");
      },
      getSession: () => {
        throw new Error("not used");
      },
      receive: () => {
        throw new Error("not used");
      },
      params: {},
      waitUntil: () => {},
      requestIp: "127.0.0.1",
    };
    const response = await handleAcceptedTelegramWebhook(
      route.handler,
      new Request("http://iva.test/eve/v1/telegram/accepted", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": webhookSecretHeader,
        },
        body: JSON.stringify(marked ? addTelegramQueueReceipt(update) : update),
      }),
      routeArgs,
      { completedUpdatesFile },
    );
    return response.ok
      ? response.headers.get("x-iva-telegram-acceptance") === "handled"
        ? "handled"
        : true
      : false;
  };
}

test("intentional authored no-send accepts queued contact, then the later text keeps FIFO order", async () => {
  const contact = {
    ...privateUpdate(101, undefined),
    message: {
      ...privateUpdate(101, undefined).message,
      contact: { first_name: "Ada", phone_number: "+99800" },
    },
  };
  let document = enqueueItem(
    enqueueItem({ version: 1, queues: {} }, "1:", createQueueItem(contact, 1))
      .document,
    "1:",
    createQueueItem(privateUpdate(102, "after contact"), 2),
  ).document;
  const sent: number[] = [];
  const deliverImpl = productionTelegramDelivery(
    async (update) => {
      sent.push(update.update_id);
      return { id: `session-${update.update_id}` };
    },
    {
      onMessage: (_ctx, message) => {
        assert.equal(
          Object.hasOwn(message.raw, TELEGRAM_QUEUE_RECEIPT_FIELD),
          false,
        );
        return message.raw.contact ? null : { auth: null };
      },
    },
  );
  const acknowledgeImpl = async (key: string, updateId: number) => {
    document = removeQueueHead(document, key, updateId);
  };
  const inFlight = new Map();

  assert.equal(
    await drainReadyQueueHeads({
      loadImpl: async () => document,
      runningImpl: () => false,
      deliverImpl,
      acknowledgeImpl,
      settleUntil: new Map(),
      inFlight,
    }),
    1,
  );
  assert.equal(queueHead(document, "1:")?.updateId, 102);
  assert.deepEqual(sent, []);

  assert.equal(
    await drainReadyQueueHeads({
      loadImpl: async () => document,
      runningImpl: () => false,
      deliverImpl,
      acknowledgeImpl,
      settleUntil: new Map(),
      inFlight,
    }),
    0,
  );
  assert.deepEqual(sent, [102]);
});

test("intentional silent sticker no-send is accepted, while throw and unmarked null are rejected", async () => {
  const sticker = {
    ...privateUpdate(201, undefined),
    message: {
      ...privateUpdate(201, undefined).message,
      sticker: { file_id: "silent-sticker" },
    },
  };
  let sendCalls = 0;
  const silent = productionTelegramDelivery(
    async () => {
      sendCalls++;
      return { id: "must-not-send" };
    },
    { onMessage: () => null },
  );
  assert.equal(await silent(sticker), "handled");
  assert.equal(sendCalls, 0);

  const thrown = productionTelegramDelivery(
    async () => {
      sendCalls++;
      return { id: "must-not-send" };
    },
    {
      onMessage: () => {
        throw new Error("injected authored handler failure");
      },
    },
  );
  assert.equal(await thrown(sticker), false);
  assert.equal(sendCalls, 0);

  const unmarked = productionTelegramDelivery(
    async () => {
      sendCalls++;
      return { id: "must-not-send" };
    },
    { onMessage: () => null, marked: false },
  );
  assert.equal(await unmarked(sticker), false);
  assert.equal(sendCalls, 0);
});

test("acceptance route preserves Telegram auth failure and rejects malformed no-send updates", async () => {
  let sendCalls = 0;
  const rejectedByVerifier = productionTelegramDelivery(
    async () => {
      sendCalls++;
      return { id: "must-not-run" };
    },
    { webhookVerifier: async () => false },
  );
  assert.equal(
    await rejectedByVerifier(privateUpdate(1, "unauthorized")),
    false,
  );
  assert.equal(sendCalls, 0);

  const channel = telegramChannel({
    credentials: { webhookVerifier: async (_request, rawBody) => rawBody },
    onMessage: () => ({ auth: null }),
  });
  const route = channel.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" &&
      candidate.method === "POST" &&
      candidate.path === "/eve/v1/telegram",
  );
  assert.ok(route && route.transport !== "websocket");
  const malformed = await handleAcceptedTelegramWebhook(
    route.handler,
    new Request("http://iva.test/eve/v1/telegram/accepted", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    }),
    {
      send: () => {
        sendCalls++;
        throw new Error("must not run");
      },
      resolveActiveSession: () => {
        throw new Error("must not run");
      },
      cancel: () => {
        throw new Error("must not run");
      },
      clear: () => {
        throw new Error("must not run");
      },
      compact: () => {
        throw new Error("must not run");
      },
      reset: () => {
        throw new Error("must not run");
      },
      getSession: () => {
        throw new Error("must not run");
      },
      receive: () => {
        throw new Error("must not run");
      },
      params: {},
      waitUntil: () => {},
      requestIp: "127.0.0.1",
    },
  );
  assert.equal(malformed.ok, false);
  assert.equal(malformed.status, 503);
  assert.equal(sendCalls, 0);
});

test("production Telegram deferred failure retains the head and cannot start the next head", async () => {
  let document = enqueueItem(
    enqueueItem(
      { version: 1, queues: {} },
      "1:",
      createQueueItem(privateUpdate(101, "first"), 1),
    ).document,
    "1:",
    createQueueItem(privateUpdate(102, "second"), 2),
  ).document;
  const attempts: number[] = [];

  const remaining = await drainReadyQueueHeads({
    loadImpl: async () => document,
    runningImpl: () => false,
    deliverImpl: productionTelegramDelivery(async (update) => {
      attempts.push(update.update_id);
      throw new Error("injected Eve acceptance failure");
    }),
    acknowledgeImpl: async (key: string, updateId: number) => {
      document = removeQueueHead(document, key, updateId);
    },
    settleUntil: new Map(),
    inFlight: new Map(),
  });

  assert.equal(remaining, 2);
  assert.equal(queueHead(document, "1:")?.updateId, 101);
  assert.deepEqual(attempts, [101]);
});

test("production Telegram receipt removes exactly one head only after Eve send resolves", async () => {
  let document = enqueueItem(
    enqueueItem(
      { version: 1, queues: {} },
      "1:",
      createQueueItem(privateUpdate(101, "first"), 1),
    ).document,
    "1:",
    createQueueItem(privateUpdate(102, "second"), 2),
  ).document;
  const acceptance = deferred();
  const attempts: number[] = [];

  const drain = drainReadyQueueHeads({
    loadImpl: async () => document,
    runningImpl: () => false,
    deliverImpl: productionTelegramDelivery(async (update) => {
      attempts.push(update.update_id);
      return acceptance.promise;
    }),
    acknowledgeImpl: async (key: string, updateId: number) => {
      document = removeQueueHead(document, key, updateId);
    },
    settleUntil: new Map(),
    inFlight: new Map(),
  });

  await waitFor(() => attempts.length === 1, "the first delivery attempt");
  assert.equal(queueHead(document, "1:")?.updateId, 101);
  assert.deepEqual(attempts, [101]);

  acceptance.resolve({ id: "accepted-session" });
  assert.equal(await drain, 1);
  assert.equal(queueHead(document, "1:")?.updateId, 102);
  assert.deepEqual(
    attempts,
    [101],
    "one drain pass must keep one in-flight head per chat",
  );
});

test("a completed update is handled from disk without invoking the authored handler", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-completed-ledger-test-"));
  const completedUpdatesFile = join(root, "completed-updates.json");
  let handlerCalls = 0;
  const first = productionTelegramDelivery(
    async () => ({ id: "accepted-session" }),
    {
      completedUpdatesFile,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(await first(privateUpdate(501, "first")), true);

  handlerCalls = 0;
  const afterReload = productionTelegramDelivery(
    async () => {
      throw new Error("duplicate must not send");
    },
    {
      completedUpdatesFile,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(await afterReload(privateUpdate(501, "duplicate")), "handled");
  assert.equal(handlerCalls, 0);
  assert.deepEqual(JSON.parse(readFileSync(completedUpdatesFile, "utf8")), {
    botId: "999",
    updates: [501],
  });

  const unauthorized = productionTelegramDelivery(
    async () => {
      throw new Error("unauthorized duplicate must not send");
    },
    {
      completedUpdatesFile,
      webhookSecretHeader: "wrong-secret",
      webhookVerifier: async (request): Promise<boolean> =>
        request.headers.get("x-telegram-bot-api-secret-token") ===
        WEBHOOK_SECRET,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(
    await unauthorized(privateUpdate(501, "unauthorized duplicate")),
    false,
  );
  assert.equal(handlerCalls, 0);
});

test("an update is recorded only after successful acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-completed-ledger-reject-test-"));
  const completedUpdatesFile = join(root, "completed-updates.json");
  let handlerCalls = 0;
  const rejected = productionTelegramDelivery(
    async () => {
      throw new Error("injected rejection");
    },
    {
      completedUpdatesFile,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(await rejected(privateUpdate(601, "retry me")), false);

  const accepted = productionTelegramDelivery(
    async () => ({ id: "accepted-session" }),
    {
      completedUpdatesFile,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(await accepted(privateUpdate(601, "retry me")), true);
  assert.equal(handlerCalls, 2);
  assert.deepEqual(JSON.parse(readFileSync(completedUpdatesFile, "utf8")), {
    botId: "999",
    updates: [601],
  });
});

test("the completed-update ledger keeps the latest 200 ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-completed-ledger-bound-test-"));
  const completedUpdatesFile = join(root, "completed-updates.json");
  writeFileSync(
    completedUpdatesFile,
    JSON.stringify({
      botId: "999",
      updates: Array.from({ length: 200 }, (_, id) => id),
    }),
  );
  const delivery = productionTelegramDelivery(
    async () => ({ id: "accepted-session" }),
    { completedUpdatesFile },
  );

  assert.equal(await delivery(privateUpdate(999, "newest")), true);
  const completed: unknown = JSON.parse(
    readFileSync(completedUpdatesFile, "utf8"),
  );
  assert.ok(isCompletedLedger(completed));
  assert.equal(completed.botId, "999");
  assert.equal(completed.updates.length, 200);
  assert.equal(completed.updates.includes(0), false);
  assert.equal(completed.updates.includes(999), true);
});

test("a completed-update ledger is isolated by Telegram bot id", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-completed-ledger-bot-test-"));
  const completedUpdatesFile = join(root, "completed-updates.json");
  let sends = 0;
  const delivery = productionTelegramDelivery(
    async () => ({ id: `accepted-${++sends}` }),
    { completedUpdatesFile },
  );
  const priorToken = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.TELEGRAM_BOT_TOKEN = fakeBotToken(111, "first-bot");
    assert.equal(await delivery(privateUpdate(701, "first bot")), true);
    process.env.TELEGRAM_BOT_TOKEN = fakeBotToken(222, "second-bot");
    assert.equal(await delivery(privateUpdate(701, "second bot")), true);
    assert.equal(
      await delivery(privateUpdate(701, "second bot duplicate")),
      "handled",
    );
    assert.equal(sends, 2);
    assert.deepEqual(JSON.parse(readFileSync(completedUpdatesFile, "utf8")), {
      botId: "222",
      updates: [701],
    });
  } finally {
    if (priorToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = priorToken;
  }
});

test("an invalid completed-update schema is recovered after acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-completed-ledger-schema-test-"));
  const completedUpdatesFile = join(root, "completed-updates.json");
  writeFileSync(completedUpdatesFile, JSON.stringify({ updates: "broken" }));
  let sends = 0;
  const delivery = productionTelegramDelivery(
    async () => ({ id: `accepted-${++sends}` }),
    { completedUpdatesFile },
  );

  assert.equal(await delivery(privateUpdate(801, "recover")), true);
  assert.equal(await delivery(privateUpdate(801, "duplicate")), "handled");
  assert.equal(sends, 1);
  assert.deepEqual(JSON.parse(readFileSync(completedUpdatesFile, "utf8")), {
    botId: "999",
    updates: [801],
  });
});

test("missing webhook secret disables deduplication and reports it once", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-completed-ledger-secret-test-"));
  const completedUpdatesFile = join(root, "completed-updates.json");
  const priorSecret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  const priorError = console.error;
  const logs: string[] = [];
  let sends = 0;
  delete process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  console.error = (...parts: unknown[]) =>
    logs.push(parts.map(String).join(" "));
  try {
    const delivery = productionTelegramDelivery(
      async () => ({ id: `accepted-${++sends}` }),
      { completedUpdatesFile },
    );
    assert.equal(await delivery(privateUpdate(901, "first")), true);
    assert.equal(await delivery(privateUpdate(901, "repeat")), true);
  } finally {
    console.error = priorError;
    process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = priorSecret;
  }
  assert.equal(sends, 2);
  assert.equal(
    logs.filter((line) => line.includes("durable deduplication")).length,
    1,
  );
});
