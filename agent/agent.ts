import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
// Провайдер и его модели — единый источник в provider.ts (тот же конфиг у agent/vision.ts).
// codex = подписка ChatGPT (Responses API + OAuth); ollama/opencode = OpenAI-совместимый chat.
import { providerConfig as cfg, providerName, withReasoningStripped, makeCodexModel } from "./provider.js";

// Codex-подписка говорит на Responses API — отдельная модель-фабрика (@ai-sdk/openai).
// Остальные провайдеры — OpenAI-совместимый chat/completions через openai-compatible.
const textModel =
  providerName === "codex"
    ? makeCodexModel()
    : createOpenAICompatible({
        name: `iva-${providerName}`,
        baseURL: cfg.baseURL,
        apiKey: cfg.apiKey,
        // Без этого стрим OpenAI-совместимых провайдеров НЕ несёт usage (нет stream_options:
        // {include_usage:true}) → событие step.completed приходит без поля usage, и учёт токенов
        // (agent/hooks/usage.ts) пуст. Включаем, чтобы провайдер отдавал расход в финальном чанке.
        includeUsage: true,
      })(cfg.textModel);

export default defineAgent({
  model: withReasoningStripped(textModel),
  // Кастомный провайдер не отдаёт метаданные окна через AI Gateway — задаём вручную.
  // ВАЖНО: значение ОБЯЗАНО быть ≤ реального окна модели, иначе запрос переполнит окно до компактации.
  modelContextWindowTokens: cfg.contextWindow,
  // Защита от overflow: компактуем заранее (0.7 вместо дефолтных 0.9), оставляя запас на
  // summary-вызов и следующий ход. eve сам саммаризирует старые ходы, сохраняя todo и read-tracking.
  compaction: { thresholdPercent: 0.7 },
});
