// Типы для telegram-format.mjs (чистый ESM) — чтобы tsgo-потребители не ловили TS7016.
export function escHtml(s: unknown): string;
export function htmlToPlain(html: unknown): string;
export function sanitizeTelegramHtml(html: unknown): string;
export function mdToTelegramHtml(md: unknown): string;
export function chunkMarkdown(md: unknown, limit?: number): string[];
export function toTelegramHtmlChunks(md: unknown, limit?: number): string[];
export function needsRichMessage(md: unknown): boolean;
