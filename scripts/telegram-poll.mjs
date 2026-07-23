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
import { readFile, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { readEntries, summarize, formatUsageReport, parseWindow } from "./lib/usage.mjs";
import { readEnvFresh, readEnvValues, upsertEnv } from "./lib/env-file.mjs";
import { CATALOG, EFFORTS, fetchModels, checkKey } from "./lib/model-catalog.mjs";
import { getAccessToken, runDeviceCodeLogin } from "./lib/codex-oauth.mjs";
import { compactNumber, modelSummary } from "./lib/model-summary.mjs";
import { acquireUpdateLock, releaseUpdateLock } from "./lib/update-safety.mjs";
import { inspectUpstream, markVersionNotified, updateOffer } from "./lib/update-check.mjs";
// ESC-остановка: канал пишет в data/run-status.json, идёт ли сейчас ход по чату;
// мост по нему буферизует входящие (см. очередь ниже) и обслуживает /stop.
import { isRunning } from "./lib/run-status.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = join(ROOT, ".workflow-data");
const NODE = process.execPath;

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
const PORT = process.env.IVA_PORT ?? "8723";
const HOST = (process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const DATA_DIR_RAW = process.env.ASSISTANT_DATA_DIR ?? "data";
const DATA_DIR = DATA_DIR_RAW.startsWith("/") ? DATA_DIR_RAW : join(ROOT, DATA_DIR_RAW);
// Absolute paths for the /model wizard: .env is read fresh (this process's env goes
// stale after the wizard edits the file) and data/ holds codex-auth.json.
const ENV_PATH = join(ROOT, ".env");
const DATA_DIR_ABS = DATA_DIR;
const ROUTE = `${HOST}/eve/v1/telegram`;
const API = `https://api.telegram.org/bot${TOKEN}`;
const OFFSET_FILE = join(DATA_DIR, "telegram-offset.json");
// Pause between updates of the SAME chat: we give eve time to park the turn and register
// the continuation hook, otherwise a burst starts a second run on the same token → HookConflictError.
const SETTLE_MS = Number(process.env.TELEGRAM_POLL_SETTLE_MS ?? 1500);
const UPDATE_JOB_TTL_MS = 6 * 60 * 60 * 1000;

// Trusted IDs — only they are allowed control commands (/restart etc.).
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
);

const LANG = process.env.AGENT_LANGUAGE === "ru" ? "ru" : "en";
const t = (en, ru) => (LANG === "ru" ? ru : en);
const HELP = LANG === "ru"
  ? [
      "Команды Iva:",
      "/help — этот список",
      "/stop — прервать текущий ход (как кнопка ⏹ Стоп)",
      "/restart — перезапустить зависшего агента",
      "/update — проверить и установить обновление",
      "/new — начать диалог заново",
      "/task <текст> — добавить задачу",
      "/tasks — показать задачи",
      "/digest — утренний дайджест",
      "/usage [today|week|month|by-model|by-source] — расход токенов",
      "/model — сменить провайдера, модель и размышления",
      "/think — настроить уровень размышлений",
    ].join("\n")
  : [
      "Iva commands:",
      "/help — this list",
      "/stop — interrupt the current turn (same as the ⏹ Stop button)",
      "/restart — restart the agent if it's stuck",
      "/update — check for a new version and install it",
      "/new — start over (reset the current conversation)",
      "/task <text> — add a task",
      "/tasks — show tasks",
      "/digest — morning digest",
      "/usage [today|week|month|by-model|by-source] — token usage",
      "/model — switch AI provider/model/thinking effort",
      "/think — set thinking effort",
    ].join("\n");

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
    const data = await tg("sendMessage", { chat_id: chatId, text });
    if (!data.ok) throw new Error(data.description || "sendMessage failed");
    return data.result;
  } catch (e) {
    log("reply failed:", e.message);
    return null;
  }
}

async function edit(chatId, messageId, text, replyMarkup) {
  try {
    const body = { chat_id: chatId, message_id: messageId, text };
    if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
    const data = await tg("editMessageText", body);
    if (!data.ok) throw new Error(data.description || "editMessageText failed");
    return data.result;
  } catch (e) {
    if (!/message is not modified/i.test(e.message)) log("edit failed:", e.message);
    return null;
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
  // Reset wipes the ESC-stop state too: a stale "running" flag would keep buffering
  // messages, and a stale queue would replay pre-reset messages into the fresh dialog.
  await rm(join(DATA_DIR, "run-status.json"), { force: true }).catch(() => {});
  await rm(join(DATA_DIR, "telegram-queue.json"), { force: true }).catch(() => {});
  return sc("start", "iva.service");
}

// ── ESC-stop message queue (Claude Code semantics) ─────────────────────────
// While a turn is running for a chat, ordinary message updates are NOT delivered to eve:
// they are appended to data/telegram-queue.json and acknowledged with a 👀 reaction.
// eve would otherwise buffer them in-memory and auto-process the batch as soon as the
// turn parks (its docs call that drain best-effort) — we want the stricter semantics:
// queued messages enter the context only WITH the next fresh message. When the agent is
// idle again, the next message carries the queue along as update.message.iva_buffered
// (the channel turns it into context lines).
const QUEUE_FILE = join(DATA_DIR, "telegram-queue.json");

async function loadQueue() {
  try {
    const q = JSON.parse(await readFile(QUEUE_FILE, "utf8"));
    return typeof q === "object" && q !== null ? q : {};
  } catch {
    return {};
  }
}

async function saveQueue(q) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(QUEUE_FILE, JSON.stringify(q), "utf8");
  } catch (e) {
    log("queue save failed:", e.message);
  }
}

// One queued message → one context line. Media can't be re-fed later (the channel
// processes files only on live delivery), so it degrades to a placeholder + caption.
const MEDIA_KEYS = [
  "photo", "voice", "audio", "video", "video_note",
  "animation", "sticker", "document", "location", "contact", "poll",
];
function bufferEntryOf(msg) {
  const text = (msg.text || "").trim();
  if (text) return text;
  const kind = MEDIA_KEYS.find((k) => msg[k] !== undefined);
  const caption = (msg.caption || "").trim();
  if (!kind) return caption || null;
  const note = `[${kind} — прислано пока шёл ход; вложение не обработано, попроси прислать заново, если оно нужно]`;
  return caption ? `${note} Подпись: ${caption}` : note;
}

// ── self-update (/update) ──────────────────────────────────────────────────
// Run `iva update` in its OWN transient systemd scope, so it survives the restart of
// THIS bridge (restartServices restarts iva-telegram-poll too — a plain child would be
// killed with us). --collect GC's the unit after exit. The updater reads a 0600 job
// file and posts each phase directly through Bot API, so no bridge process survives.
function launchSelfUpdate(jobId) {
  const args = [
    "--user", "--collect", `--unit=iva-self-update-${Date.now()}`,
    `--working-directory=${ROOT}`,
    `--setenv=PATH=${process.env.PATH || ""}`,
    NODE, join(ROOT, "bin/iva.mjs"), "update", "--telegram-job", jobId,
  ];
  return new Promise((resolve) =>
    execFile("systemd-run", args, (err, out, e) => resolve({ ok: !err, msg: (e || out || "").toString().trim() })),
  );
}

export async function handleUpdateCheck(
  chatId,
  { inspectImpl = inspectUpstream, markNotifiedImpl = markVersionNotified, envImpl = () => readEnvFresh(ENV_PATH) } = {},
) {
  const status = await reply(chatId, t("◇ Checking for updates", "◇ Проверяю обновления"));
  if (!status) return;
  let info;
  try {
    info = await inspectImpl({ root: ROOT });
  } catch (e) {
    await edit(chatId, status.message_id, t("⚠️ Couldn't check for updates", "⚠️ Не удалось проверить обновления"));
    return;
  }
  if (!info.hasCommitUpdate) {
    // Not modelSummary(process.env): the /model wizard edits .env at runtime and restarts
    // only the agent — this bridge keeps running, so its env snapshot may hold the old model.
    const model = modelSummary(await envImpl());
    await edit(chatId, status.message_id, t(
      `✅ You're up to date\n\nIva v${info.localVersion ?? "?"}\nModel: ${model.line}`,
      `✅ У вас актуальная версия\n\nIva v${info.localVersion ?? "?"}\nМодель: ${model.line}`,
    ));
    return;
  }
  const bump =
    info.remoteVersion && info.remoteVersion !== info.localVersion
      ? `v${info.localVersion ?? "?"} → v${info.remoteVersion}`
      : t(`v${info.localVersion ?? "?"} → newer build`, `v${info.localVersion ?? "?"} → новая сборка`);
  const offered = await edit(chatId, status.message_id, t(
    `⬆️ Update available\n\n${bump}\nSettings and local changes will be preserved.`,
    `⬆️ Доступно обновление\n\n${bump}\nНастройки и локальные изменения будут сохранены.`,
  ), updateOffer(info.localVersion, info.remoteVersion, LANG).replyMarkup);
  if (offered && info.hasVersionUpdate) {
    await markNotifiedImpl(DATA_DIR, info.remoteVersion).catch((error) => log("update notification state failed:", error.message));
  }
}

async function removeStaleUpdateJobs() {
  const jobs = join(DATA_DIR, "update-jobs");
  let names;
  try { names = await readdir(jobs); } catch { return; }
  await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    const path = join(jobs, name);
    try {
      if (Date.now() - (await stat(path)).mtimeMs > UPDATE_JOB_TTL_MS) await rm(path, { force: true });
    } catch {}
  }));
}

// Inline-button taps for the /update flow. Handled by the bridge; never delivered to eve.
export async function handleUpdateCallback(cq) {
  const from = String(cq.from?.id ?? "");
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  await tg("answerCallbackQuery", { callback_query_id: cq.id }); // clear the button spinner
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return true; // swallow untrusted taps
  const action = cq.data.slice("iva_update:".length);
  if (action === "skip") {
    await edit(chatId, messageId, t("– Update postponed", "– Обновление отложено"), { inline_keyboard: [] });
    return true;
  }

  const jobId = randomBytes(8).toString("hex");
  const lock = acquireUpdateLock(DATA_DIR, jobId);
  if (!lock.ok) {
    await edit(chatId, messageId, t("⚠️ An update is already running", "⚠️ Обновление уже идёт"), { inline_keyboard: [] });
    return true;
  }
  const jobs = join(DATA_DIR, "update-jobs");
  await mkdir(jobs, { recursive: true });
  await writeFile(join(jobs, `${jobId}.json`), JSON.stringify({ chatId, messageId, locale: LANG, startedAt: new Date().toISOString() }), { mode: 0o600 });
  await edit(chatId, messageId, t("◇ Saving your changes", "◇ Сохраняю ваши изменения"), { inline_keyboard: [] });
  const r = await launchSelfUpdate(jobId);
  if (!r.ok) {
    releaseUpdateLock(lock);
    await rm(join(jobs, `${jobId}.json`), { force: true });
    await edit(chatId, messageId, t("⚠️ Couldn't start the update", "⚠️ Не удалось запустить обновление"));
  }
  return true;
}

// ── /model & /think wizard (out-of-band, inline keyboards) ─────────────────
// State lives in memory keyed by `${chatId}:${userId}`; each flow edits ONE message
// (like /update). A bridge restart loses state — stale button taps get "диалог устарел".
// Config is always read fresh from .env: this process's env goes stale after writes.
const wizards = new Map();
const WIZARD_TTL_MS = 15 * 60 * 1000; // matches the codex device-code lifetime

const EFFORT_SET = new Set(EFFORTS);
const effortLabel = (v) => (v && EFFORT_SET.has(v) ? v : "не задан");
const wizKey = (chatId, userId) => `${chatId}:${userId}`;

async function currentConfig() {
  const env = await readEnvValues(ENV_PATH);
  const provider = CATALOG[env.MODEL_PROVIDER] ? env.MODEL_PROVIDER : "ollama";
  const cat = CATALOG[provider];
  return {
    provider,
    model: env[cat.modelVar] || cat.def,
    effort: (env.THINKING_EFFORT ?? "").toLowerCase(),
  };
}

function getWizard(chatId, userId) {
  const k = wizKey(chatId, userId);
  const st = wizards.get(k);
  if (st && Date.now() - st.createdAt > WIZARD_TTL_MS) {
    wizards.delete(k);
    return null;
  }
  return st ?? null;
}

// Replaces any pending wizard of this user: the old flow's async continuations
// (codex login) compare object identity against the map and discard themselves.
function newWizard(chatId, userId, flow) {
  const st = {
    flow, chatId, userId, createdAt: Date.now(),
    msgId: null, provider: null, models: null, model: null, effort: null, awaitKey: false,
  };
  wizards.set(wizKey(chatId, userId), st);
  return st;
}

// Edit the wizard's single message in place (send it the first time).
async function wizScreen(st, text, rows) {
  const reply_markup = rows ? { inline_keyboard: rows } : undefined;
  if (st.msgId) {
    const r = await tg("editMessageText", { chat_id: st.chatId, message_id: st.msgId, text, reply_markup });
    // "message is not modified" = double-tap re-rendered the same screen — success, not failure.
    if (r.ok || /not modified/i.test(r.description || "")) return;
    // edit failed (message too old / deleted) — fall through to a fresh message
  }
  const r = await tg("sendMessage", { chat_id: st.chatId, text, reply_markup });
  if (r.ok) st.msgId = r.result.message_id;
}

// Terminal screen: drop the state, show the final text (no keyboard).
async function endWizard(st, text) {
  wizards.delete(wizKey(st.chatId, st.userId));
  await wizScreen(st, text);
}

const btn = (text, callback_data) => ({ text, callback_data });
const CANCEL_ROW = [btn("Отмена", "iva_model:cancel")];

function effortRows(ns, withKeep) {
  return [
    EFFORTS.map((e) => btn(e, `${ns}:eff:${e}`)),
    [btn("Не задавать", `${ns}:eff:unset`), withKeep ? btn("Оставить", `${ns}:keep`) : CANCEL_ROW[0]],
  ];
}

async function handleModelCmd(chatId, from) {
  const { provider, model, effort } = await currentConfig();
  const st = newWizard(chatId, from, "model");
  await wizScreen(st, `Сейчас: провайдер ${provider} · модель ${model} · размышления: ${effortLabel(effort)}.`, [
    [btn("Сменить", "iva_model:chg"), btn("Оставить", "iva_model:keep")],
  ]);
}

async function handleThinkCmd(chatId, from) {
  const { effort } = await currentConfig();
  const st = newWizard(chatId, from, "think");
  await wizScreen(st, `Уровень размышлений: ${effortLabel(effort)}.`, effortRows("iva_think", true));
}

async function showProviderScreen(st) {
  const rows = Object.entries(CATALOG).map(([id, c]) => [btn(c.label, `iva_model:prov:${id}`)]);
  rows.push(CANCEL_ROW);
  await wizScreen(st, "Выбери провайдера:", rows);
}

async function pickProvider(st, provider) {
  st.provider = provider;
  const cat = CATALOG[provider];
  if (cat.auth === "oauth") {
    // File presence is not enough — a revoked/expired refresh token would let the wizard
    // finish into a config that 401s every turn. getAccessToken refreshes a stale token
    // and throws when there is no usable auth → device-link login.
    try {
      await getAccessToken(DATA_DIR_ABS);
    } catch {
      return startCodexLogin(st);
    }
    return showModelScreen(st);
  }
  const env = await readEnvValues(ENV_PATH);
  if (!env[cat.keyVar]) {
    st.awaitKey = true;
    await wizScreen(st,
      `Нужен API-ключ ${cat.label}. Пришли его следующим сообщением — я сразу удалю его из чата.\n` +
      "Если через пару секунд не подтвержу получение — не отправляй повторно, начни заново с /model.",
      [CANCEL_ROW]);
    return;
  }
  return showModelScreen(st);
}

async function showModelScreen(st) {
  const cat = CATALOG[st.provider];
  const env = await readEnvValues(ENV_PATH);
  let models;
  try {
    models = await fetchModels(st.provider, cat.keyVar ? env[cat.keyVar] : undefined, { dataDir: DATA_DIR_ABS });
  } catch {
    // fetchModels only throws when the live /models probe rejected the stored key (401/403) —
    // re-enter the key flow instead of offering a list the dead key can't use.
    st.awaitKey = true;
    await wizScreen(st,
      `Сохранённый ключ ${cat.label} не принят. Пришли новый ключ следующим сообщением — я сразу удалю его из чата.`,
      [CANCEL_ROW]);
    return;
  }
  // Keep the currently configured model selectable even when the live list is long.
  const current = env[cat.modelVar];
  st.models = [...new Set([...(current ? [current] : []), ...models])].slice(0, 30);
  const rows = st.models.map((m, i) => [btn(m, `iva_model:m:${i}`)]);
  rows.push(CANCEL_ROW);
  await wizScreen(st, `Модель (${cat.label}):`, rows);
}

// Codex device-link login. runDeviceCodeLogin polls up to 15 min — deliberately NOT
// awaited, so the getUpdates loop keeps running; the continuation discards itself
// when this state object is no longer the current wizard (cancelled/replaced).
function startCodexLogin(st) {
  const k = wizKey(st.chatId, st.userId);
  // Serialize device-code log lines (link, one-time code) into ordered chat messages.
  let q = Promise.resolve();
  const tlog = (m) => { q = q.then(() => reply(st.chatId, String(m).trim())); };
  runDeviceCodeLogin({ dataDir: DATA_DIR_ABS, lang: "ru", log: tlog })
    .then(() => {
      if (wizards.get(k) !== st) return;
      return showModelScreen(st);
    })
    .catch((e) => {
      if (wizards.get(k) !== st) return;
      return endWizard(st, "Вход не удался: " + e.message + "\nОтправь /model, чтобы попробовать снова.");
    });
  return wizScreen(st, "Жду вход по подписке OpenAI — ссылка и код ниже. Код живёт 15 минут.", [CANCEL_ROW]);
}

// Plain-text message while the wizard awaits an API key. Deleted from the chat FIRST;
// the key value must never reach eve, log(), reply() or any error text.
async function handleKeyMessage(msg, st) {
  const chatId = msg.chat.id;
  const del = await tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
  if (!del.ok) await reply(chatId, "Не смог удалить сообщение с ключом — удали его вручную.");
  const key = msg.text.trim();
  // Not key-shaped (whitespace / too short) — most likely an ordinary message typed
  // while the prompt was pending. Don't store it; end the wait so the chat works again.
  if (!/^\S{8,}$/.test(key)) {
    await endWizard(st,
      "Это не похоже на API-ключ — ожидание снято, сообщение удалил на всякий случай.\n" +
      "Если это был вопрос — отправь его ещё раз; за ключом приходи через /model.");
    return true;
  }
  const cat = CATALOG[st.provider];
  const err = await checkKey(st.provider, key);
  if (err) {
    await wizScreen(st, `Ключ не принят (${err}). Пришли другой ключ или нажми «Отмена».`, [CANCEL_ROW]);
    return true;
  }
  st.awaitKey = false;
  await upsertEnv(ENV_PATH, { [cat.keyVar]: key }); // persist immediately — the chat copy is gone
  await showModelScreen(st);
  return true;
}

async function saveWizard(st) {
  const updates = { THINKING_EFFORT: st.effort }; // null ⇒ drop the line ("не задан")
  if (st.flow === "model") {
    updates.MODEL_PROVIDER = st.provider;
    updates[CATALOG[st.provider].modelVar] = st.model;
  }
  await upsertEnv(ENV_PATH, updates);
}

async function showSaved(st) {
  const { provider, model, effort } = await currentConfig();
  let text = `Сохранил: ${provider} · ${model} · размышления: ${effortLabel(effort)}.`;
  if (EFFORT_SET.has(effort) && provider !== "codex") {
    text += "\nУровень размышлений сохранён в профиле, но нативно применяется только на codex.";
  }
  text += "\nПерезапустить агента, чтобы применить?";
  await wizScreen(st, text, [[btn("Перезапустить сейчас", "iva_model:rs:now"), btn("Позже", "iva_model:rs:later")]]);
}

// Inline-button taps for /model and /think. Mirrors handleUpdateCallback: ack the
// spinner first, swallow untrusted taps, then dispatch on the wizard state.
async function handleWizardCallback(cq) {
  const from = String(cq.from?.id ?? "");
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  await tg("answerCallbackQuery", { callback_query_id: cq.id });
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return true; // swallow untrusted taps
  const action = cq.data.replace(/^iva_(model|think):/, "");
  const st = getWizard(chatId, from);
  // No state (bridge restarted / TTL) or a tap on an older wizard message → stale.
  if (!st || (st.msgId && messageId && st.msgId !== messageId)) {
    await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: "Диалог устарел — отправь /model заново." });
    return true;
  }
  if (action === "keep") {
    await endWizard(st, st.flow === "think" ? "Оставил текущий уровень размышлений." : "Оставил текущую конфигурацию.");
    return true;
  }
  if (action === "cancel") {
    await endWizard(st, "Отменено.");
    return true;
  }
  if (action === "chg") {
    await showProviderScreen(st);
    return true;
  }
  if (action.startsWith("prov:")) {
    const p = action.slice("prov:".length);
    if (CATALOG[p]) await pickProvider(st, p);
    return true;
  }
  if (action.startsWith("m:")) {
    const m = st.models?.[Number(action.slice("m:".length))];
    if (!m) return true;
    st.model = m;
    await wizScreen(st, "Уровень размышлений:", effortRows("iva_model", false));
    return true;
  }
  if (action.startsWith("eff:")) {
    const v = action.slice("eff:".length);
    st.effort = EFFORT_SET.has(v) ? v : null; // "unset" and anything unknown ⇒ drop
    try {
      await saveWizard(st);
    } catch (e) {
      await endWizard(st, "Не удалось сохранить .env: " + e.message);
      return true;
    }
    await showSaved(st);
    return true;
  }
  if (action === "rs:later") {
    await endWizard(st, "Сохранил. Применится после перезапуска (/restart).");
    return true;
  }
  if (action === "rs:now") {
    await endWizard(st, "Перезапускаю агента… (~30 сек). Текущий диалог продолжится после перезапуска.");
    // Plain restart, NOT restartAgent(): a config change is not a recovery — parked
    // conversations in .workflow-data survive and resume under the new model.
    const ok = await sc("restart", "iva.service");
    if (ok) {
      const { provider, model, effort } = await currentConfig();
      await reply(chatId, `Готово — новая конфигурация активна: ${provider} · ${model} · размышления: ${effortLabel(effort)}.`);
    } else {
      await reply(chatId, "Не удалось перезапустить (systemctl). Проверь сервис на сервере.");
    }
    return true;
  }
  return true;
}

export function resetMessageCopy(cmd, env = process.env, locale = LANG) {
  const tr = (en, ru) => (locale === "ru" ? ru : en);
  const model = modelSummary(env);
  const context = compactNumber(model.contextWindow);
  return cmd === "/restart"
    ? {
        pending: tr("◇ Restarting Iva", "◇ Перезапускаю Iva"),
        complete: tr(`♻️ Iva restarted\n\nModel: ${model.line}\nUnfinished turn cleared`, `♻️ Iva перезапущена\n\nМодель: ${model.line}\nНезавершённый ход очищен`),
      }
    : {
        pending: tr("◇ Starting a new conversation", "◇ Начинаю новый диалог"),
        complete: tr(`✨ New conversation ready\n\nModel: ${model.line}\nContext cleared · window ${context}`, `✨ Новый диалог готов\n\nМодель: ${model.line}\nКонтекст очищен · окно ${context}`),
      };
}

// Control commands are handled by the BRIDGE (out-of-band) — they work even if the agent is stuck.
// Trusted IDs only. Returns true if the command was handled (we do NOT deliver it to eve).
async function handleControl(update) {
  // Bridge-owned inline-button taps (/update, /model, /think) — not eve HITL callbacks.
  const cq = update.callback_query;
  if (cq && typeof cq.data === "string") {
    if (cq.data.startsWith("iva_update:")) return handleUpdateCallback(cq);
    // Wizard errors must not escape: an uncaught throw would crash the bridge and
    // re-poll the update after restart. Consume the tap either way.
    if (cq.data.startsWith("iva_model:") || cq.data.startsWith("iva_think:")) {
      return handleWizardCallback(cq).catch((e) => {
        log("wizard callback error:", e.message);
        return true;
      });
    }
  }
  const msg = update.message;
  const text = (msg?.text || "").trim();
  // A /model wizard waiting for an API key claims this user's next plain-text message
  // (the key must never reach eve); a command aborts the whole wizard — a silently
  // still-visible prompt would invite pasting the key later, when nothing intercepts it.
  if (msg?.from && text) {
    const pending = getWizard(msg.chat?.id, String(msg.from.id));
    if (pending?.awaitKey) {
      if (text.startsWith("/")) {
        await endWizard(pending, "Отменено — ожидание ключа снято.").catch(() => {});
      } else {
        // Consume the update even on failure — the key must never be re-polled into eve.
        return handleKeyMessage(msg, pending).catch((e) => {
          log("wizard key error:", e.message); // e.message never contains the key value
          return true;
        });
      }
    }
  }
  if (!text.startsWith("/")) return false;
  const cmd = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();
  if (!["/help", "/stop", "/usage", "/restart", "/new", "/clear", "/compact", "/update", "/model", "/think"].includes(cmd)) return false;
  const from = String(msg?.from?.id ?? "");
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return false; // untrusted — let eve drop it
  const chatId = msg?.chat?.id;
  if (cmd === "/help") {
    await reply(chatId, HELP);
    return true;
  }
  // /stop — interrupt the current turn. Same path as the ⏹ Stop button: we synthesize a
  // callback_query with data "iva_cancel"; the channel resolves sessionId from run-status
  // and resumes eve's cancel hook. Out-of-band so it reaches a busy agent (an ordinary
  // message would be queued by the gate below and never processed).
  if (cmd === "/stop") {
    const key = chatKey(update);
    if (!key || !isRunning(key)) {
      await reply(chatId, t("Nothing is running right now.", "Сейчас ничего не выполняется."));
      return true;
    }
    await deliver({
      update_id: 0,
      callback_query: {
        id: `ivastop-${Date.now()}`, // synthetic: answerCallbackQuery on it fails, channel tolerates
        from: msg.from,
        message: msg, // carries chat/thread — the channel derives chatKey from here
        data: "iva_cancel",
      },
    });
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
  // /update — check upstream; if newer, offer inline Update/Skip buttons. Out-of-band.
  if (cmd === "/update") {
    await handleUpdateCheck(chatId);
    return true;
  }
  // /model, /think — provider/model/effort wizard (writes .env; applied on restart).
  if (cmd === "/model") {
    await handleModelCmd(chatId, from).catch((e) => log("wizard /model error:", e.message));
    return true;
  }
  if (cmd === "/think") {
    await handleThinkCmd(chatId, from).catch((e) => log("wizard /think error:", e.message));
    return true;
  }
  // /restart, /new, /clear, /compact → process restart (reliable reset/recovery).
  // Fresh .env, not this process's snapshot — see the same note in handleUpdateCheck.
  const resetCopy = resetMessageCopy(cmd, await readEnvFresh(ENV_PATH));
  const status = await reply(chatId, resetCopy.pending);
  const ok = await restartAgent();
  if (!status) return true;
  if (!ok) {
    await edit(chatId, status.message_id, t("⚠️ Couldn't restart Iva", "⚠️ Не удалось перезапустить Iva"));
    return true;
  }
  await edit(chatId, status.message_id, resetCopy.complete);
  return true;
}

async function main() {
  if (!TOKEN) throw new Error("no TELEGRAM_BOT_TOKEN in .env — nothing to poll");
  if (!SECRET) throw new Error("no TELEGRAM_WEBHOOK_SECRET_TOKEN — the channel won't accept updates");
  log(`telegram-poll start → ${ROUTE}`);
  await removeStaleUpdateJobs();
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
      // Control commands (/restart, /help, /new) — the bridge handles them itself, doesn't send to eve.
      if (await handleControl(update)) {
        offset = update.update_id + 1;
        await saveOffset(offset);
        continue;
      }
      const key = chatKey(update);
      // ESC-stop queue gate (messages only): while a turn is running for this chat, buffer
      // the message instead of delivering. callback_query always passes (eve HITL buttons
      // and ⏹ Стоп must reach a busy agent). Replies to bot messages also pass — that's
      // how HITL ForceReply answers arrive; queueing one would deadlock the waiting turn.
      if (update.message && key !== null && update.message.reply_to_message?.from?.is_bot !== true) {
        if (isRunning(key)) {
          const entry = bufferEntryOf(update.message);
          if (entry !== null) {
            const q = await loadQueue();
            (q[key] ??= []).push(entry);
            await saveQueue(q);
            // Silent ack: a 👀 reaction on the user's message (no extra chat message).
            await tg("setMessageReaction", {
              chat_id: update.message.chat.id,
              message_id: update.message.message_id,
              reaction: [{ type: "emoji", emoji: "👀" }],
            }).catch((e) => log("reaction failed:", e.message));
          }
          offset = update.update_id + 1;
          await saveOffset(offset);
          continue;
        }
        // Idle again: the next fresh message carries the queued ones along.
        const q = await loadQueue();
        const pending = q[key];
        if (Array.isArray(pending) && pending.length) {
          update.message.iva_buffered = pending;
          delete q[key];
          await saveQueue(q);
        }
      }
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

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("telegram-poll fatal:", e);
    process.exit(1);
  });
}
