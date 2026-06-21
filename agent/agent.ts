import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// Model provider is chosen at setup (MODEL_PROVIDER): Ollama Cloud or OpenCode Zen.
// Both are OpenAI-compatible; the key comes from .env. Both work behind any network.
const PROVIDER = process.env.MODEL_PROVIDER ?? "ollama";

const PROVIDERS = {
  ollama: {
    baseURL: "https://ollama.com/v1",
    apiKey: process.env.OLLAMA_API_KEY,
    model: process.env.OLLAMA_MODEL ?? "deepseek-v4-pro",
    window: Number(process.env.OLLAMA_CONTEXT_WINDOW ?? 131072),
  },
  opencode: {
    baseURL: "https://opencode.ai/zen/go/v1",
    apiKey: process.env.OPENCODE_API_KEY,
    model: process.env.OPENCODE_MODEL ?? "opencode-go/deepseek-v4-pro",
    window: Number(process.env.OPENCODE_CONTEXT_WINDOW ?? 131072),
  },
} as const;

const cfg = PROVIDERS[PROVIDER as keyof typeof PROVIDERS] ?? PROVIDERS.ollama;

const provider = createOpenAICompatible({
  name: `iva-${PROVIDER}`,
  baseURL: cfg.baseURL,
  apiKey: cfg.apiKey,
});

export default defineAgent({
  model: provider(cfg.model),
  // Кастомный провайдер не отдаёт метаданные окна через AI Gateway — задаём вручную.
  // ВАЖНО: значение ОБЯЗАНО быть ≤ реального окна модели, иначе запрос переполнит окно до компактации.
  modelContextWindowTokens: cfg.window,
  // Защита от overflow: компактуем заранее (0.7 вместо дефолтных 0.9), оставляя запас на
  // summary-вызов и следующий ход. eve сам саммаризирует старые ходы, сохраняя todo и read-tracking.
  compaction: { thresholdPercent: 0.7 },
});
