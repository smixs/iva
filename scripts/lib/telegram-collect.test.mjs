import test from "node:test";
import assert from "node:assert/strict";
import {
  collectorKeyFor,
  collectorOffer,
  collectorPending,
  collectorRestore,
  collectorTakeExpired,
  createCollector,
} from "./telegram-collect.mjs";

function update(updateId, text, options = {}) {
  const {
    chatId = 1,
    threadId,
    fromId = 42,
    mediaGroupId,
  } = options;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" },
      from: { id: fromId, is_bot: false },
      text,
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      ...(mediaGroupId === undefined ? {} : { media_group_id: mediaGroupId }),
    },
  };
}

test("a solitary part flushes as the original update verbatim", () => {
  const collector = createCollector();
  const original = update(1, "one");

  assert.deepEqual(collectorOffer(collector, original, 100), { status: "buffered" });
  assert.deepEqual(collectorTakeExpired(collector, 899), []);
  const [flushed] = collectorTakeExpired(collector, 900);

  assert.equal(flushed, original);
  assert.equal(Object.hasOwn(flushed.message, "iva_parts"), false);
  assert.equal(collectorPending(collector), 0);
});

test("two text messages merge in message_id order with the maximum update_id", () => {
  const collector = createCollector();
  const laterMessage = update(10, "second");
  laterMessage.message.message_id = 20;
  const earlierMessage = update(11, "first");
  earlierMessage.message.message_id = 10;

  collectorOffer(collector, laterMessage, 0);
  collectorOffer(collector, earlierMessage, 100);
  const [flushed] = collectorTakeExpired(collector, 900);

  assert.equal(flushed.update_id, 11);
  assert.equal(flushed.message.message_id, 10);
  assert.deepEqual(
    flushed.message.iva_parts.map((part) => [part.message_id, part.text]),
    [[10, "first"], [20, "second"]],
  );
  assert.equal(Object.hasOwn(earlierMessage.message, "iva_parts"), false);
});

test("each offer resets the trailing quiet window", () => {
  const collector = createCollector();
  collectorOffer(collector, update(1, "first"), 0);
  assert.deepEqual(collectorTakeExpired(collector, 799), []);

  collectorOffer(collector, update(2, "second"), 799);
  assert.deepEqual(collectorTakeExpired(collector, 1598), []);
  assert.equal(collectorTakeExpired(collector, 1599).length, 1);
});

test("a last media-group part uses the longer quiet window", () => {
  const collector = createCollector();
  collectorOffer(collector, update(1, "caption", { mediaGroupId: "album" }), 0);

  assert.deepEqual(collectorTakeExpired(collector, 1499), []);
  assert.equal(collectorTakeExpired(collector, 1500).length, 1);
});

test("chat, topic and sender are all part of the collector key", () => {
  const collector = createCollector();
  const owner = update(1, "owner", { chatId: -100, threadId: 7, fromId: 42 });
  const guest = update(2, "guest", { chatId: -100, threadId: 7, fromId: 7 });

  assert.equal(collectorKeyFor(owner), "-100:7:42");
  collectorOffer(collector, owner, 0);
  collectorOffer(collector, guest, 10);
  const flushed = collectorTakeExpired(collector, 810);

  assert.equal(flushed.length, 2);
  assert.equal(flushed[0], owner);
  assert.equal(flushed[1], guest);
});

test("part, character and age caps force a ready update", () => {
  const byParts = createCollector({ maxParts: 2 });
  collectorOffer(byParts, update(1, "a"), 0);
  const partReady = collectorOffer(byParts, update(2, "b"), 1);
  assert.equal(partReady.status, "ready");
  assert.equal(partReady.update.message.iva_parts.length, 2);

  const byChars = createCollector({ maxChars: 3 });
  collectorOffer(byChars, update(3, "ab"), 0);
  assert.equal(collectorOffer(byChars, update(4, "c"), 1).status, "ready");

  const byAge = createCollector({ maxAgeMs: 10 });
  collectorOffer(byAge, update(5, "old"), 0);
  assert.equal(collectorOffer(byAge, update(6, "new"), 10).status, "ready");
});

test("an enqueue failure can restore the exact flushed update for immediate retry", () => {
  const collector = createCollector();
  collectorOffer(collector, update(1, "first"), 0);
  collectorOffer(collector, update(2, "second"), 1);
  const [flushed] = collectorTakeExpired(collector, 801);

  assert.equal(collectorRestore(collector, flushed), true);
  assert.equal(collectorPending(collector), 1);
  assert.equal(collectorTakeExpired(collector, 801)[0], flushed);
});

test("quietMs zero disables collection and returns the untouched update", () => {
  const collector = createCollector({ quietMs: 0 });
  const original = update(1, "now");

  assert.deepEqual(collectorOffer(collector, original, 0), {
    status: "passthrough",
    update: original,
  });
  assert.equal(collectorPending(collector), 0);
});
