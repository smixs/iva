import { test } from "node:test";
import assert from "node:assert/strict";

// telegram-poll.mjs reads env at import and guards its poll loop behind a direct-execution check,
// so importing it here is side-effect-free. A dummy token keeps the API base a harmless string.
process.env.TELEGRAM_BOT_TOKEN ??= "test:token";
const {
  readCappedStream,
  handleAwaitNonText,
  isStaleWizard,
  wizardActionAllowed,
  selectWizardModel,
  selectWizardEffort,
  runWizardRequest,
  resolveThinkCatalogLoad,
  reapStaleRuns,
  routeMessageUpdate,
  selectableWizardOptions,
  validateAndSaveWizard,
} = await import("./telegram-poll.mjs");

const enc = new TextEncoder();
function streamOf(...parts) {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(typeof p === "string" ? enc.encode(p) : p);
      controller.close();
    },
  });
}

// A recording double for handleAwaitNonText's I/O: captures call order, returns fixed content.
// deleteOk controls whether the (mocked) Telegram deletion is reported as successful.
function recorder(content = '{"installed":{}}', { deleteOk = true } = {}) {
  const calls = [];
  const io = {
    deleteSecret: async (_c, id) => { calls.push(["delete", id]); return deleteOk; },
    reply: async (_c, text) => { calls.push(["reply", text]); },
    download: async (fileId) => { calls.push(["download", fileId]); return content; },
    deliver: async (text) => { calls.push(["deliver", text]); },
  };
  return { calls, io, names: () => calls.map((c) => c[0]) };
}

const routedUpdate = {
  update_id: 10,
  message: {
    message_id: 10,
    date: 1,
    chat: { id: 1, type: "private" },
    from: { id: 42, is_bot: false },
    text: "hello",
  },
};

function routeDeps(overrides = {}) {
  return {
    chatKeyImpl: () => "1:",
    loadQueueImpl: async () => ({ version: 1, queues: {} }),
    runningImpl: () => false,
    inFlight: new Map(),
    queueCountImpl: () => 0,
    replyToBotImpl: () => false,
    shouldQueueImpl: () => true,
    enqueueImpl: async () => ({ count: 1 }),
    acknowledgeImpl: async () => {},
    deliverImpl: async () => true,
    logImpl: () => {},
    ...overrides,
  };
}

test("routeMessageUpdate enqueues and acknowledges one busy update", async () => {
  let enqueued = 0;
  let acknowledged = 0;
  let delivered = 0;
  const result = await routeMessageUpdate(routedUpdate, routeDeps({
    runningImpl: () => true,
    enqueueImpl: async (key, update) => {
      enqueued++;
      assert.equal(key, "1:");
      assert.equal(update, routedUpdate);
      return { count: 3 };
    },
    acknowledgeImpl: async (update, count) => {
      acknowledged++;
      assert.equal(update, routedUpdate);
      assert.equal(count, 3);
    },
    deliverImpl: async () => {
      delivered++;
      return true;
    },
  }));

  assert.equal(result, "queued");
  assert.equal(enqueued, 1);
  assert.equal(acknowledged, 1);
  assert.equal(delivered, 0);
});

test("routeMessageUpdate sends one idle update through paced delivery", async () => {
  let delivered = 0;
  const result = await routeMessageUpdate(routedUpdate, routeDeps({
    deliverImpl: async (update) => {
      delivered++;
      assert.equal(update, routedUpdate);
      return true;
    },
  }));

  assert.equal(result, "delivered");
  assert.equal(delivered, 1);
});

test("routeMessageUpdate reports enqueue failure without acknowledging", async () => {
  let acknowledged = 0;
  const result = await routeMessageUpdate(routedUpdate, routeDeps({
    runningImpl: () => true,
    enqueueImpl: async () => {
      throw new Error("disk full");
    },
    acknowledgeImpl: async () => {
      acknowledged++;
    },
  }));

  assert.equal(result, "enqueue-failed");
  assert.equal(acknowledged, 0);
});

const reaperNow = 2_000_000;
const staleStatus = {
  status: "running",
  generation: 7,
  updatedAt: reaperNow - 31_000,
  continuationToken: "telegram:1::",
  sessionId: "session-1",
  turnId: "turn-1",
  statusMessageId: 77,
};

function reaperDeps(statuses, overrides = {}) {
  return {
    listStatusesImpl: async () => statuses,
    setStatusIfImpl: () => ({ status: "idle" }),
    resetImpl: async () => {},
    sendImpl: async () => {},
    deleteMessageImpl: async () => {},
    now: () => reaperNow,
    inFlight: new Map(),
    staleMs: 30_000,
    trImpl: (_en, ru) => ru,
    logImpl: () => {},
    ...overrides,
  };
}

test("reapStaleRuns flips one stale run, resets Eve, notifies, and removes working status", async () => {
  const calls = [];
  const reaped = await reapStaleRuns(reaperDeps(
    [{ chatKey: "1:", status: staleStatus }],
    {
      setStatusIfImpl: (key, expected, patch) => {
        calls.push(["cas", key, expected, patch]);
        return { ...staleStatus, ...patch, generation: 8 };
      },
      resetImpl: async (key, token) => calls.push(["reset", key, token]),
      sendImpl: async (key, text) => calls.push(["send", key, text]),
      deleteMessageImpl: async (key, messageId) =>
        calls.push(["delete", key, messageId]),
    },
  ));

  assert.equal(reaped, 1);
  assert.deepEqual(calls[0].slice(0, 3), [
    "cas",
    "1:",
    { status: "running", generation: 7, updatedAt: reaperNow - 31_000 },
  ]);
  assert.equal(calls[0][3].status, "idle");
  assert.equal(calls[0][3].resetAt, reaperNow);
  assert.deepEqual(calls.slice(1), [
    ["reset", "1:", "telegram:1::"],
    ["send", "1:", "Предыдущий ход оборвался - повтори запрос или /new"],
    ["delete", "1:", 77],
  ]);
});

test("reapStaleRuns leaves a fresh running record untouched", async () => {
  let sideEffects = 0;
  const reaped = await reapStaleRuns(reaperDeps(
    [{
      chatKey: "1:",
      status: { ...staleStatus, updatedAt: reaperNow - 30_000 },
    }],
    {
      setStatusIfImpl: () => {
        sideEffects++;
        return { status: "idle" };
      },
    },
  ));

  assert.equal(reaped, 0);
  assert.equal(sideEffects, 0);
});

test("reapStaleRuns leaves non-running statuses untouched", async () => {
  let sideEffects = 0;
  const reaped = await reapStaleRuns(reaperDeps(
    [
      { chatKey: "1:", status: { ...staleStatus, status: "idle" } },
      { chatKey: "2:", status: { ...staleStatus, status: "failed" } },
    ],
    {
      setStatusIfImpl: () => {
        sideEffects++;
        return { status: "idle" };
      },
    },
  ));

  assert.equal(reaped, 0);
  assert.equal(sideEffects, 0);
});

test("reapStaleRuns stops after a CAS conflict", async () => {
  let reset = 0;
  let sent = 0;
  const reaped = await reapStaleRuns(reaperDeps(
    [{ chatKey: "1:", status: staleStatus }],
    {
      setStatusIfImpl: () => null,
      resetImpl: async () => reset++,
      sendImpl: async () => sent++,
    },
  ));

  assert.equal(reaped, 0);
  assert.equal(reset, 0);
  assert.equal(sent, 0);
});

test("reapStaleRuns skips chats while their queue head is mid-drain", async () => {
  let sideEffects = 0;
  const reaped = await reapStaleRuns(reaperDeps(
    [{ chatKey: "1:", status: staleStatus }],
    {
      inFlight: new Map([["1:", { state: "delivering" }]]),
      setStatusIfImpl: () => {
        sideEffects++;
        return { status: "idle" };
      },
    },
  ));

  assert.equal(reaped, 0);
  assert.equal(sideEffects, 0);
});

test("reapStaleRuns swallows and logs a notification failure", async () => {
  const logs = [];
  let deleted = 0;
  const reaped = await reapStaleRuns(reaperDeps(
    [{ chatKey: "1:", status: staleStatus }],
    {
      sendImpl: async () => {
        throw new Error("Telegram unavailable");
      },
      deleteMessageImpl: async () => deleted++,
      logImpl: (...args) => logs.push(args.join(" ")),
    },
  ));

  assert.equal(reaped, 1);
  assert.equal(deleted, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /stale run notification failed for 1:: Telegram unavailable/);
});

test("a fresh message is delivered after its stale status is reaped", async () => {
  let running = true;
  await reapStaleRuns(reaperDeps(
    [{ chatKey: "1:", status: staleStatus }],
    {
      setStatusIfImpl: () => {
        running = false;
        return { status: "idle" };
      },
    },
  ));

  const result = await routeMessageUpdate(routedUpdate, routeDeps({
    runningImpl: () => running,
  }));
  assert.equal(result, "delivered");
});

test("readCappedStream reads a small body under the cap", async () => {
  assert.equal(await readCappedStream(streamOf('{"installed":{}}'), 1024), '{"installed":{}}');
});

test("readCappedStream: oversized body with NO metadata → null (hard cap mid-stream)", async () => {
  const chunk = "x".repeat(1000);
  assert.equal(await readCappedStream(streamOf(chunk, chunk, chunk), 2048), null);
});

test("readCappedStream: exactly at the cap allowed, one over rejected; null body → null", async () => {
  assert.equal(await readCappedStream(streamOf("abcd"), 4), "abcd");
  assert.equal(await readCappedStream(streamOf("abcde"), 4), null);
  assert.equal(await readCappedStream(null, 1024), null);
});

test("file-capable secret: message is DELETED BEFORE the download, then content delivered", async () => {
  const r = recorder();
  const msg = { chat: { id: 1 }, message_id: 42, document: { file_id: "F", file_size: 100 } };
  const pending = { flow: "menu", awaitText: { secret: true, file: true, kind: "gwsjson" } };
  const consumed = await handleAwaitNonText(msg, pending, r.io);
  assert.equal(consumed, true); // consumed → handleControl won't deliver it to eve
  assert.deepEqual(r.names(), ["delete", "download", "deliver"]);
  assert.ok(r.names().indexOf("delete") < r.names().indexOf("download"), "delete must precede download");
});

test("failed deletion → the secret is NOT downloaded or delivered (still consumed)", async () => {
  const r = recorder('{"installed":{}}', { deleteOk: false });
  const msg = { chat: { id: 1 }, message_id: 42, document: { file_id: "F", file_size: 100 } };
  const pending = { flow: "menu", awaitText: { secret: true, file: true, kind: "gwsjson" } };
  const consumed = await handleAwaitNonText(msg, pending, r.io);
  assert.equal(consumed, true); // never reaches eve
  assert.deepEqual(r.names(), ["delete"]); // deletion failed → no download, no deliver
});

test("over-size document is deleted and never downloaded", async () => {
  const r = recorder();
  const msg = { chat: { id: 1 }, message_id: 9, document: { file_id: "F", file_size: 999_999 } };
  const pending = { flow: "menu", awaitText: { secret: true, file: true, kind: "gwsjson" } };
  await handleAwaitNonText(msg, pending, r.io);
  assert.deepEqual(r.names(), ["delete", "reply"]); // no download
});

test("secret prompt + non-file attachment (photo) → deleted with an ack, not delivered to eve", async () => {
  const r = recorder();
  const msg = { chat: { id: 1 }, message_id: 7 }; // no .document → a photo/sticker/etc
  const pending = { flow: "menu", awaitText: { secret: true, kind: "apikey" } };
  const consumed = await handleAwaitNonText(msg, pending, r.io);
  assert.equal(consumed, true);
  assert.deepEqual(r.names(), ["delete", "reply"]); // deleted + told how to send; never reaches eve
});

test("stale wizard callbacks are rejected by message and screen step", () => {
  const st = { msgId: 42, step: "models" };
  assert.equal(isStaleWizard(st, 41), true);
  assert.equal(isStaleWizard(st, 42), false);
  assert.equal(isStaleWizard(null, 42), true);
  assert.equal(wizardActionAllowed(st, "m:0"), true);
  assert.equal(wizardActionAllowed(st, "eff:high"), false);
  assert.equal(wizardActionAllowed(st, "unknown"), false);
  assert.equal(selectWizardModel({ modelOptions: [{ id: "safe", reasoningLevels: [] }] }, ""), null);
  assert.equal(selectWizardModel({ modelOptions: [{ id: "safe", reasoningLevels: [] }] }, "00"), null);
  assert.equal(selectWizardModel({ modelOptions: [{ id: "safe", reasoningLevels: [] }] }, "99"), null);
  assert.equal(wizardActionAllowed({ step: "model_error" }, "retry"), true);
  assert.equal(wizardActionAllowed({ step: "model_error" }, "back"), true);
});

test("model switch carries that model's levels; unknown effort never clears state", () => {
  const st = {
    model: "old",
    effort: "low",
    efforts: ["low"],
    modelOptions: [
      { id: "gpt-a", reasoningLevels: ["low", "medium"] },
      { id: "gpt-b", reasoningLevels: ["high", "max"] },
    ],
  };
  assert.deepEqual(selectWizardModel(st, "1"), st.modelOptions[1]);
  assert.equal(st.model, "gpt-b");
  assert.deepEqual(st.efforts, ["high", "max"]);
  assert.equal(selectWizardEffort(st, "bogus"), false);
  assert.equal(st.effort, "low");
  assert.equal(selectWizardEffort(st, "max"), true);
  assert.equal(st.effort, "max");
  assert.equal(selectWizardEffort(st, "unset"), true);
  assert.equal(st.effort, null);
});

test("stale current model stays display-only while a live current remains selectable", () => {
  const live = [
    { id: "new-a", reasoningLevels: ["low"] },
    { id: "current", reasoningLevels: ["high"] },
  ];
  assert.deepEqual(selectableWizardOptions(live, "retired").map((item) => item.id), [
    "new-a",
    "current",
  ]);
  assert.deepEqual(selectableWizardOptions(live, "current").map((item) => item.id), [
    "current",
    "new-a",
  ]);
});

test("Cancel during a rejected model fetch discards the stale error path", async () => {
  const st = { chatId: 1, userId: "2" };
  let active = st;
  let rejectFetch;
  const pending = runWizardRequest(
    st,
    () => new Promise((_resolve, reject) => { rejectFetch = reject; }),
    (candidate) => active === candidate,
  );

  active = null; // Cancel removed this object from the flow slot while fetch was pending.
  rejectFetch(Object.assign(new Error("key rejected"), { auth: true }));
  assert.deepEqual(await pending, { stale: true });
});

test("/think catalog failure keeps the wizard and routes to Retry/Back error state", async () => {
  const st = { step: "loading", removed: false };
  const failure = Object.assign(new Error("catalog offline"), {
    code: "catalog_unavailable",
  });

  const options = await resolveThinkCatalogLoad(
    st,
    { ok: false, error: failure },
    async (current, error) => {
      assert.equal(current, st);
      assert.equal(error, failure);
      current.step = "model_error";
      current.buttons = ["retry", "back"];
    },
  );

  assert.equal(options, null);
  assert.equal(st.removed, false);
  assert.equal(st.step, "model_error");
  assert.deepEqual(st.buttons, ["retry", "back"]);
});

test("catalog change before save preserves the old env", async () => {
  const writes = [];
  await assert.rejects(
    validateAndSaveWizard(
      {
        flow: "model",
        provider: "ollama",
        model: "retired",
        effort: "high",
        pendingKey: "new-secret",
      },
      {
        readEnv: async () => ({
          MODEL_PROVIDER: "codex",
          CODEX_MODEL: "old-model",
          OLLAMA_API_KEY: "old-secret",
        }),
        validate: async () => {
          throw Object.assign(new Error("retired"), { code: "model_unavailable" });
        },
        write: async (updates) => writes.push(updates),
      },
    ),
    /retired/,
  );
  assert.deepEqual(writes, []);
});

test("provider, model, effort and pending key persist in one atomic write", async () => {
  const validations = [];
  const writes = [];
  await validateAndSaveWizard(
    {
      flow: "model",
      provider: "opencode",
      model: "live-model",
      effort: "medium",
      pendingKey: "new-secret",
    },
    {
      readEnv: async () => ({ MODEL_PROVIDER: "ollama" }),
      validate: async (selection) => {
        validations.push(selection);
        return { id: selection.model, reasoningLevels: ["medium"] };
      },
      write: async (updates) => writes.push(updates),
    },
  );
  assert.equal(validations[0].key, "new-secret");
  assert.deepEqual(writes, [{
    THINKING_EFFORT: "medium",
    MODEL_PROVIDER: "opencode",
    OPENCODE_MODEL: "live-model",
    OPENCODE_API_KEY: "new-secret",
  }]);
});
