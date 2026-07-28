// Provider/model/effort catalog for the /model and /think Telegram wizards.
// Static model lists are the offline fallback. Codex returns model IDs and each
// model's supported reasoning levels in the same /models response.
import { listCodexModelCatalog } from "./codex-oauth.mjs";
import {
  CANONICAL_REASONING_EFFORTS,
  FALLBACK_REASONING_EFFORTS,
} from "./reasoning-levels.mjs";

// Runtime accepts the stable protocol vocabulary. Telegram only offers the live
// model-specific subset; when the response is missing/broken it uses the conservative
// three-button fallback. `ultra` is intentionally absent from both lists.
export const EFFORTS = CANONICAL_REASONING_EFFORTS;
export const FALLBACK_EFFORTS = FALLBACK_REASONING_EFFORTS;

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
    // Mirrors the live GET /models list (checked 2026-07-28). Ollama Cloud retires tags without
    // notice — gemma3:12b went 410 on 2026-07-15 — so keep only IDs seen in the live response.
    // kimi-k3 is billed as "extra usage" on top of the plan (402 with an empty extra balance).
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "kimi-k3", "glm-5.2", "minimax-m3", "gemma4:31b", "gpt-oss:120b"],
  },
  opencode: {
    label: "OpenCode Go",
    auth: "key",
    base: "https://opencode.ai/zen/go/v1",
    keyVar: "OPENCODE_API_KEY",
    modelVar: "OPENCODE_MODEL",
    def: "deepseek-v4-pro",
    // Mirrors OPENCODE_MODELS in setup.mjs (bare IDs, no "opencode-go/" prefix).
    models: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "kimi-k3",
      "kimi-k2.7-code",
      "glm-5.2",
      "minimax-m3",
      "qwen3.7-max",
      "grok-4.5",
    ],
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
      "moonshotai/kimi-k3",
    ],
  },
};

// Ollama Cloud and OpenCode Go both expose OpenAI-compatible reasoning_effort.
// Their /models payloads contain IDs only, so the API's common low/medium/high
// contract is the best available capability signal. Codex is richer: its live
// catalog carries a model-specific subset.
const REASONING_PROVIDERS = new Set(["ollama", "opencode", "codex"]);

export const providerSupportsReasoning = (provider) => REASONING_PROVIDERS.has(provider);
export const providerFallbackReasoningLevels = (provider) =>
  providerSupportsReasoning(provider) ? [...FALLBACK_EFFORTS] : [];

const optionsFor = (provider, models) =>
  models.map((id) => ({
    id,
    reasoningLevels: providerFallbackReasoningLevels(provider),
  }));

// Live model options with static fallback. Codex performs exactly one /models request
// and keeps its model-specific reasoning levels on the in-memory wizard state.
// 401/403 from key providers remains an actionable auth error; network/format failures
// use static model buttons and the provider's conservative reasoning fallback.
export async function fetchModelOptions(provider, key, {
  dataDir,
  listCodexCatalog = listCodexModelCatalog,
  fetchFn = fetch,
} = {}) {
  const cat = CATALOG[provider];
  if (!cat) return [];
  try {
    if (provider === "codex") {
      const live = await listCodexCatalog(dataDir ? { dataDir } : {});
      return live.length ? live : optionsFor(provider, cat.models);
    }
    if (cat.base && provider !== "openrouter") {
      const res = await fetchFn(`${cat.base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error("key rejected"), { auth: true });
      if (!res.ok) return optionsFor(provider, cat.models);
      const ids = ((await res.json()).data || [])
        .map((model) => typeof model?.id === "string" ? model.id.trim() : "")
        .filter(Boolean)
        .sort();
      return ids.length ? optionsFor(provider, ids) : optionsFor(provider, cat.models);
    }
  } catch (e) {
    if (e.auth) throw e;
    return optionsFor(provider, cat.models);
  }
  return optionsFor(provider, cat.models); // openrouter and anything else: static curated list
}

// Compatibility for setup or future CLI consumers that only need IDs.
export async function fetchModels(provider, key, opts = {}) {
  return (await fetchModelOptions(provider, key, opts)).map((option) => option.id);
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
