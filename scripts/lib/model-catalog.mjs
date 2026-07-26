// Provider/model/effort catalog for the /model and /think Telegram wizards.
// Static lists are the offline fallback; fetchModels() prefers the provider's live
// list (same endpoints as scripts/setup.mjs, which cannot be imported — it runs an
// interactive readline at import). Edit the arrays below to curate what the wizard offers.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listCodexModels, listCodexEfforts } from "./codex-oauth.mjs";

// Reasoning-effort levels: статический ОФЛАЙН-ФОЛБЭК. Живой список для codex берёт
// fetchEfforts() ниже; он же кэширует его в EFFORTS_CACHE_FILE, откуда agent/provider.ts
// читает набор для валидации THINKING_EFFORT — меню и валидация сверяются с одним списком,
// а не совпадают случайно. "minimal" убран — модели gpt-5.6 его не поддерживают (бэкенд
// отвечал бы 400), их шкала: low..max (+ ultra, скрыт — см. fetchEfforts).
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const EFFORTS_CACHE_FILE = "reasoning-efforts.json";

// A hung provider endpoint must not stall the bridge's single getUpdates loop.
const FETCH_TIMEOUT_MS = 10_000;

export const CATALOG = {
  ollama: {
    label: "Ollama Cloud",
    auth: "key",
    base: "https://ollama.com/v1",
    keyVar: "OLLAMA_API_KEY",
    modelVar: "OLLAMA_MODEL",
    def: "deepseek-v4-pro",
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "qwen3.7-max", "gpt-oss:120b", "gemma3:12b"],
  },
  opencode: {
    label: "OpenCode Go",
    auth: "key",
    base: "https://opencode.ai/zen/go/v1",
    keyVar: "OPENCODE_API_KEY",
    modelVar: "OPENCODE_MODEL",
    def: "deepseek-v4-pro",
    // Mirrors OPENCODE_MODELS in setup.mjs (bare IDs, no "opencode-go/" prefix).
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "kimi-k3", "kimi-k2.7-code", "glm-5.2", "qwen3.7-max"],
  },
  codex: {
    label: "OpenAI (подписка)",
    auth: "oauth",
    keyVar: null,
    modelVar: "CODEX_MODEL",
    def: "gpt-5.5",
    models: ["gpt-5.5", "gpt-5.1", "gpt-5"],
  },
  openrouter: {
    label: "OpenRouter",
    auth: "key",
    base: "https://openrouter.ai/api/v1",
    keyVar: "OPENROUTER_API_KEY",
    modelVar: "OPENROUTER_MODEL",
    def: "openai/gpt-5.1",
    // Always static (300+ live models don't fit inline buttons). Curated known-good
    // slugs only: every model here must support tool calling — Iva sends tool
    // definitions each turn (see the live test in setup.mjs for the full check).
    models: [
      "openai/gpt-5.1",
      "anthropic/claude-sonnet-4.5",
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-chat",
      "moonshotai/kimi-k2",
    ],
  },
};

// Живой список уровней размышлений для кнопок /model и /think. На codex — из
// supported_reasoning_levels бэкенда для конкретной модели; "ultra" не показываем:
// бэкенд описывает его как «reasoning with automatic task delegation» — режим
// Codex-клиента, поведение через голый /responses не документировано. Любой сбой
// сети/формата или не-codex провайдер → статический EFFORTS (уровень всё равно
// применяется только на codex).
// Удачный живой список кэшируется в <dataDir>/EFFORTS_CACHE_FILE — его читает
// agent/provider.ts как источник валидации THINKING_EFFORT: меню записало уровень —
// провайдер его примет, даже если статический список отстал от бэкенда.
export async function fetchEfforts(provider, model, { dataDir } = {}) {
  if (provider !== "codex") return EFFORTS;
  try {
    const map = await listCodexEfforts(dataDir ? { dataDir } : {});
    const levels = (map[model] || []).filter((e) => e !== "ultra");
    if (!levels.length) return EFFORTS;
    try {
      writeFileSync(
        join(dataDir || process.env.ASSISTANT_DATA_DIR || "data", EFFORTS_CACHE_FILE),
        JSON.stringify(levels) + "\n",
      );
    } catch {
      /* кэш — best-effort: без него провайдер валидирует по статическому EFFORTS */
    }
    return levels;
  } catch {
    return EFFORTS;
  }
}

// Live model list with static fallback. 401/403 → {auth:true} error (stored key is
// dead — the wizard re-enters the key flow); any other failure (network, format
// drift) → the static list above.
export async function fetchModels(provider, key, { dataDir } = {}) {
  const cat = CATALOG[provider];
  try {
    if (provider === "codex") {
      const live = await listCodexModels(dataDir ? { dataDir } : {});
      return live.length ? live : cat.models;
    }
    if (cat.base && provider !== "openrouter") {
      const res = await fetch(`${cat.base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error("key rejected"), { auth: true });
      if (!res.ok) return cat.models;
      const ids = ((await res.json()).data || []).map((m) => m.id).sort();
      return ids.length ? ids : cat.models;
    }
  } catch (e) {
    if (e.auth) throw e;
    return cat.models;
  }
  return cat.models; // openrouter and anything else: static curated list
}

// Cheap key validity probe (same lenient policy as setup.mjs: network flake ⇒ accept).
// Returns null when the key looks fine, or a short human-readable reason.
export async function checkKey(provider, key) {
  const cat = CATALOG[provider];
  if (!cat?.base) return null;
  // OpenRouter has a dedicated auth-only endpoint; the others validate via /models.
  const url = provider === "openrouter" ? `${cat.base}/key` : `${cat.base}/models`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return `провайдер отверг ключ (${res.status})`;
    return null;
  } catch {
    return null;
  }
}
