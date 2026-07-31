// Mock OpenAI-совместимый провайдер для replica-смоука (scripts/replica-smoke.mjs).
// Поднимает локальный http-сервер с единственным эндпоинтом POST /v1/chat/completions
// и отвечает по сценарию, завязанному на текст последнего user-сообщения, — так смоук
// проверяет полный путь build → eve → провайдер без сети и настоящей модели.
// Идея — reference-реализация из stabilization-форка mamysh/iva (PR #7), переписана
// под upstream с нуля.
import { createServer } from "node:http";

const MODEL = "iva-replica";

function partText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p?.text ?? ""))
      .join(" ");
  }
  return "";
}

function transcriptText(messages) {
  return messages.map((m) => partText(m?.content)).join("\n");
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return partText(messages[i].content);
  }
  return "";
}

// Сценарий: маркер CEDAR-#### сеется фразой "Remember this code", а после рестарта
// eve должен реплеить историю целиком — тогда маркер найдётся в транскрипте и вернётся
// в ответе. Так restart/resume проверяется без настоящей памяти модели.
function chooseResponse(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = lastUserText(messages);
  if (/What code did I ask you to remember/i.test(last)) {
    const match = transcriptText(messages).match(/CEDAR-\d+/);
    return match ? match[0] : "MISSING_MARKER";
  }
  if (/Remember this code/i.test(last)) return "REMEMBERED";
  return "REPLICA_OK";
}

function completionJson(text) {
  return {
    id: "chatcmpl-replica",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  };
}

function streamChunks(text) {
  const base = { id: "chatcmpl-replica", object: "chat.completion.chunk", created: 1, model: MODEL };
  return [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { ...base, choices: [], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } },
  ];
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Стартует mock-провайдер на 127.0.0.1:0; handle: { baseUrl, requests, close }. */
export async function startMockOpenAiServer() {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${req.url}` } }));
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
      return;
    }
    requests.push(body);
    const text = chooseResponse(body);
    if (body?.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const chunk of streamChunks(text)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completionJson(text)));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
