/**
 * Pure deterministic AST parser for Telegram rich editor blocks (`raw.rich_message.blocks`).
 * Implements ADR-0002 Zero Data Loss and structural Markdown link boundary security.
 */

import type { TelegramRawMedia } from "./telegram-parts.ts";

export const MAX_RICH_MESSAGE_NODES = 50_000 as const;
const ALLOWED_RICH_MESSAGE_PROTOCOLS = new Set<string>([
  "http:",
  "https:",
  "tg:",
]);

export type RichMessageRenderMode = "archive" | "safe-model";

// --- Type Contracts ---

export interface RichMessageUrlToken {
  readonly type: "url";
  readonly text: RichMessageText;
  readonly url: string;
}

export interface RichMessageItalicToken {
  readonly type: "italic";
  readonly text: RichMessageText;
}

export interface RichMessageBoldToken {
  readonly type: "bold";
  readonly text: RichMessageText;
}

export interface RichMessageMentionToken {
  readonly type: "mention";
  readonly text?: RichMessageText;
  readonly username?: string;
}

export interface RichMessageUnknownToken {
  readonly type: string;
  readonly text?: RichMessageText;
  readonly [key: string]: unknown;
}

export type RichMessageToken =
  | RichMessageUrlToken
  | RichMessageItalicToken
  | RichMessageBoldToken
  | RichMessageMentionToken
  | RichMessageUnknownToken;

export type RichMessageInline = string | RichMessageToken;

export type RichMessageText = string | readonly RichMessageInline[];

export interface RichMessageParagraph {
  readonly type: "paragraph";
  readonly text: RichMessageText;
}

export interface RichMessagePhotoSize {
  readonly file_id: string;
  readonly file_unique_id?: string;
  readonly file_size?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface RichMessagePhotoBlock {
  readonly type: "photo";
  readonly photo: readonly RichMessagePhotoSize[];
}

export type RichMessageBlock =
  | RichMessageParagraph
  | RichMessagePhotoBlock
  | { readonly type: string; readonly [key: string]: unknown };

// --- Helper Guards & Escaping ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function escapeMarkdownLabel(label: string): string {
  return label
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

export function escapeMarkdownUrl(url: string): string {
  return (
    url
      .replaceAll("\\", "\\\\")
      .replaceAll("(", "\\(")
      .replaceAll(")", "\\)")
      // eslint-disable-next-line no-control-regex -- control characters must be percent-encoded in link destinations
      .replaceAll(/[\s<>\u0000-\u001F\u007F]/g, (match) =>
        encodeURIComponent(match),
      )
  );
}

export function isValidUrlScheme(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ALLOWED_RICH_MESSAGE_PROTOCOLS.has(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Escape-aware preformatted link parser.
 */
function parsePreformattedLink(
  raw: string,
  innerText: string,
): { readonly label: string; readonly href: string | null } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith(")")) {
    let splitIdx = -1;
    let escaped = false;
    let bracketDepth = 0;

    for (let i = 1; i < trimmed.length - 1; i++) {
      const char = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "[" && splitIdx === -1) {
        bracketDepth++;
      } else if (char === "]" && splitIdx === -1) {
        if (bracketDepth > 0) {
          bracketDepth--;
        } else if (trimmed[i + 1] === "(") {
          splitIdx = i;
          break;
        }
      }
    }

    if (splitIdx > 0 && bracketDepth === 0) {
      const labelPart = trimmed.slice(1, splitIdx).trim();
      const targetPart = trimmed.slice(splitIdx + 2, -1).trim();
      if (isValidUrlScheme(targetPart)) {
        return {
          label: innerText || labelPart || targetPart,
          href: targetPart,
        };
      }
      return {
        label: innerText || labelPart || targetPart,
        href: null,
      };
    }
  }

  if (isValidUrlScheme(trimmed)) {
    return { label: innerText || trimmed, href: trimmed };
  }

  return { label: innerText || trimmed, href: null };
}

function positiveFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function comparePhotoSizes(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  const areaA = positiveFinite(a.width) * positiveFinite(a.height);
  const areaB = positiveFinite(b.width) * positiveFinite(b.height);
  if (areaA !== areaB) return areaA - areaB;
  return positiveFinite(a.file_size) - positiveFinite(b.file_size);
}

function selectLargestPhoto(
  block: Record<string, unknown>,
): TelegramRawMedia | null {
  if (!Array.isArray(block.photo) || block.photo.length === 0) {
    return null;
  }

  let bestItem: Record<string, unknown> | null = null;

  for (const item of block.photo) {
    if (
      !isRecord(item) ||
      typeof item.file_id !== "string" ||
      !item.file_id.trim()
    ) {
      continue;
    }
    if (bestItem === null || comparePhotoSizes(item, bestItem) > 0) {
      bestItem = item;
    }
  }

  if (!bestItem || typeof bestItem.file_id !== "string") return null;

  return {
    fileId: bestItem.file_id,
    fileUniqueId:
      typeof bestItem.file_unique_id === "string"
        ? bestItem.file_unique_id
        : undefined,
    tag: "photo",
    transcribe: false,
  };
}

// --- Structural Iterative AST Traversal Engine ---

type IterativeStackItem =
  | { readonly kind: "node"; readonly node: unknown }
  | { readonly kind: "suffix"; readonly value: string }
  | {
      readonly kind: "fallback";
      readonly mark: number;
      readonly defaultText: string;
    }
  | {
      readonly kind: "label-boundary";
      readonly mark: number;
      readonly safeHref: string;
    };

/**
 * Structural iterative AST extractor: `"archive"` is lossless for the Daily
 * Vault; `"safe-model"` keeps allowlisted URLs, escapes completed labels after
 * nested tokens render, and drops disallowed destinations while still rendering
 * nested inner tokens. Empty-label rejected URLs emit a non-empty plain fallback
 * so the carrier stays present (ADR-0002). Traversal is bounded by
 * `MAX_RICH_MESSAGE_NODES`; budget exhaustion or an unclosed label fails
 * closed with `null` and never returns a partial prefix.
 */
export function extractRichMessageIterative(
  richMessage: unknown,
  mode: RichMessageRenderMode,
): string | null {
  try {
    if (!isRecord(richMessage) || !Array.isArray(richMessage.blocks)) {
      return null;
    }

    const lines: string[] = [];
    let totalIterations = 0;

    for (const block of richMessage.blocks) {
      if (!isRecord(block)) continue;
      const blockText = block.text;
      if (blockText === undefined) continue;

      const stack: IterativeStackItem[] = [{ kind: "node", node: blockText }];
      const output: string[] = [];
      let inActiveLabel = false;
      let exhausted = false;

      while (stack.length > 0) {
        if (++totalIterations > MAX_RICH_MESSAGE_NODES) {
          exhausted = true;
          break;
        }
        const current = stack.pop();
        if (!current) continue;

        if (current.kind === "suffix") {
          output.push(current.value);
          continue;
        }

        if (current.kind === "fallback") {
          const emitted = output.slice(current.mark).join("").trim();
          if (emitted.length === 0) {
            output.splice(
              current.mark,
              output.length - current.mark,
              current.defaultText,
            );
          }
          continue;
        }

        if (current.kind === "label-boundary") {
          inActiveLabel = false;
          const rawLabel = output.slice(current.mark).join("");
          const safeLabel = escapeMarkdownLabel(rawLabel);
          const safeUrl = escapeMarkdownUrl(current.safeHref);
          output.splice(
            current.mark,
            output.length - current.mark,
            safeLabel + `](${safeUrl})`,
          );
          continue;
        }

        const node = current.node;

        if (typeof node === "string") {
          output.push(node);
        } else if (Array.isArray(node)) {
          for (let i = node.length - 1; i >= 0; i--) {
            stack.push({ kind: "node", node: node[i] });
          }
        } else if (isRecord(node)) {
          const type = typeof node.type === "string" ? node.type : "";

          if (type === "bold") {
            output.push("**");
            stack.push({ kind: "suffix", value: "**" });
            stack.push({ kind: "node", node: node.text });
          } else if (type === "italic") {
            output.push("*");
            stack.push({ kind: "suffix", value: "*" });
            stack.push({ kind: "node", node: node.text });
          } else if (type === "mention") {
            const user =
              typeof node.username === "string" ? node.username.trim() : "";
            if (user) {
              output.push(user.startsWith("@") ? user : `@${user}`);
            } else if (node.text !== undefined) {
              stack.push({ kind: "node", node: node.text });
            }
          } else if (type === "url") {
            if (mode === "archive") {
              const rawUrl = typeof node.url === "string" ? node.url : "";
              if (rawUrl) {
                output.push("[");
                stack.push({ kind: "suffix", value: `](${rawUrl})` });
                stack.push({
                  kind: "node",
                  node: node.text !== undefined ? node.text : rawUrl,
                });
              } else if (node.text !== undefined) {
                stack.push({ kind: "node", node: node.text });
              }
            } else {
              const rawUrl = typeof node.url === "string" ? node.url : "";
              const parsed = parsePreformattedLink(rawUrl, "");
              const defaultLabel = parsed.label || rawUrl.trim();

              if (
                parsed.href &&
                isValidUrlScheme(parsed.href) &&
                !inActiveLabel
              ) {
                inActiveLabel = true;
                output.push("[");
                const mark = output.length;
                stack.push({
                  kind: "label-boundary",
                  mark,
                  safeHref: parsed.href,
                });
                stack.push({
                  kind: "fallback",
                  mark,
                  defaultText: defaultLabel,
                });
                stack.push({
                  kind: "node",
                  node:
                    node.text !== undefined && node.text !== ""
                      ? node.text
                      : defaultLabel,
                });
              } else {
                // Disallowed scheme OR nested URL inside an active label
                const mark = output.length;
                const fallbackText = inActiveLabel
                  ? defaultLabel
                  : escapeMarkdownLabel(defaultLabel);

                stack.push({
                  kind: "fallback",
                  mark,
                  defaultText: fallbackText,
                });
                stack.push({
                  kind: "node",
                  node:
                    node.text !== undefined && node.text !== ""
                      ? node.text
                      : fallbackText,
                });
              }
            }
          } else if (node.text !== undefined) {
            stack.push({ kind: "node", node: node.text });
          }
        }
      }

      if (exhausted || inActiveLabel) {
        return null;
      }

      lines.push(output.join(""));
    }

    if (lines.length === 0) return null;
    const reconstructed = lines.join("\n\n");
    return reconstructed.trim().length > 0 ? reconstructed : null;
  } catch {
    return null;
  }
}

export function extractRichMessageArchivalText(
  richMessage: unknown,
): string | null {
  return extractRichMessageIterative(richMessage, "archive");
}

export function extractRichMessageSafeModelText(
  richMessage: unknown,
): string | null {
  return extractRichMessageIterative(richMessage, "safe-model");
}

/**
 * Extracts all inline photo blocks from rich_message in sequential order.
 * Returns an empty array if no photo blocks are present or on malformed input.
 */
export function extractRichMessagePhotos(
  richMessage: unknown,
): readonly TelegramRawMedia[] {
  try {
    if (!isRecord(richMessage) || !Array.isArray(richMessage.blocks)) {
      return [];
    }

    const photos: TelegramRawMedia[] = [];

    for (const block of richMessage.blocks) {
      if (!isRecord(block) || block.type !== "photo") continue;
      const media = selectLargestPhoto(block);
      if (media) {
        photos.push(media);
      }
    }

    return photos;
  } catch {
    return [];
  }
}
