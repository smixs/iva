import test from "node:test";
import assert from "node:assert/strict";
import { mediaFromRaw, messageParts } from "./telegram-parts.ts";

test("mediaFromRaw selects the largest Telegram photo size", () => {
  assert.deepEqual(
    mediaFromRaw({
      photo: [{ file_id: "small" }, { file_id: "large" }],
    }),
    { fileId: "large", tag: "photo", transcribe: false },
  );
});

test("mediaFromRaw preserves file metadata and transcription policy", () => {
  assert.deepEqual(
    mediaFromRaw({
      voice: {
        file_id: "voice-id",
        mime_type: "audio/ogg",
        file_name: "note.ogg",
      },
    }),
    {
      fileId: "voice-id",
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
