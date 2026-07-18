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

export const EFFORTS: string[];
export const CATALOG: Record<string, ProviderCatalogEntry>;

export function fetchModels(provider: string, key?: string, opts?: { dataDir?: string }): Promise<string[]>;
export function checkKey(provider: string, key: string): Promise<string | null>;
