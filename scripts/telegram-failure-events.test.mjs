import "./lib/ts-esm-hooks.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "iva-telegram-failures-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_ALLOWED_USER_IDS = "9";
process.env.TELEGRAM_BOT_TOKEN = "failure-test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "failure-test-secret";

const apiCalls = [];
let heldSend;
globalThis.fetch = async (url, init = {}) => {
  const method = new URL(String(url)).pathname.split("/").at(-1);
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  apiCalls.push({ method, body });
  const hold = heldSend;
  if (method === "sendMessage" && hold?.chatId === String(body?.chat_id)) {
    hold.startedResolve();
    await hold.release;
    if (heldSend === hold) heldSend = undefined;
  }
  return Response.json({
    ok: true,
    result: {
      message_id: 1000 + apiCalls.length,
      chat: { id: body?.chat_id ?? 7, type: "private" },
    },
  });
};

const [
  { default: channel },
  { chatKeyOf, getChatStatus, setChatStatus },
  { ContextContainer, contextStorage },
  { SessionKey },
] = await Promise.all([
  import("../agent/channels/telegram.ts?failure-events-test"),
  import("./lib/run-status.mjs"),
  import("../node_modules/eve/dist/src/context/container.js"),
  import("../node_modules/eve/dist/src/context/keys.js"),
]);

const adapter = channel.adapter;

after(() => rmSync(dataDir, { recursive: true, force: true }));

function eventContext({
  chatId,
  sessionId,
  continuationToken = `telegram:${chatId}::`,
}) {
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId,
    turn: { id: "turn_0", sequence: 0 },
  });
  const session = {
    continuationToken,
    setContinuationToken(token) {
      this.continuationToken = token;
    },
  };
  const state = {
    ...adapter.state,
    chatId: String(chatId),
    chatType: "private",
    messageThreadId: null,
  };
  return {
    ctx,
    value: adapter.createAdapterContext({ ctx, session, state }),
  };
}

async function emitTurnFailed(data, options) {
  const context = eventContext(options);
  await contextStorage.run(context.ctx, () =>
    adapter["turn.failed"](data, context.value));
}

async function emitSessionFailed(data, options) {
  const context = eventContext(options);
  await adapter["session.failed"](data, context.value);
}

function callsSince(index, method) {
  return apiCalls.slice(index).filter((call) => call.method === method);
}

function holdSend(chatId) {
  let startedResolve;
  let releaseResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const release = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  heldSend = {
    chatId: String(chatId),
    release,
    startedResolve,
  };
  return { release: releaseResolve, started };
}

test("turn.failed posts a humanized error with error id even when finishStatus CAS misses", async () => {
  const chatId = "701";
  const sessionId = "failed-session-cas-miss";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId: "newer-session",
    turnId: "turn_newer",
  });
  const before = apiCalls.length;
  const turnData = {
    code: "MODEL_CALL_FAILED",
    details: {
      errorId: "err-limit-701",
      statusCode: 429,
      upstreamMessage: "5-hour usage limit reached. Resets in 3hr 59min.",
    },
    message: "Request rejected",
    sequence: 0,
    turnId: "turn_0",
  };

  await emitTurnFailed(turnData, { chatId, sessionId });

  const sends = callsSince(before, "sendMessage");
  assert.equal(sends.length, 1);
  assert.equal(
    sends[0].body.text,
    "Provider limit exhausted - resets in 3hr 59min; wait or switch models: /model\n\nError id: err-limit-701",
  );
  assert.equal(getChatStatus(key).sessionId, "newer-session");

  await emitSessionFailed(
    {
      code: turnData.code,
      details: turnData.details,
      message: turnData.message,
      sessionId,
    },
    { chatId, sessionId },
  );

  assert.equal(callsSince(before, "sendMessage").length, 1);
});

test("session.failed clears its run-status and deduplicates repeated delivery", async () => {
  const chatId = "702";
  const sessionId = "terminal-session-cleanup";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId,
    turnId: "turn_0",
    statusMessageId: 55,
  });
  const before = apiCalls.length;
  const data = {
    code: "MODEL_CALL_FAILED",
    details: { errorId: "err-billing-702", statusCode: 402 },
    message: "Request rejected",
    sessionId,
  };

  await emitSessionFailed(data, { chatId, sessionId });

  const status = getChatStatus(key);
  assert.equal(status.status, "idle");
  assert.equal(status.sessionId, undefined);
  assert.equal(status.turnId, undefined);
  assert.equal(callsSince(before, "deleteMessage").length, 1);
  assert.equal(callsSince(before, "deleteMessage")[0].body.message_id, 55);
  assert.equal(callsSince(before, "sendMessage").length, 1);
  assert.equal(
    callsSince(before, "sendMessage")[0].body.text,
    "Provider balance/plan exhausted - top up or switch models: /model\n\nError id: err-billing-702",
  );

  await emitSessionFailed(data, { chatId, sessionId });
  assert.equal(callsSince(before, "sendMessage").length, 1);
});

test("turn.failed claims notification before an overlapping session.failed can post", async () => {
  const chatId = "703";
  const sessionId = "terminal-session-overlap";
  const key = chatKeyOf(chatId);
  setChatStatus(key, {
    status: "running",
    sessionId,
    turnId: "turn_0",
  });
  const before = apiCalls.length;
  const details = { errorId: "err-upstream-703" };
  const hold = holdSend(chatId);
  const turn = emitTurnFailed(
    {
      code: "MODEL_CALL_FAILED",
      details,
      message: "Upstream request failed",
      sequence: 0,
      turnId: "turn_0",
    },
    { chatId, sessionId },
  );
  await hold.started;

  await emitSessionFailed(
    {
      code: "MODEL_CALL_FAILED",
      details,
      message: "Upstream request failed",
      sessionId,
    },
    { chatId, sessionId },
  );

  assert.equal(callsSince(before, "sendMessage").length, 1);
  hold.release();
  await turn;
  assert.equal(callsSince(before, "sendMessage").length, 1);
});
