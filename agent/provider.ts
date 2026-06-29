import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];

// Единый источник конфигурации провайдера модели (выбор раз при старте через MODEL_PROVIDER).
// Обе площадки OpenAI-совместимы; ключи — из .env. Здесь же зашита vision-модель ТОГО ЖЕ
// провайдера (один ключ, без доп-подписок) — её зовёт agent/vision.ts для распознавания картинок.
const PROVIDER = process.env.MODEL_PROVIDER ?? "ollama";

const PROVIDERS = {
  ollama: {
    baseURL: "https://ollama.com/v1",
    apiKey: process.env.OLLAMA_API_KEY,
    textModel: process.env.OLLAMA_MODEL ?? "deepseek-v4-pro",
    contextWindow: Number(process.env.OLLAMA_CONTEXT_WINDOW ?? 131072),
    // Дешёвая мультимодалка того же провайдера (проверено на проде: принимает image_url, http 200).
    visionModel: "gemma3:12b",
  },
  opencode: {
    baseURL: "https://opencode.ai/zen/go/v1",
    apiKey: process.env.OPENCODE_API_KEY,
    // Эндпоинт ждёт bare-ID — срезаем внутренний UI-префикс "opencode-go/" из дефолта и старых .env.
    textModel: (process.env.OPENCODE_MODEL ?? "deepseek-v4-pro").replace(/^opencode-go\//, ""),
    contextWindow: Number(process.env.OPENCODE_CONTEXT_WINDOW ?? 131072),
    visionModel: "gemini-3-flash",
  },
} as const;

export const providerName = PROVIDER;
export const providerConfig = PROVIDERS[PROVIDER as keyof typeof PROVIDERS] ?? PROVIDERS.ollama;

// --- Анти-InvalidPrompt: срезаем reasoning из вывода модели ---------------------------------
// deepseek (openai-compatible) иногда отдаёт reasoning-часть без поля `text`. eve хранит reasoning
// в истории и реплеит её каждый ход, а ai@7 ModelMessage-схема требует у reasoning непустой string
// `text` → одна такая часть бросает AI_InvalidPromptError в standardizePrompt и отравляет сессию
// навсегда (Iva молчит в треде до ручного сброса). reasoning в реплее не нужен — это приватное
// «мышление», юзеру не видно — поэтому выкидываем его из ВЫВОДА целиком, и в историю он не попадает.
// Подтверждено репродукцией: reasoning с text:"" проходит, без text — FAIL (см. implementation-notes).
const REASONING_PART_TYPES = new Set([
  "reasoning",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "reasoning-file",
]);

const stripReasoningMiddleware: LanguageModelMiddleware = {
  async wrapGenerate({ doGenerate }) {
    const result = await doGenerate();
    return { ...result, content: result.content.filter((p) => p.type !== "reasoning") };
  },
  async wrapStream({ doStream }) {
    const { stream, ...rest } = await doStream();
    return {
      ...rest,
      stream: stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (!REASONING_PART_TYPES.has(part.type)) controller.enqueue(part);
          },
        }),
      ),
    };
  },
};

/** Оборачивает текстовую модель так, чтобы reasoning не попадал в реплеемую историю. */
export function withReasoningStripped(model: WrappableModel): WrappableModel {
  return wrapLanguageModel({ model, middleware: stripReasoningMiddleware });
}
