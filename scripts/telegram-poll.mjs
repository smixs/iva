#!/usr/bin/env node
// Telegram long-polling bridge → local eve webhook route.
//
//   node --env-file=.env scripts/telegram-poll.mjs
//
// The eve Telegram channel works ONLY via webhook (POST /eve/v1/telegram, validating
// the X-Telegram-Bot-Api-Secret-Token header). On a bare VPS there is no public HTTPS,
// so we fetch updates from Telegram ourselves (getUpdates, long-poll) and POST them to
// the local eve route with the same secret — Telegram sees an ordinary bot, no proxy needed.
// The channel/agent are unchanged. Webhook and polling are mutually exclusive → deleteWebhook on start.
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readEntries, summarize, formatUsageReport, parseWindow } from "./lib/usage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = join(ROOT, ".workflow-data");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
const PORT = process.env.IVA_PORT ?? "8723";
const HOST = (process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";
const ROUTE = `${HOST}/eve/v1/telegram`;
const API = `https://api.telegram.org/bot${TOKEN}`;
const OFFSET_FILE = join(DATA_DIR, "telegram-offset.json");
// Pause between updates of the SAME chat: we give eve time to park the turn and register
// the continuation hook, otherwise a burst starts a second run on the same token → HookConflictError.
const SETTLE_MS = Number(process.env.TELEGRAM_POLL_SETTLE_MS ?? 1500);

// Trusted IDs — only they are allowed control commands (/restart etc.).
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
);

// ── Опциональная привязка инстанса к одному топику форум-группы ──────────────
// TELEGRAM_GROUP_ID + TELEGRAM_TOPIC_ID в .env. Не заданы — мост работает как раньше.
// Сценарий: несколько личных инстансов iva в одной группе, у каждого свой топик.
const GROUP_ID = (process.env.TELEGRAM_GROUP_ID ?? "").trim();
const TOPIC_ID = (process.env.TELEGRAM_TOPIC_ID ?? "").trim();
function topicGate(update) {
  const msg = update.message ?? update.callback_query?.message;
  const chat = msg?.chat;
  if (!chat || chat.type === "private" || !GROUP_ID) return true;
  if (String(chat.id) !== GROUP_ID) return false;          // чужая группа — молча мимо
  return String(msg.message_thread_id ?? "") === TOPIC_ID;  // только свой топик
}

const HELP = [
  "Iva commands:",
  "/help — this list",
  "/restart — restart the agent if it's stuck",
  "/new — start over (reset the current conversation)",
  "/task <text> — add a task",
  "/tasks — show tasks",
  "/digest — morning digest",
  "/usage [today|week|month|by-model|by-source] — token usage",
].join("\n");

if (!TOKEN) {
  console.error("telegram-poll: no TELEGRAM_BOT_TOKEN in .env — nothing to poll.");
  process.exit(1);
}
if (!SECRET) {
  console.error("telegram-poll: no TELEGRAM_WEBHOOK_SECRET_TOKEN — the channel won't accept updates.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// null ⇒ no file (first run) — distinguish from a genuine offset 0.
async function loadOffset() {
  try {
    const { offset } = JSON.parse(await readFile(OFFSET_FILE, "utf8"));
    return typeof offset === "number" ? offset : null;
  } catch {
    return null;
  }
}

// First run: jump to the tail of the queue (last update_id + 1) to avoid replaying the
// install backlog. drop_pending already clears Telegram's queue — this is a belt over suspenders.
async function fastForwardOffset() {
  try {
    const data = await tg("getUpdates", { offset: -1, timeout: 0 });
    const list = data.ok ? data.result || [] : [];
    return list.length ? list[list.length - 1].update_id + 1 : 0;
  } catch (e) {
    log("fast-forward offset failed:", e.message);
    return 0;
  }
}

// Serialization key = eve continuation hook (telegram:<chatId>:<threadId>:):
// one chat (+ forum topic) — one session, deliver into it one at a time with a pause.
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

// Deliver one update to the local eve (we mimic a webhook). Wait for 2xx — don't drop the update,
// even if the server is still coming up (backoff up to 15s).
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
      log(`deliver: eve replied ${res.status} (attempt ${attempt}) — retrying`);
    } catch (e) {
      log(`deliver: eve unavailable (${e.message}, attempt ${attempt}) — waiting for server`);
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

const sc = (...args) =>
  new Promise((resolve) => execFile("systemctl", ["--user", ...args], (err) => resolve(!err)));

// Recovery commands (/restart, /new, /clear, /compact) = "reset and bring back up".
// A plain restart doesn't help: on start eve RE-ENQUEUES all pending/running runs from
// .workflow-data, so the stuck/bloated turn comes back. We stop the server, clear
// .workflow-data (while the process is stopped — not from under a live one), bring it back up. It wipes ALL
// parked conversations — for a single-user assistant this is exactly "start over".
async function restartAgent() {
  await sc("stop", "iva.service");
  try {
    await rm(WORKFLOW_DIR, { recursive: true, force: true });
  } catch (e) {
    log("reset: failed to clear .workflow-data:", e.message);
  }
  return sc("start", "iva.service");
}

// Control commands are handled by the BRIDGE (out-of-band) — they work even if the agent is stuck.
// Trusted IDs only. Returns true if the command was handled (we do NOT deliver it to eve).
async function handleControl(update) {
  const msg = update.message;
  const text = (msg?.text || "").trim();
  if (!text.startsWith("/")) return false;
  const cmd = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();
  if (!["/help", "/usage", "/restart", "/new", "/clear", "/compact"].includes(cmd)) return false;
  const from = String(msg?.from?.id ?? "");
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return false; // untrusted — let eve drop it
  const chatId = msg?.chat?.id;
  if (cmd === "/help") {
    await reply(chatId, HELP);
    return true;
  }
  // /usage — token spend from data/usage.jsonl. Out-of-band and FREE (we don't call the model).
  if (cmd === "/usage") {
    const arg = text.split(/\s+/).slice(1).join(" ");
    try {
      const agg = summarize(readEntries(), { window: parseWindow(arg), now: Date.now(), tz: process.env.ASSISTANT_TIMEZONE });
      await reply(chatId, formatUsageReport(agg));
    } catch (e) {
      await reply(chatId, "Couldn't read the usage log: " + e.message);
    }
    return true;
  }
  // /restart, /new, /clear, /compact → process restart (reliable reset/recovery).
  await reply(chatId, cmd === "/restart" ? "Restarting the agent…" : "Starting over — restarting the session…");
  const ok = await restartAgent();
  await reply(chatId, ok ? "Done — go ahead." : "Couldn't restart (systemctl). Check the service on the server.");
  return true;
}

async function main() {
  log(`telegram-poll start → ${ROUTE}`);
  // First run (no offset file) — drop the accumulated install backlog (drop_pending=true),
  // so old messages don't replay in a batch → parallel sessions on one chat (HookConflict).
  // On subsequent starts we do NOT drop the backlog (don't lose messages that arrived while the bridge was down).
  const firstRun = !existsSync(OFFSET_FILE);
  const dw = await tg("deleteWebhook", { drop_pending_updates: firstRun });
  log("deleteWebhook:", dw.ok ? `ok (drop_pending=${firstRun})` : dw.description);

  let offset = await loadOffset();
  if (offset === null) {
    offset = await fastForwardOffset();
    log("first run — offset past the tail of the queue:", offset);
    await saveOffset(offset);
  } else {
    log("starting offset:", offset);
  }

  // Time of the last delivery per chat key — for the SETTLE_MS pause between a chat's updates.
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
      log("getUpdates network:", e.message);
      await sleep(3000);
      continue;
    }
    if (!data.ok) {
      log("getUpdates:", data.description);
      // 409/conflict — a webhook is left somewhere; remove it and try again.
      if (/409|conflict|webhook/i.test(data.description || "")) {
        await tg("deleteWebhook", { drop_pending_updates: false });
      }
      await sleep(3000);
      continue;
    }
    for (const update of data.result || []) {
      // Не наш топик/группа (опция TELEGRAM_TOPIC_ID) — подтверждаем offset и молча пропускаем.
      if (!topicGate(update)) {
        offset = update.update_id + 1;
        await saveOffset(offset);
        continue;
      }
      // Control commands (/restart, /help, /new) — the bridge handles them itself, doesn't send to eve.
      if (await handleControl(update)) {
        offset = update.update_id + 1;
        await saveOffset(offset);
        continue;
      }
      const key = chatKey(update);
      // Don't deliver the next update of the same chat until eve has parked the previous turn
      // (pause measured from the last delivery to this chat) — otherwise a burst → HookConflict.
      if (key !== null && SETTLE_MS > 0) {
        const prev = lastDeliverAt.get(key);
        if (prev !== undefined) {
          const wait = SETTLE_MS - (Date.now() - prev);
          if (wait > 0) await sleep(wait);
        }
      }
      await deliver(update); // wait for successful delivery — ordered and lossless
      if (key !== null) lastDeliverAt.set(key, Date.now());
      offset = update.update_id + 1;
      await saveOffset(offset);
    }
  }
}

main().catch((e) => {
  console.error("telegram-poll fatal:", e);
  process.exit(1);
});
