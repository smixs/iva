// Типы для run-status.mjs (чистый ESM) — чтобы tsgo-потребители (agent/channels/telegram.ts)
// не ловили TS7016. Тот же паттерн, что telegram-format.d.mts / i18n.d.mts рядом.
export const RUN_STALE_MS: number;
export function chatKeyOf(chatId: string | number, threadId?: string | number | null): string;
export function getChatStatus(chatKey: string): Record<string, unknown> | null;
export function isRunning(chatKey: string, now?: number): boolean;
export function setChatStatus(
  chatKey: string,
  patch: Record<string, unknown>,
): Record<string, unknown>;
