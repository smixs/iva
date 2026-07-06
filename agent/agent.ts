import { defineAgent } from "eve";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { providerConfig as cfg, providerName, withReasoningStripped, makeCodexModel } from "./provider.js";

const compatibleProvider =
  providerName === "codex"
    ? null
    : createOpenAICompatible({
        name: `iva-${providerName}`,
        baseURL: cfg.baseURL,
        apiKey: cfg.apiKey,
        includeUsage: true,
      });

type CompatibleProvider = NonNullable<typeof compatibleProvider>;
type CompatibleLanguageModel = ReturnType<CompatibleProvider>;

const LADDER_ENV: Record<string, string> = {
  ollama: "OLLAMA_MODEL_LADDER",
  opencode: "OPENCODE_MODEL_LADDER",
  openrouter: "OPENROUTER_MODEL_LADDER",
};

function normalizeModelId(modelId: string) {
  return providerName === "opencode" ? modelId.replace(/^opencode-go\//, "") : modelId;
}

function uniqueModels(primary: string, ladder?: string) {
  const seen = new Set<string>();
  return [primary, ...(ladder ?? "").split(/[,\s]+/)]
    .map((model) => normalizeModelId(model.trim()))
    .filter((model) => {
      if (!model || seen.has(model)) return false;
      seen.add(model);
      return true;
    });
}

function errorText(error: unknown) {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const detail = "detail" in error && typeof error.detail === "string" ? error.detail : "";
    const cause = error.cause instanceof Error ? `${error.cause.name}: ${error.cause.message}` : "";
    return [error.name, error.message, detail, cause].filter(Boolean).join("\n");
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function shouldFallback(error: unknown) {
  const text = errorText(error);
  if (!text) return false;
  if (/(401|403|unauthorized|forbidden|invalid api key|authentication)/i.test(text)) return false;
  if (/(400|bad request|context length|maximum context|invalid request)/i.test(text)) return false;

  return /(429|rate limit|capacity|overloaded|temporar|timeout|fetch failed|network|ECONNRESET|ETIMEDOUT|5\d\d|bad gateway|internal server error|service unavailable)/i.test(
    text,
  );
}

function modelIdOf(model: CompatibleLanguageModel) {
  return "modelId" in model && typeof model.modelId === "string" ? model.modelId : "unknown";
}

function fallbackMiddleware(models: CompatibleLanguageModel[]): LanguageModelMiddleware {
  async function run<T>(kind: "generate" | "stream", call: (model: CompatibleLanguageModel) => PromiseLike<T>) {
    let lastError: unknown;

    for (const [index, model] of models.entries()) {
      try {
        return await call(model);
      } catch (error) {
        lastError = error;
        const next = models[index + 1];
        if (!next || !shouldFallback(error)) throw error;

        console.warn(
          `[iva:model-fallback] ${kind} ${modelIdOf(model)} failed; trying ${modelIdOf(next)}: ${errorText(error)
            .split("\n")
            .slice(0, 2)
            .join(" | ")}`,
        );
      }
    }

    throw lastError;
  }

  return {
    wrapGenerate: ({ params }) => run("generate", (model) => model.doGenerate(params)),
    wrapStream: ({ params }) => run("stream", (model) => model.doStream(params)),
  };
}

function makeCompatibleModel(provider: CompatibleProvider) {
  const ladderKey = LADDER_ENV[providerName];
  const modelIds = uniqueModels(cfg.textModel, ladderKey ? process.env[ladderKey] : undefined);
  const models = modelIds.map((modelId) => provider(modelId));

  if (modelIds.length > 1) {
    console.info(`[iva:model] ladder=${modelIds.join(" -> ")}`);
    return wrapLanguageModel({ model: models[0]!, middleware: fallbackMiddleware(models) });
  }

  return models[0]!;
}

const textModel = providerName === "codex" ? makeCodexModel() : makeCompatibleModel(compatibleProvider!);

export default defineAgent({
  model: withReasoningStripped(textModel),
  // Кастомный провайдер не отдаёт метаданные окна через AI Gateway — задаём вручную.
  // ВАЖНО: значение ОБЯЗАНО быть ≤ реального окна модели, иначе запрос переполнит окно до компактации.
  modelContextWindowTokens: cfg.contextWindow,
  // Защита от overflow: компактуем заранее (0.7 вместо дефолтных 0.9), оставляя запас на
  // summary-вызов и следующий ход. eve сам саммаризирует старые ходы, сохраняя todo и read-tracking.
  compaction: { thresholdPercent: 0.7 },
});
