import { defineAgent } from "eve";
// Провайдер и его модели — единый источник в provider.ts (тот же конфиг у agent/vision.ts
// и agent/subagents/planner/agent.ts).
// codex = подписка ChatGPT (Responses API + OAuth); ollama/opencode = OpenAI-совместимый chat.
import {
  compatibleThinkingEffort,
  providerConfig as cfg,
  withReasoningStripped,
  makeTextModel,
} from "./provider.js";

export default defineAgent({
  model: withReasoningStripped(makeTextModel()),
  // eve maps this provider-agnostic setting to reasoning_effort for the
  // OpenAI-compatible Ollama Cloud and OpenCode Go endpoints.
  reasoning: compatibleThinkingEffort,
  // Кастомный провайдер не отдаёт метаданные окна через AI Gateway — задаём вручную.
  // ВАЖНО: значение ОБЯЗАНО быть ≤ реального окна модели, иначе запрос переполнит окно до компактации.
  modelContextWindowTokens: cfg.contextWindow,
  // Защита от overflow: компактуем заранее (0.7 вместо дефолтных 0.9), оставляя запас на
  // summary-вызов и следующий ход. eve сам саммаризирует старые ходы, сохраняя todo и read-tracking.
  compaction: { thresholdPercent: 0.7 },
  // Дефолт eve 0.28 автозавершает durable-сессии через 30 дней от создания (переживает
  // рестарты) — сломало бы долгоживущие Telegram/rollup-сессии у self-host юзеров.
  // У iva свой lifecycle сессий, отключаем автотаймаут явно.
  limits: { sessionTimeoutMs: false },
});
