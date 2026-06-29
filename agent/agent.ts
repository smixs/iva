import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
// Провайдер (Ollama Cloud / OpenCode Zen) и его модели — единый источник в provider.ts,
// тот же конфиг переиспользует agent/vision.ts (vision-модель того же провайдера).
import { providerConfig as cfg, providerName, withReasoningStripped } from "./provider.js";

const provider = createOpenAICompatible({
  name: `iva-${providerName}`,
  baseURL: cfg.baseURL,
  apiKey: cfg.apiKey,
  // Без этого стрим OpenAI-совместимых провайдеров НЕ несёт usage (нет stream_options:
  // {include_usage:true}) → событие step.completed приходит без поля usage, и учёт токенов
  // (agent/hooks/usage.ts) пуст. Включаем, чтобы провайдер отдавал расход в финальном чанке.
  includeUsage: true,
});

export default defineAgent({
  model: withReasoningStripped(provider(cfg.textModel)),
  // Кастомный провайдер не отдаёт метаданные окна через AI Gateway — задаём вручную.
  // ВАЖНО: значение ОБЯЗАНО быть ≤ реального окна модели, иначе запрос переполнит окно до компактации.
  modelContextWindowTokens: cfg.contextWindow,
  // Защита от overflow: компактуем заранее (0.7 вместо дефолтных 0.9), оставляя запас на
  // summary-вызов и следующий ход. eve сам саммаризирует старые ходы, сохраняя todo и read-tracking.
  compaction: { thresholdPercent: 0.7 },
});
