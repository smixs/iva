// Общее состояние «идёт ли сейчас ход» per chatKey — мост (telegram-poll.mjs) и
// канал (agent/channels/telegram.ts) читают/пишут ОДИН файл data/run-status.json.
//
// Зачем: мост решает, доставлять сообщение в eve или буферизовать (агент занят),
// а канал знает sessionId/turnId текущего хода для resumeHook-отмены по кнопке.
// Оба процесса на одной машине; файл крошечный, пишем атомарно (tmp+rename).
//
// chatKey = `${chatId}:${threadId ?? ""}` — тот же ключ, что continuation-hook eve
// (telegram:<chatId>:<threadId>:) и chatKey() моста.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Путь от cwd, как в usage.mjs, а НЕ от import.meta.url: канал инлайнится в кэш
// authored-modules eve, откуда «две папки вверх» указывают в node_modules/.cache.
// Оба процесса (iva.service и мост) стартуют с WorkingDirectory=/home/shima/iva.
const DATA_DIR_RAW = process.env.ASSISTANT_DATA_DIR ?? "data";
const DATA_DIR = DATA_DIR_RAW.startsWith("/") ? DATA_DIR_RAW : join(process.cwd(), DATA_DIR_RAW);
const STATUS_FILE = join(DATA_DIR, "run-status.json");

// Ход длиннее этого считаем зависшим/осиротевшим (упал без terminal-события):
// мост перестаёт буферизовать, чтобы сообщения не копились вечно.
export const RUN_STALE_MS = Number(process.env.IVA_RUN_STALE_MS ?? 30 * 60 * 1000);

export function chatKeyOf(chatId, threadId) {
  return `${chatId}:${threadId ?? ""}`;
}

function readAll() {
  try {
    const parsed = JSON.parse(readFileSync(STATUS_FILE, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(map) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATUS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(map), "utf8");
  renameSync(tmp, STATUS_FILE);
}

export function getChatStatus(chatKey) {
  return readAll()[chatKey] ?? null;
}

// true, когда по chatKey реально идёт ход (running и не протух).
export function isRunning(chatKey, now = Date.now()) {
  const st = getChatStatus(chatKey);
  return Boolean(
    st && st.status === "running" && now - (st.updatedAt ?? 0) < RUN_STALE_MS,
  );
}

// Частичное обновление записи chatKey; null-поля в patch удаляют ключ.
export function setChatStatus(chatKey, patch) {
  const map = readAll();
  const prev = map[chatKey] ?? {};
  const next = { ...prev, ...patch, updatedAt: Date.now() };
  for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
  map[chatKey] = next;
  writeAll(map);
  return next;
}
