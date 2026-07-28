// Типы для model-catalog.mjs (чистый ESM) — чтобы tsgo-потребители (agent/provider.ts)
// не ловили TS7016. Единый каталог провайдеров/моделей/effort для Telegram-мастера
// (/model, /think) и валидации THINKING_EFFORT в рантайме.
export interface ProviderCatalogEntry {
  label: string;
  auth: "key" | "oauth";
  base?: string;
  keyVar: string | null;
  modelVar: string;
  def: string;
  models: string[];
}

export interface ModelOption {
  id: string;
  reasoningLevels: string[];
}

export interface FetchModelOptions {
  dataDir?: string;
  listCodexCatalog?: (opts?: { dataDir?: string }) => Promise<ModelOption[]>;
  fetchFn?: typeof fetch;
}

export const EFFORTS: readonly string[];
export const FALLBACK_EFFORTS: readonly string[];
export const CATALOG: Record<string, ProviderCatalogEntry>;

export function providerSupportsReasoning(provider: string): boolean;
export function providerFallbackReasoningLevels(provider: string): string[];
export function fetchModels(provider: string, key?: string, opts?: FetchModelOptions): Promise<string[]>;
export function fetchModelOptions(provider: string, key?: string, opts?: FetchModelOptions): Promise<ModelOption[]>;
export function checkKey(provider: string, key: string): Promise<string | null>;
