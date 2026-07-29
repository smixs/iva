import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const HARNESS = join(ROOT, "scripts/fixtures/telegram-poll-queue-harness.mjs");

function makeDataDir(t, label) {
  const path = mkdtempSync(join(tmpdir(), `iva-008-${label}-`));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function runHarness(mode, dataDir, fault = "none", { collectQuietMs = "0" } = {}) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", HARNESS, mode, dataDir, fault],
    {
      cwd: ROOT,
      env: { ...process.env, TELEGRAM_COLLECT_QUIET_MS: collectQuietMs },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `harness failed (${mode}/${fault})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return JSON.parse(readFileSync(join(dataDir, "queue-harness-result.json"), "utf8"));
}

for (const fault of ["write", "rename"]) {
  test(`busy queue ${fault} failure does not advance Telegram offset`, (t) => {
    const dataDir = makeDataDir(t, `disk-${fault}`);
    const result = runHarness("disk-failure", dataDir, fault);

    assert.equal(
      result.offset.offset,
      100,
      "the same Telegram update must be retried until its FIFO item is durable",
    );
    assert.deepEqual(result.deliveries, []);
  });
}

test("directory sync failure requires a durable duplicate retry before offset advances", (t) => {
  const dataDir = makeDataDir(t, "dir-sync-retry");
  const result = runHarness("dir-sync-retry", dataDir, "dir-sync-once");

  assert.deepEqual(
    result.requestedOffsets,
    [100, 100, 102],
    "the update must be requested again before its offset is committed",
  );
  assert.equal(result.queueDirSyncAttempts, 2);
  assert.equal(
    result.queueDirSyncSuccesses,
    1,
    "the duplicate retry must repeat the atomic write through a successful parent-dir fsync",
  );
  assert.equal(result.offset.offset, 102);
  assert.equal(result.queue.queues["1:"].length, 1);
  assert.equal(result.queue.queues["1:"][0].updateId, 101);
});

test("queued follow-ups auto-drain in FIFO order when the current turn becomes idle", (t) => {
  const dataDir = makeDataDir(t, "auto-drain");
  const result = runHarness("auto-drain", dataDir);

  assert.deepEqual(
    result.deliveries.map((update) => [update.update_id, update.message?.text]),
    [
      [101, "first"],
      [102, "second"],
    ],
  );
  assert.deepEqual(result.deliveryRoutes, [
    "/eve/v1/telegram/accepted",
    "/eve/v1/telegram/accepted",
  ]);
  assert.deepEqual(
    result.queue,
    { version: 1, queues: {} },
    "accepted FIFO items must be removed only after Eve accepts them",
  );
  assert.deepEqual(
    result.queueStatuses.map((status) => status.text),
    [
      "Queued (1). I'll start it automatically when the current task finishes.",
      "Queued (2). I'll start it automatically when the current task finishes.",
    ],
  );
});

test("collector merges a two-text burst into one durable queue item and delivery", (t) => {
  const dataDir = makeDataDir(t, "collect-burst");
  const result = runHarness("collect-burst", dataDir, "none", { collectQuietMs: "75" });

  assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0].update_id, 102);
  assert.deepEqual(
    result.deliveries[0].message.iva_parts.map((part) => [part.message_id, part.text]),
    [
      [101, "first"],
      [102, "second"],
    ],
  );
  assert.deepEqual(result.deliveryRoutes, ["/eve/v1/telegram/accepted"]);
  assert.equal(result.reactions.length, 1);
  assert.deepEqual(
    result.queueStatuses.map((status) => status.text),
    ["Queued (1). I'll start it automatically when the current task finishes."],
  );
  assert.deepEqual(result.queue, { version: 1, queues: {} });
});

test("a restarted bridge recovers and drains the persisted FIFO without a third user message", (t) => {
  const dataDir = makeDataDir(t, "restart");
  const beforeRestart = runHarness("restart-persist", dataDir);
  assert.equal(
    Object.values(beforeRestart.queue.queues).flat().length,
    2,
    "the first process must leave both busy-time follow-ups durable",
  );

  const afterRestart = runHarness("restart-drain", dataDir);
  assert.deepEqual(
    afterRestart.deliveries.map((update) => [update.update_id, update.message?.text]),
    [
      [101, "first"],
      [102, "second"],
    ],
  );
  assert.deepEqual(afterRestart.queue, { version: 1, queues: {} });
});

test("a persistently failing queue head does not block other chats or Telegram polling", (t) => {
  const dataDir = makeDataDir(t, "fair-drain");
  const result = runHarness("fair-drain", dataDir);

  assert.deepEqual(
    result.deliveries.map((update) => [update.message.chat.id, update.update_id]),
    [
      [1, 101],
      [2, 102],
    ],
    "one failed acceptance attempt must yield to the next chat key",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(result.queue.queues).map(([key, items]) => [
        key,
        items.map((item) => item.updateId),
      ]),
    ),
    { "1:": [101] },
    "the poison head stays durable while an accepted head is acknowledged",
  );
  assert.deepEqual(
    result.requestedOffsets,
    [100],
    "the bridge must return to getUpdates after a bounded drain pass",
  );
});

test("unaddressed group noise is excluded from a busy conversation FIFO", (t) => {
  const dataDir = makeDataDir(t, "group-noise");
  const result = runHarness("group-noise", dataDir);

  assert.equal(result.queue.queues?.["-100:"], undefined);
  assert.deepEqual(result.deliveries, []);
  assert.deepEqual(result.reactions, []);
  assert.equal(result.offset.offset, 103, "ignored group noise is consumed exactly once");
});

test("busy FIFO routes private, group and forum-topic updates without absorbing group noise", (t) => {
  const dataDir = makeDataDir(t, "routing");
  const result = runHarness("routing", dataDir);
  const queues = result.queue.queues;

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(queues).map(([key, items]) => [
        key,
        items.map((item) => [item.version, item.updateId, item.update.message?.text]),
      ]),
    ),
    {
      "1:": [[1, 101, "private follow-up"]],
      "-100:": [[1, 103, "@my_bot group follow-up"]],
      "-100:7": [[1, 104, "/task topic follow-up"]],
    },
  );
  assert.equal(queues["-100:7"][0].update.message.message_thread_id, 7);
  assert.equal(result.offset.offset, 105);
  assert.equal(result.reactions.length, 3);
  assert.equal(result.queueStatuses.length, 3);
});
