// Типы для i18n.mjs (чистый ESM) — чтобы tsgo-потребители (agent/channels/telegram.ts)
// не ловили TS7016. Тот же паттерн, что telegram-format.d.mts рядом.
export function getLang(): "ru" | "en";
export const tr: (en: string, ru: string) => string;
export const COMMANDS: ReadonlyArray<{
  command: string;
  en: string;
  ru: string;
  args?: { en: string; ru: string };
}>;
export function helpText(): string;
export function botCommands(lang: string): Array<{ command: string; description: string }>;
