/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import test from "node:test";
import assert from "node:assert/strict";
import { mediaFromRaw, messageParts } from "./telegram-parts.ts";

test("mediaFromRaw selects the largest Telegram photo size", () => {
  assert.deepEqual(
    mediaFromRaw({
      photo: [
        { file_id: "small", file_unique_id: "small-photo" },
        { file_id: "large", file_unique_id: "large-photo" },
      ],
    }),
    {
      fileId: "large",
      fileUniqueId: "large-photo",
      tag: "photo",
      transcribe: false,
    },
  );
});

test("mediaFromRaw preserves file metadata and transcription policy", () => {
  assert.deepEqual(
    mediaFromRaw({
      voice: {
        file_id: "voice-id",
        file_unique_id: "unique-voice",
        mime_type: "audio/ogg",
        file_name: "note.ogg",
      },
    }),
    {
      fileId: "voice-id",
      fileUniqueId: "unique-voice",
      tag: "voice",
      transcribe: true,
      mimeType: "audio/ogg",
      fileName: "note.ogg",
    },
  );
  assert.equal(mediaFromRaw({ text: "plain" }), null);
});

test("messageParts keeps a solitary raw message untouched", () => {
  const raw = { message_id: 1, text: "one" };
  const parts = messageParts(raw);

  assert.deepEqual(parts, [raw]);
  assert.equal(parts[0], raw);
});

test("messageParts returns the synthetic collector parts in order", () => {
  const first = { message_id: 1, text: "first" };
  const second = { message_id: 2, text: "second" };

  assert.deepEqual(messageParts({ ...first, iva_parts: [first, second] }), [
    first,
    second,
  ]);
});

test("messageParts drops malformed synthetic collector entries", () => {
  const valid = { message_id: 1, text: "valid" };

  assert.deepEqual(
    messageParts({
      iva_parts: [null, "text", 42, [], valid],
    }),
    [valid],
  );
});

test("messageParts falls back to the outer raw when iva_parts is empty", () => {
  const raw = { message_id: 1, text: "outer", iva_parts: [] };
  const parts = messageParts(raw);

  assert.deepEqual(parts, [raw]);
  assert.equal(parts[0], raw);
});

test("messageParts falls back to the outer raw when iva_parts is junk-only", () => {
  const raw = {
    message_id: 1,
    text: "outer kept",
    iva_parts: [null, "text", 42, []],
  };
  const parts = messageParts(raw);

  assert.deepEqual(parts, [raw]);
  assert.equal(parts[0], raw);
});
