type Env = Readonly<Record<string, string | undefined>>;

export const MODEL_PROVIDER_NAMES = [
  "ollama",
  "opencode",
  "openrouter",
  "codex",
] as const;

export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];

type ModelProviderSelection = {
  name: ModelProviderName;
  model: string;
  compatibleReasoning: boolean;
};

const PROVIDERS = new Set<string>(MODEL_PROVIDER_NAMES);

export function resolveModelProvider(
  env: Env = process.env,
): ModelProviderSelection {
  const raw = env.MODEL_PROVIDER ?? "ollama";
  if (!PROVIDERS.has(raw)) {
    throw new Error(
      `Invalid MODEL_PROVIDER ${JSON.stringify(raw)}; expected one of: ${MODEL_PROVIDER_NAMES.join(", ")}`,
    );
  }

  const name = raw as ModelProviderName;
  const model =
    name === "codex"
      ? (env.CODEX_MODEL ?? "gpt-5.5")
      : name === "openrouter"
        ? (env.OPENROUTER_MODEL ?? "openai/gpt-5.1")
        : name === "opencode"
          ? (env.OPENCODE_MODEL ?? "deepseek-v4-pro").replace(
              /^opencode-go\//,
              "",
            )
          : (env.OLLAMA_MODEL ?? "deepseek-v4-pro");

  return {
    name,
    model,
    compatibleReasoning: name === "ollama" || name === "opencode",
  };
}
