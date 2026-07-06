import { defineHook } from "eve/hooks";
import { appendUsage } from "../../scripts/lib/usage.mjs";

// Учёт фактического расхода токенов. ОДИН хук ловит весь расход одного eve-агента без
// двойного счёта: основной чат (channel.kind="telegram") и фоновые джобы через eve/client —
// daily-digest, memory rollup (kind="http"). Шаги субагента (planner) приходят завёрнутыми
// в "subagent.event" → слушаем оба события. Пишем по строке на шаг в data/usage.jsonl;
// читают мост (/usage) и CLI (`iva usage`).
//
// ВАЖНО: в отличие от transcript.ts НЕ фильтруем finishReason="tool-calls" — расход есть на
// КАЖДОМ шаге модели, включая tool-call раунды. Относительный импорт scripts/lib работает
// в бандле (см. transcript.ts).

const PROVIDER = process.env.MODEL_PROVIDER ?? "ollama";
// Модель/провайдер не приходят в событие — берём из env (та же логика, что в agent/agent.ts).
const MODEL =
  PROVIDER === "codex"
    ? (process.env.CODEX_MODEL ?? "gpt-5.5")
    : PROVIDER === "opencode"
      ? (process.env.OPENCODE_MODEL ?? "deepseek-v4-pro").replace(/^opencode-go\//, "")
      : (process.env.OLLAMA_MODEL ?? "deepseek-v4-pro");

interface StepData {
  stepIndex: number;
  turnId: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

function record(data: StepData, sessionId: string, source: string, subagent?: string): void {
  const u = data.usage;
  if (!u) return;
  const inT = u.inputTokens ?? 0;
  const outT = u.outputTokens ?? 0;
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  if (inT + outT + cacheRead + cacheWrite === 0) return; // нет usage — не пишем нулевую строку
  appendUsage({
    ts: new Date().toISOString(),
    source,
    provider: PROVIDER,
    model: MODEL,
    sessionId,
    turnId: data.turnId ?? "",
    step: data.stepIndex ?? 0,
    subagent, // undefined для top-level — JSON.stringify его опускает
    in: inT,
    out: outT,
    cacheRead,
    cacheWrite,
    total: inT + outT,
  });
}

export default defineHook({
  events: {
    "step.completed": (event, ctx) => {
      record(event.data, ctx.session.id, ctx.channel.kind ?? "unknown");
    },
    // Шаги инлайн-субагента (planner) — иначе его токены потерялись бы.
    "subagent.event": (event, ctx) => {
      const inner = event.data.event;
      if (inner.type === "step.completed") {
        record(inner.data, ctx.session.id, ctx.channel.kind ?? "unknown", event.data.subagentName);
      }
    },
  },
});
