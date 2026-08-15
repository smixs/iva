// Pure domain adapter: extracts and formats Telegram Bot API 7.0+ forward_origin
// and quote blocks into canonical Markdown structures without side-effects.
import { TELEGRAM_REPLY_TEXT_MAX_CHARS } from "./telegram-reply-context.ts";

export type TelegramRawRecord = Readonly<Record<string, unknown>>;

export type TelegramCarrierSource =
  | "raw.rich_message.blocks"
  | "message.text"
  | "message.caption"
  | "raw.text"
  | "raw.caption";

export interface ResolvedTelegramCarrier {
  readonly source: TelegramCarrierSource | null;
  readonly rawVerbatim: string;
  readonly normalized: string;
}

export type ResolveTelegramCarrierParams = {
  readonly messageText?: unknown;
  readonly messageCaption?: unknown;
  readonly raw?: unknown;
  readonly richMessageArchiveText?: unknown;
  readonly richMessageSafeModelText?: unknown;
};

export interface TelegramMessageEntity {
  readonly type: string;
  readonly offset: number;
  readonly length: number;
  readonly url?: string;
  readonly language?: string;
  readonly custom_emoji_id?: string;
}

export interface TelegramOriginUser {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly last_name?: string;
  readonly username?: string;
}

export interface TelegramOriginChat {
  readonly id: number;
  readonly type: "private" | "group" | "supergroup" | "channel";
  readonly title?: string;
  readonly username?: string;
  readonly first_name?: string;
  readonly last_name?: string;
}

export interface TelegramMessageOriginChannel {
  readonly type: "channel";
  readonly date: number;
  readonly chat: TelegramOriginChat;
  readonly message_id: number;
  readonly author_signature?: string;
}

export interface TelegramMessageOriginUser {
  readonly type: "user";
  readonly date: number;
  readonly sender_user: TelegramOriginUser;
}

export interface TelegramMessageOriginHiddenUser {
  readonly type: "hidden_user";
  readonly date: number;
  readonly sender_user_name: string;
}

export interface TelegramMessageOriginChat {
  readonly type: "chat";
  readonly date: number;
  readonly sender_chat: TelegramOriginChat;
  readonly author_signature?: string;
}

export type TelegramMessageOrigin =
  | TelegramMessageOriginChannel
  | TelegramMessageOriginUser
  | TelegramMessageOriginHiddenUser
  | TelegramMessageOriginChat;

export interface TelegramMessageQuote {
  readonly text: string;
  readonly position: number;
  readonly entities?: readonly TelegramMessageEntity[];
  readonly is_manual?: boolean;
}

export const DEFAULT_QUOTE_MAX_CHARS = TELEGRAM_REPLY_TEXT_MAX_CHARS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalizes origin display strings: collapses Unicode whitespace to one ASCII
 * space, and replaces square brackets so `[text](url)` cannot become a Markdown
 * link. Linear scan — no quantified regex on attacker-controlled length.
 */
export function sanitizeDisplayString(text: string): string {
  let result = "";
  let pendingSpace = false;
  for (const char of text) {
    if (/\s/u.test(char)) {
      if (result.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      result += " ";
      pendingSpace = false;
    }
    result += char === "[" ? "(" : char === "]" ? ")" : char;
  }
  return result;
}

export function truncateCodePoints(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  const points = Array.from(value);
  if (points.length <= limit) {
    return value;
  }
  return points.slice(0, limit).join("");
}

/**
 * Authoritative carrier resolver.
 * Priority by trimmed eligibility: reconstructed rich_message → message.text →
 * message.caption → raw.text → raw.caption. `rawVerbatim` is the winning field
 * as received (ADR-0002); `normalized` is trimmed for routing and the model turn.
 * When rich_message wins, archival text (lossless) is stored in `rawVerbatim`
 * and the bounded model-facing reconstruction is stored in `normalized`.
 */
export function resolveTelegramCarrier(
  params: ResolveTelegramCarrierParams,
): ResolvedTelegramCarrier {
  const richArchive =
    typeof params.richMessageArchiveText === "string" &&
    params.richMessageArchiveText.trim().length > 0
      ? params.richMessageArchiveText
      : null;
  const richSafeModel =
    typeof params.richMessageSafeModelText === "string" &&
    params.richMessageSafeModelText.trim().length > 0
      ? params.richMessageSafeModelText
      : null;

  if (richArchive !== null || richSafeModel !== null) {
    return {
      source: "raw.rich_message.blocks",
      rawVerbatim: richArchive ?? richSafeModel ?? "",
      normalized: (richSafeModel ?? "").trim(),
    };
  }

  const candidates: Array<{ source: TelegramCarrierSource; value: string }> =
    [];

  if (typeof params.messageText === "string") {
    candidates.push({ source: "message.text", value: params.messageText });
  }
  if (typeof params.messageCaption === "string") {
    candidates.push({
      source: "message.caption",
      value: params.messageCaption,
    });
  }
  const raw = isRecord(params.raw) ? params.raw : null;
  if (raw && typeof raw.text === "string") {
    candidates.push({ source: "raw.text", value: raw.text });
  }
  if (raw && typeof raw.caption === "string") {
    candidates.push({ source: "raw.caption", value: raw.caption });
  }

  for (const candidate of candidates) {
    const trimmed = candidate.value.trim();
    if (trimmed.length > 0) {
      return {
        source: candidate.source,
        rawVerbatim: candidate.value,
        normalized: trimmed,
      };
    }
  }

  const firstPresent = candidates[0];
  return {
    source: firstPresent ? firstPresent.source : null,
    rawVerbatim: firstPresent ? firstPresent.value : "",
    normalized: "",
  };
}

function displayName(firstName: string, lastName: string): string {
  return sanitizeDisplayString([firstName, lastName].filter(Boolean).join(" "));
}

function safeId(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : "";
}

function atUsername(value: unknown): string {
  const username =
    typeof value === "string" ? sanitizeDisplayString(value) : "";
  return username ? `@${username}` : "";
}

function rawScalar(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rawSafeId(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "";
}

/**
 * Un-normalized origin display for the inbound Gate: no whitespace collapse,
 * no bracket replacement, no `Forwarded from` prefix.
 */
export function extractRawOriginDisplay(raw: TelegramRawRecord): string | null {
  if (!isRecord(raw.forward_origin)) return null;

  const origin = raw.forward_origin;
  const originType = typeof origin.type === "string" ? origin.type : null;
  if (!originType) return null;

  if (originType === "channel") {
    const chat = isRecord(origin.chat) ? origin.chat : null;
    if (!chat) return null;
    return (
      rawScalar(chat.title) ||
      rawScalar(chat.username) ||
      rawSafeId(chat.id) ||
      null
    );
  }

  if (originType === "user") {
    const user = isRecord(origin.sender_user) ? origin.sender_user : null;
    if (!user) return null;
    const fullName = [rawScalar(user.first_name), rawScalar(user.last_name)]
      .filter(Boolean)
      .join(" ");
    return fullName || rawScalar(user.username) || rawSafeId(user.id) || null;
  }

  if (originType === "hidden_user") {
    return rawScalar(origin.sender_user_name) || null;
  }

  if (originType === "chat") {
    const chat = isRecord(origin.sender_chat) ? origin.sender_chat : null;
    if (!chat) return null;
    const fullName = [rawScalar(chat.first_name), rawScalar(chat.last_name)]
      .filter(Boolean)
      .join(" ");
    return (
      rawScalar(chat.title) ||
      fullName ||
      rawScalar(chat.username) ||
      rawSafeId(chat.id) ||
      null
    );
  }

  return null;
}

/**
 * Deterministically extracts origin metadata as a plain-text header line.
 * Returns null if origin is absent, unrecognized, or invalid.
 */
export function extractForwardHeader(raw: TelegramRawRecord): string | null {
  if (!isRecord(raw.forward_origin)) {
    return null;
  }

  const origin = raw.forward_origin;
  const originType = typeof origin.type === "string" ? origin.type : null;
  if (!originType) return null;

  if (originType === "channel") {
    const chat = isRecord(origin.chat) ? origin.chat : null;
    if (!chat) return null;

    const title =
      typeof chat.title === "string" ? sanitizeDisplayString(chat.title) : "";
    const chatId = safeId(chat.id);
    const display =
      title || atUsername(chat.username) || (chatId ? `chat ${chatId}` : "");
    return display ? `Forwarded from channel: ${display}` : null;
  }

  if (originType === "user") {
    const user = isRecord(origin.sender_user) ? origin.sender_user : null;
    if (!user) return null;

    const firstName =
      typeof user.first_name === "string"
        ? sanitizeDisplayString(user.first_name)
        : "";
    const lastName =
      typeof user.last_name === "string"
        ? sanitizeDisplayString(user.last_name)
        : "";
    const fullName = displayName(firstName, lastName);
    const userId = safeId(user.id);
    const display =
      fullName || atUsername(user.username) || (userId ? `user ${userId}` : "");
    return display ? `Forwarded from user: ${display}` : null;
  }

  if (originType === "hidden_user") {
    const senderName =
      typeof origin.sender_user_name === "string"
        ? sanitizeDisplayString(origin.sender_user_name)
        : "";
    return senderName ? `Forwarded from hidden user: ${senderName}` : null;
  }

  if (originType === "chat") {
    const chat = isRecord(origin.sender_chat) ? origin.sender_chat : null;
    if (!chat) return null;

    const title =
      typeof chat.title === "string" ? sanitizeDisplayString(chat.title) : "";
    const firstName =
      typeof chat.first_name === "string"
        ? sanitizeDisplayString(chat.first_name)
        : "";
    const lastName =
      typeof chat.last_name === "string"
        ? sanitizeDisplayString(chat.last_name)
        : "";
    const fullName = displayName(firstName, lastName);
    const chatId = safeId(chat.id);
    const display =
      title ||
      fullName ||
      atUsername(chat.username) ||
      (chatId ? `chat ${chatId}` : "");
    return display ? `Forwarded from chat: ${display}` : null;
  }

  return null;
}

/**
 * Quote text exactly as Telegram sent it: no CRLF normalize, trim, or truncation.
 */
export function extractUnboundedRawQuoteText(
  raw: TelegramRawRecord,
): string | null {
  if (!isRecord(raw.quote)) return null;
  return typeof raw.quote.text === "string" ? raw.quote.text : null;
}

/**
 * Extracts raw quote text, normalizes line breaks, and applies Unicode-safe
 * truncation. Does not prefix `>` so the inbound Gate can see role markers
 * in the model-facing form; the Gate itself scans `extractUnboundedRawQuoteText`.
 */
export function extractRawQuoteText(
  raw: TelegramRawRecord,
  maxChars = DEFAULT_QUOTE_MAX_CHARS,
): string | null {
  const quoteText = extractUnboundedRawQuoteText(raw);
  if (quoteText === null) return null;

  const normalized = quoteText.replace(/\r\n|\r/gu, "\n").trim();
  if (!normalized) return null;

  return truncateCodePoints(normalized, maxChars);
}

/**
 * Formats a normalized quote string into Markdown blockquotes (`> line`).
 */
export function formatQuoteToMarkdown(quoteText: string): string {
  return quoteText
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * Extracts and formats quote blocks into Markdown blockquotes (`> line`).
 * Prefixing happens here only; callers that scan for injection must use
 * `extractRawQuoteText` first.
 */
export function extractQuoteText(
  raw: TelegramRawRecord,
  maxChars = DEFAULT_QUOTE_MAX_CHARS,
): string | null {
  const rawQuote = extractRawQuoteText(raw, maxChars);
  return rawQuote !== null ? formatQuoteToMarkdown(rawQuote) : null;
}

/**
 * Assembles all incoming text representations for the Inbound Security Gate.
 * Scans raw origin, quote, rawVerbatim, and normalized (when divergent).
 */
export function assembleInboundGateText(params: {
  readonly rawOriginText?: string;
  readonly rawQuoteText?: string;
  readonly carrier: ResolvedTelegramCarrier;
}): string {
  const chunks: string[] = [];

  if (params.rawOriginText && params.rawOriginText.trim().length > 0) {
    chunks.push(params.rawOriginText.trim());
  }

  if (params.rawQuoteText && params.rawQuoteText.trim().length > 0) {
    chunks.push(params.rawQuoteText.trim());
  }

  const verbatim = params.carrier.rawVerbatim;
  if (verbatim && verbatim.trim().length > 0) {
    chunks.push(verbatim.trim());
  }

  const normalized = params.carrier.normalized;
  if (normalized && normalized.length > 0 && normalized !== verbatim.trim()) {
    chunks.push(normalized);
  }

  return chunks.join("\n\n");
}

/**
 * Assembles only provenance metadata (forward header + blockquoted quote).
 * Never includes caption or carrier text — media presentation owns those.
 */
export function assembleProvenanceText(raw: TelegramRawRecord): string {
  const parts: string[] = [];

  const forwardHeader = extractForwardHeader(raw);
  if (forwardHeader) {
    parts.push(forwardHeader);
  }

  const quoteMarkdown = extractQuoteText(raw);
  if (quoteMarkdown) {
    parts.push(quoteMarkdown);
  }

  return parts.join("\n\n").trim();
}

/**
 * Assembles provenance plus normalized carrier text for the model turn.
 * Apply only after the inbound Gate has scanned `assembleInboundGateText`.
 */
export function assembleFullInboundText(
  raw: TelegramRawRecord,
  carrier: ResolvedTelegramCarrier,
): string {
  const parts: string[] = [];

  const provenance = assembleProvenanceText(raw);
  if (provenance) {
    parts.push(provenance);
  }

  if (carrier.normalized) {
    parts.push(carrier.normalized);
  }

  return parts.join("\n\n").trim();
}
