#!/usr/bin/env node
// Telegram long-polling мост → локальный webhook-роут eve.
//
//   node --env-file=.env scripts/telegram-poll.mjs
//
// eve Telegram-канал работает ТОЛЬКО по webhook (POST /eve/v1/telegram, проверка
// заголовка X-Telegram-Bot-Api-Secret-Token). На голом VPS публичного HTTPS нет,
// поэтому сами забираем апдейты у Telegram (getUpdates, long-poll) и POST-им их в
// локальный роут eve с тем же секретом — Telegram видит обычного бота, прокси не нужен.
// Канал/агент не меняются. Webhook и polling взаимоисключающи → на старте deleteWebhook.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
const PORT = process.env.IVA_PORT ?? "8723";
const HOST = (process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";
const ROUTE = `${HOST}/eve/v1/telegram`;
const API = `https://api.telegram.org/bot${TOKEN}`;
const OFFSET_FILE = join(DATA_DIR, "telegram-offset.json");
// Пауза между апдейтами ОДНОГО чата: даём eve запарковать ход и зарегистрировать
// continuation-хук, иначе бёрст стартует второй ран на тот же токен → HookConflictError.
const SETTLE_MS = Number(process.env.TELEGRAM_POLL_SETTLE_MS ?? 1500);

// Доверенные ID — только им разрешены управляющие команды (/restart и т.п.).
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
);

const HELP = [
  "Команды Iva:",
  "/help — этот список",
  "/restart — перезапустить агента, если завис",
  "/new — начать заново (сброс текущего диалога)",
  "/task <текст> — добавить задачу",
  "/tasks — показать задачи",
  "/digest — утренний дайджест",
].join("\n");

if (!TOKEN) {
  console.error("telegram-poll: нет TELEGRAM_BOT_TOKEN в .env — нечем поллить.");
  process.exit(1);
}
if (!SECRET) {
  console.error("telegram-poll: нет TELEGRAM_WEBHOOK_SECRET_TOKEN — канал не примет апдейты.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// null ⇒ файла нет (первый запуск) — отличаем от честного offset 0.
async function loadOffset() {
  try {
    const { offset } = JSON.parse(await readFile(OFFSET_FILE, "utf8"));
    return typeof offset === "number" ? offset : null;
  } catch {
    return null;
  }
}

// Первый запуск: встать за хвост очереди (последний update_id + 1), чтобы не реплеить
// install-бэклог. drop_pending уже чистит очередь у Telegram — это пояс поверх подтяжек.
async function fastForwardOffset() {
  try {
    const data = await tg("getUpdates", { offset: -1, timeout: 0 });
    const list = data.ok ? data.result || [] : [];
    return list.length ? list[list.length - 1].update_id + 1 : 0;
  } catch (e) {
    log("fast-forward offset не удался:", e.message);
    return 0;
  }
}

// Ключ сериализации = continuation-хук eve (telegram:<chatId>:<threadId>:):
// один чат (+ топик форума) — одна сессия, доставляем в неё по одному с паузой.
function chatKey(update) {
  const msg = update.message ?? update.callback_query?.message;
  const chatId = msg?.chat?.id;
  if (chatId === undefined) return null;
  const threadId = msg?.message_thread_id;
  return `${chatId}:${threadId ?? ""}`;
}
async function saveOffset(offset) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(OFFSET_FILE, JSON.stringify({ offset }), "utf8");
  } catch (e) {
    log("offset save failed:", e.message);
  }
}

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

// Доставить один апдейт в локальный eve (имитируем webhook). Ждём 2xx — не теряем апдейт,
// даже если сервер ещё поднимается (бэкофф до 15с).
async function deliver(update) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(ROUTE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": SECRET,
        },
        body: JSON.stringify(update),
      });
      if (res.ok) return;
      log(`deliver: eve ответил ${res.status} (попытка ${attempt}) — ретрай`);
    } catch (e) {
      log(`deliver: eve недоступен (${e.message}, попытка ${attempt}) — жду сервер`);
    }
    await sleep(Math.min(15000, 1000 * attempt));
  }
}

async function reply(chatId, text) {
  try {
    await tg("sendMessage", { chat_id: chatId, text });
  } catch (e) {
    log("reply failed:", e.message);
  }
}

function restartAgent() {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", "restart", "iva.service"], (err) => resolve(!err));
  });
}

// Управляющие команды обрабатываются МОСТОМ (out-of-band) — работают, даже если агент завис.
// Только для доверенных ID. Возвращает true, если команда обработана (в eve НЕ доставляем).
async function handleControl(update) {
  const msg = update.message;
  const text = (msg?.text || "").trim();
  if (!text.startsWith("/")) return false;
  const cmd = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();
  if (!["/help", "/restart", "/new", "/clear", "/compact"].includes(cmd)) return false;
  const from = String(msg?.from?.id ?? "");
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return false; // не доверенный — пусть eve дропнет
  const chatId = msg?.chat?.id;
  if (cmd === "/help") {
    await reply(chatId, HELP);
    return true;
  }
  // /restart, /new, /clear, /compact → перезапуск процесса (надёжный сброс/recovery).
  await reply(chatId, cmd === "/restart" ? "Перезапускаю агента…" : "Начинаю заново — перезапускаю сессию…");
  const ok = await restartAgent();
  await reply(chatId, ok ? "Готово — пиши." : "Не смог перезапустить (systemctl). Проверь сервис на сервере.");
  return true;
}

async function main() {
  log(`telegram-poll старт → ${ROUTE}`);
  // Первый запуск (нет offset-файла) — сбрасываем накопленный install-бэклог (drop_pending=true),
  // чтобы старое не реплеилось пачкой → параллельные сессии на один чат (HookConflict).
  // На последующих стартах бэклог НЕ дропаем (не теряем сообщения, пришедшие пока мост лежал).
  const firstRun = !existsSync(OFFSET_FILE);
  const dw = await tg("deleteWebhook", { drop_pending_updates: firstRun });
  log("deleteWebhook:", dw.ok ? `ок (drop_pending=${firstRun})` : dw.description);

  let offset = await loadOffset();
  if (offset === null) {
    offset = await fastForwardOffset();
    log("первый запуск — offset за хвостом очереди:", offset);
    await saveOffset(offset);
  } else {
    log("стартовый offset:", offset);
  }

  // Время последней доставки по ключу чата — для паузы SETTLE_MS между апдейтами чата.
  const lastDeliverAt = new Map();

  for (;;) {
    let data;
    try {
      data = await tg("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });
    } catch (e) {
      log("getUpdates сеть:", e.message);
      await sleep(3000);
      continue;
    }
    if (!data.ok) {
      log("getUpdates:", data.description);
      // 409/конфликт — где-то остался webhook; снимаем и пробуем снова.
      if (/409|conflict|webhook/i.test(data.description || "")) {
        await tg("deleteWebhook", { drop_pending_updates: false });
      }
      await sleep(3000);
      continue;
    }
    for (const update of data.result || []) {
      // Управляющие команды (/restart, /help, /new) — мост обрабатывает сам, в eve не шлёт.
      if (await handleControl(update)) {
        offset = update.update_id + 1;
        await saveOffset(offset);
        continue;
      }
      const key = chatKey(update);
      // Не доставлять следующий апдейт того же чата, пока eve не запарковал предыдущий ход
      // (пауза от момента прошлой доставки в этот чат) — иначе бёрст → HookConflict.
      if (key !== null && SETTLE_MS > 0) {
        const prev = lastDeliverAt.get(key);
        if (prev !== undefined) {
          const wait = SETTLE_MS - (Date.now() - prev);
          if (wait > 0) await sleep(wait);
        }
      }
      await deliver(update); // ждём успешной доставки — порядок и без потерь
      if (key !== null) lastDeliverAt.set(key, Date.now());
      offset = update.update_id + 1;
      await saveOffset(offset);
    }
  }
}

main().catch((e) => {
  console.error("telegram-poll фатально:", e);
  process.exit(1);
});
