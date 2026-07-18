// Provider/model/effort catalog for the /model and /think Telegram wizards.
// Static lists are the offline fallback; fetchModels() prefers the provider's live
// list (same endpoints as scripts/setup.mjs, which cannot be imported — it runs an
// interactive readline at import). Edit the arrays below to curate what the wizard offers.
import { listCodexModels } from "./codex-oauth.mjs";

export const OLLAMA_BASE = "https://ollama.com/v1";
export const OPENCODE_BASE = "https://opencode.ai/zen/go/v1";
export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// Reasoning-effort levels (applied natively on codex only — see agent/provider.ts).
export const EFFORTS = ["minimal", "low", "medium", "high"];

export const CATALOG = {
  ollama: {
    label: "Ollama Cloud",
    auth: "key",
    keyVar: "OLLAMA_API_KEY",
    modelVar: "OLLAMA_MODEL",
    def: "deepseek-v4-pro",
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "qwen3.7-max", "gpt-oss:120b", "gemma3:12b"],
  },
  opencode: {
    label: "OpenCode Go",
    auth: "key",
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

// Live model list with static fallback. 401/403 → {auth:true} error (bad key);
// any other failure (network, format drift) → the static list above.
export async function fetchModels(provider, key, { dataDir } = {}) {
  const cat = CATALOG[provider];
  try {
    if (provider === "codex") {
      const live = await listCodexModels(dataDir ? { dataDir } : {});
      return live.length ? live : cat.models;
    }
    if (provider === "ollama" || provider === "opencode") {
      const base = provider === "ollama" ? OLLAMA_BASE : OPENCODE_BASE;
      const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
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
  const url =
    provider === "ollama" ? `${OLLAMA_BASE}/models`
    : provider === "opencode" ? `${OPENCODE_BASE}/models`
    : provider === "openrouter" ? `${OPENROUTER_BASE}/key`
    : null;
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (res.status === 401 || res.status === 403) return `провайдер отверг ключ (${res.status})`;
    return null;
  } catch {
    return null;
  }
}
