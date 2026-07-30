// Общее состояние «идёт ли сейчас ход» per chatKey — мост (telegram-poll.mjs) и
// канал (agent/channels/telegram.ts) читают/пишут файлы data/run-status.d/*.json.
//
// Зачем: мост решает, доставлять сообщение в eve или буферизовать (агент занят),
// а канал знает sessionId/turnId текущего хода для resumeHook-отмены по кнопке.
// Отдельный файл на chatKey не даёт параллельной записи одного чата потерять статус
// другого. Запись одного ключа защищена O_EXCL-локом и атомарна (unique tmp+rename).
//
// chatKey = `${chatId}:${threadId ?? ""}` — тот же ключ, что continuation-hook eve
// (telegram:<chatId>:<threadId>:) и chatKey() моста.

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// Путь от cwd, как в usage.mjs, а НЕ от import.meta.url: канал инлайнится в кэш
// authored-modules eve, откуда «две папки вверх» указывают в node_modules/.cache.
// Оба процесса (iva.service и мост) стартуют с WorkingDirectory=/home/shima/iva.
const DATA_DIR_RAW = process.env.ASSISTANT_DATA_DIR ?? "data";
const DATA_DIR = DATA_DIR_RAW.startsWith("/") ? DATA_DIR_RAW : join(process.cwd(), DATA_DIR_RAW);
const LEGACY_STATUS_FILE = join(DATA_DIR, "run-status.json");
const STATUS_DIR = join(DATA_DIR, "run-status.d");
const positiveMs = (raw, fallback) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const LOCK_STALE_MS = positiveMs(process.env.IVA_RUN_STATUS_LOCK_STALE_MS, 30_000);
const LOCK_TIMEOUT_MS = positiveMs(process.env.IVA_RUN_STATUS_LOCK_TIMEOUT_MS, 5_000);
const LOCK_RETRY_MS = 10;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

// Ход длиннее этого считаем зависшим/осиротевшим (упал без terminal-события):
// мост перестаёт буферизовать, чтобы сообщения не копились вечно.
export const RUN_STALE_MS = Number(process.env.IVA_RUN_STALE_MS ?? 30 * 60 * 1000);

export function chatKeyOf(chatId, threadId) {
  return `${chatId}:${threadId ?? ""}`;
}

function statusFileOf(chatKey) {
  return join(STATUS_DIR, `${Buffer.from(chatKey, "utf8").toString("base64url")}.json`);
}

function readObject(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${file} does not contain a JSON object`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readLegacy(chatKey) {
  try {
    return readObject(LEGACY_STATUS_FILE)?.[chatKey] ?? null;
  } catch {
    // Старый код считал битый whole-map пустым. Чтение остаётся совместимым,
    // но новый код legacy-файл не переписывает и не рискует остальными чатами.
    return null;
  }
}

function readPerChat(chatKey) {
  const file = statusFileOf(chatKey);
  try {
    return readObject(file);
  } catch {
    const backup = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
    try {
      renameSync(file, backup);
    } catch (error) {
      // Another process may have quarantined the same file after our read.
      if (error?.code !== "ENOENT") throw error;
    }
    return null;
  }
}

function readCurrent(chatKey) {
  return readPerChat(chatKey) ?? readLegacy(chatKey);
}

function acquireChatLock(file) {
  mkdirSync(STATUS_DIR, { recursive: true });
  const lock = `${file}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, token);
      } catch (error) {
        rmSync(lock, { force: true });
        throw error;
      } finally {
        closeSync(fd);
      }
      return { lock, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`run-status lock timeout: ${lock}`);
      Atomics.wait(lockWaitBuffer, 0, 0, LOCK_RETRY_MS);
    }
  }
}

function releaseChatLock({ lock, token }) {
  try {
    if (readFileSync(lock, "utf8") !== token) return;
    rmSync(lock, { force: true });
  } catch {
    // Лок уже был отобран после долгой остановки процесса.
  }
}

function writeCurrent(file, value) {
  mkdirSync(STATUS_DIR, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, JSON.stringify(value), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function getChatStatus(chatKey) {
  return readCurrent(chatKey);
}

// Снимок всех per-chat записей для фонового обслуживания мостом.
// Служебные lock/tmp/corrupt файлы и legacy whole-map сюда не попадают.
export function listChatStatuses() {
  let names;
  try {
    names = readdirSync(STATUS_DIR);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const encoded = name.slice(0, -".json".length);
    if (encoded.length === 0) continue;
    const chatKey = Buffer.from(encoded, "base64url").toString("utf8");
    if (statusFileOf(chatKey) !== join(STATUS_DIR, name)) continue;
    const value = readPerChat(chatKey);
    if (value) records.push({ chatKey, status: value });
  }
  return records;
}

// true, когда по chatKey реально идёт ход (running и не протух).
export function isRunning(chatKey, now = Date.now()) {
  const st = getChatStatus(chatKey);
  return Boolean(
    st && st.status === "running" && now - (st.updatedAt ?? 0) < RUN_STALE_MS,
  );
}

function updateChatStatus(chatKey, patch, expected) {
  const file = statusFileOf(chatKey);
  const lock = acquireChatLock(file);
  try {
    // Первый write лениво мигрирует этот ключ из legacy whole-map.
    const prev = readCurrent(chatKey) ?? {};
    if (
      expected &&
      Object.entries(expected).some(([key, value]) => !Object.is(prev[key], value))
    ) {
      return null;
    }
    const previousGeneration =
      Number.isSafeInteger(prev.generation) && prev.generation >= 0
        ? prev.generation
        : 0;
    const next = {
      ...prev,
      ...patch,
      generation: previousGeneration + 1,
      updatedAt: Date.now(),
    };
    for (const key of Object.keys(next)) if (next[key] === null) delete next[key];
    writeCurrent(file, next);
    return next;
  } finally {
    releaseChatLock(lock);
  }
}

// Частичное обновление записи chatKey; null-поля в patch удаляют ключ.
export function setChatStatus(chatKey, patch) {
  return updateChatStatus(chatKey, patch, null);
}

// Atomic compare-and-set для terminal Eve events: reset может успеть удалить
// sessionId между ранним read и записью позднего события.
export function setChatStatusIf(chatKey, expected, patch) {
  return updateChatStatus(chatKey, patch, expected);
}
