const PROVIDERS = {
  ollama: { label: "Ollama", model: "OLLAMA_MODEL", context: "OLLAMA_CONTEXT_WINDOW" },
  opencode: { label: "OpenCode", model: "OPENCODE_MODEL", context: "OPENCODE_CONTEXT_WINDOW" },
  openrouter: { label: "OpenRouter", model: "OPENROUTER_MODEL", context: "OPENROUTER_CONTEXT_WINDOW" },
  codex: { label: "OpenAI", model: "CODEX_MODEL", context: "CODEX_CONTEXT_WINDOW" },
};

/** Display-only model settings. Setup writes explicit values, so this helper never duplicates runtime defaults. */
export function modelSummary(env = process.env) {
  const id = (env.MODEL_PROVIDER || "ollama").trim().toLowerCase();
  const provider = PROVIDERS[id] || { label: id || "Model", model: "", context: "" };
  const model = provider.model ? (env[provider.model] || "?").trim() : "?";
  const rawContext = provider.context ? Number(env[provider.context]) : 0;
  return {
    provider: provider.label,
    model,
    contextWindow: Number.isFinite(rawContext) && rawContext > 0 ? rawContext : null,
    line: `${provider.label} · ${model}`,
  };
}

export function compactNumber(value) {
  if (!Number.isFinite(value) || value <= 0) return "?";
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}k`;
  return new Intl.NumberFormat("en-US").format(value);
}
