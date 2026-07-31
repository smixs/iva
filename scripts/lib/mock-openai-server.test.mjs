import { test } from "node:test";
import assert from "node:assert/strict";
import { startMockOpenAiServer } from "./mock-openai-server.mjs";

async function complete(baseUrl, body) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

test("non-streamed completion answers REPLICA_OK by default", async () => {
  const mock = await startMockOpenAiServer();
  try {
    const res = await complete(mock.baseUrl, {
      model: "iva-replica",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].message.content, "REPLICA_OK");
    assert.equal(mock.requests.length, 1);
  } finally {
    await mock.close();
  }
});

test("streamed completion emits SSE chunks and [DONE]", async () => {
  const mock = await startMockOpenAiServer();
  try {
    const res = await complete(mock.baseUrl, {
      model: "iva-replica",
      stream: true,
      messages: [{ role: "user", content: "Remember this code: CEDAR-4729" }],
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"content":"REMEMBERED"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await mock.close();
  }
});

test("marker is echoed back from the replayed transcript", async () => {
  const mock = await startMockOpenAiServer();
  try {
    const res = await complete(mock.baseUrl, {
      model: "iva-replica",
      messages: [
        { role: "user", content: "Remember this code: CEDAR-4729" },
        { role: "assistant", content: "REMEMBERED" },
        { role: "user", content: [{ type: "text", text: "What code did I ask you to remember?" }] },
      ],
    });
    const json = await res.json();
    assert.equal(json.choices[0].message.content, "CEDAR-4729");
  } finally {
    await mock.close();
  }
});

test("unknown routes return 404", async () => {
  const mock = await startMockOpenAiServer();
  try {
    const res = await fetch(`${mock.baseUrl}/models`);
    assert.equal(res.status, 404);
  } finally {
    await mock.close();
  }
});
