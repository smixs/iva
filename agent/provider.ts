import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { CODEX_BASE_URL, codexAuthHeaders } from "../scripts/lib/codex-oauth.mjs";

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];

// Единый источник конфигурации провайдера модели (выбор раз при старте через MODEL_PROVIDER).
// ollama/opencode — OpenAI-совместимы (chat/completions, статичный ключ из .env).
// codex — личная подписка OpenAI (ChatGPT): Responses API + OAuth-токен (data/codex-auth.json,
// `iva login`). Здесь же зашита vision-модель провайдера — её зовёт agent/vision.ts.
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
  codex: {
    baseURL: CODEX_BASE_URL,
    apiKey: undefined, // авторизация — OAuth-токен подписки, не статичный ключ (см. codexFetch)
    textModel: process.env.CODEX_MODEL ?? "gpt-5.5",
    contextWindow: Number(process.env.CODEX_CONTEXT_WINDOW ?? 272000),
    // gpt-5* мультимодальны — картинки идут через ту же подписку (см. agent/vision.ts).
    visionModel: process.env.CODEX_MODEL ?? "gpt-5.5",
  },
} as const;

export const providerName = PROVIDER;
export const providerConfig = PROVIDERS[PROVIDER as keyof typeof PROVIDERS] ?? PROVIDERS.ollama;

// --- Codex (подписка ChatGPT): Responses API через @ai-sdk/openai ----------------------------
// Кастомный fetch: перед КАЖДЫМ запросом подставляет свежий Bearer + ChatGPT-Account-ID
// (getAccessToken рефрешит истёкший токен) и форсит store:false — бэкенд подписки stateless,
// историю eve шлёт целиком каждый ход. Тело патчим здесь же (точка правки, если бэкенд строже).
const codexFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(await codexAuthHeaders())) headers.set(k, v);
  let body = init?.body;
  if (typeof body === "string" && String((input as Request).url ?? input).endsWith("/responses")) {
    try {
      const j = JSON.parse(body);
      j.store = false;
      delete j.previous_response_id;
      body = JSON.stringify(j);
    } catch {
      /* не JSON — не трогаем */
    }
  }
  return fetch(input, { ...init, headers, body });
};

/** Строит Codex-модель (Responses API подписки). Общая для agent.ts и vision.ts. */
export function makeCodexModel(model: string = providerConfig.textModel) {
  const openai = createOpenAI({ baseURL: CODEX_BASE_URL, apiKey: "chatgpt-subscription", fetch: codexFetch });
  return openai.responses(model);
}

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
