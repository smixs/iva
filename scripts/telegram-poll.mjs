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
import { readFile, writeFile, mkdir, rename, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { readEntries, summarize, formatUsageReport, parseWindow } from "./lib/usage.mjs";
import { readEnvFresh, readEnvValues, upsertEnv } from "./lib/env-file.mjs";
import {
  CATALOG,
  EFFORTS,
  fetchModelOptions,
  checkKey,
  providerFallbackReasoningLevels,
  providerSupportsReasoning,
} from "./lib/model-catalog.mjs";
import { getAccessToken, runDeviceCodeLogin } from "./lib/codex-oauth.mjs";
import { compactNumber, modelSummary } from "./lib/model-summary.mjs";
import { acquireUpdateLock, releaseUpdateLock } from "./lib/update-safety.mjs";
import { inspectUpstream, markVersionNotified, updateOffer } from "./lib/update-check.mjs";
// ESC-остановка: канал пишет в data/run-status.d, идёт ли сейчас ход по чату;
// мост по нему буферизует входящие (см. очередь ниже) и обслуживает /stop.
import { getChatStatus, isRunning, setChatStatus } from "./lib/run-status.mjs";
import { classifyDeliverStatus } from "./lib/deliver-policy.mjs";
import { alreadyDelivered, parseOffsetFile, serializeOffsetFile } from "./lib/offset-store.mjs";
import { continuationTokenForControl, requestTelegramReset } from "./lib/telegram-reset.mjs";
// Двуязычие: единый источник языка (getLang) + одна таблица команд (COMMANDS) для /help
// и синего командного меню Telegram. tr(en, ru) — функция (язык не замораживаем в const).
import { getLang, tr, helpText, botCommands } from "./lib/i18n.mjs";
// Session-store out-of-band диалогов: /model, /think и /menu делят ОДИН слот на пользователя.
import { createFlows } from "./lib/tg-flow.mjs";
// Движок вложенного inline-меню (/menu) — весь UI настроек в мосте, out-of-band.
import { createMenu } from "./lib/menu/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USER_ID = /^(\d+):/.exec(TOKEN ?? "")?.[1] ?? null;
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
const RESET_ROUTE = `${ROUTE}/reset`;
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

// LANG/t/HELP убраны: язык теперь динамический (getLang из i18n.mjs, реагирует на
// data/settings.json без рестарта), /help генерится helpText() из общей таблицы COMMANDS.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// offset: null ⇒ no file (first run) — distinguish from a genuine offset 0.
// delivered: update_id последнего доставленного в eve апдейта (см. offset-store.mjs).
async function loadOffset() {
  try {
    return parseOffsetFile(await readFile(OFFSET_FILE, "utf8"));
  } catch {
    return { offset: null, delivered: null };
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
async function saveOffset(offset, delivered = null) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(OFFSET_FILE, serializeOffsetFile(offset, delivered), "utf8");
  } catch (e) {
    log("offset save failed:", e.message);
  }
}

// Every Bot API call carries a deadline — a hung response must never stall the single polling loop.
// The default suits normal calls; getUpdates overrides it to sit above its own long-poll window.
async function tg(method, body, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

// Read a web ReadableStream as UTF-8 text with a HARD cap: it stops and cancels the stream the moment
// the running total exceeds maxBytes, so an oversized (or size-unknown) body is never fully buffered.
// The caller passes an already time-bounded body (see downloadTelegramFile) so a hung socket mid-read
// aborts the read too. Returns null on over-size or a read error. Pure — unit-tested off the network.
export async function readCappedStream(body, maxBytes) {
  if (!body || typeof body.getReader !== "function") return null;
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Download a Telegram file's bytes as UTF-8 text (getFile → file download), hard-capped at maxBytes and
// deadline-bounded at every step (getFile call, the download connection, and the streamed read — a size
// cap alone doesn't save the loop from a stalled socket). Returns null on any failure or over-size.
async function downloadTelegramFile(fileId, maxBytes) {
  try {
    const info = await tg("getFile", { file_id: fileId }, { timeoutMs: 10_000 });
    const filePath = info?.result?.file_path;
    if (!filePath) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    // Cheap early reject when the server declares an over-size body; the stream reader below is the
    // hard cap regardless (a missing or lying Content-Length can't get past it).
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    return await readCappedStream(res.body, maxBytes);
  } catch {
    return null;
  }
}

// Deliver one update to the local eve (we mimic a webhook). Three failure classes (see
// deliver-policy.mjs): retry — network/5xx/408/425/429, fast backoff, forever; config —
// 401/403/404 mean the secret/route is broken, messages must NOT be thrown away, so
// retry forever with a LONG backoff + alert the owner; drop-class (other 4xx) — eve
// не даёт надёжного признака «апдейт битый навсегда» (тот же 409 может быть временным
// конфликтом хука), поэтому и эти статусы ретраятся, но ОГРАНИЧЕННО: DROP_ATTEMPTS
// попыток (~5 минут), затем апдейт выбрасывается, чтобы не заморозить все чаты.
// Returns true when eve accepted the update, false when it was dropped.
const CONFIG_RETRY_MS = 60_000;
const DROP_ATTEMPTS = 30;
async function deliver(update) {
  for (let attempt = 1; ; attempt++) {
    let wait = Math.min(15000, 1000 * attempt);
    try {
      const res = await fetch(ROUTE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": SECRET,
        },
        body: JSON.stringify(update),
      });
      if (res.ok) return true;
      const cls = classifyDeliverStatus(res.status);
      if (cls === "drop") {
        if (attempt < DROP_ATTEMPTS) {
          log(`deliver: eve replied ${res.status} (attempt ${attempt}/${DROP_ATTEMPTS}) — retrying (may be transient)`);
          await sleep(wait);
          continue;
        }
        log(`deliver: eve replied ${res.status} ${DROP_ATTEMPTS} times — DROPPING update ${update.update_id}`);
        await notifyDeliverProblem("drop", res.status);
        return false;
      }
      if (cls === "config") {
        // Не дропаем: это конфигурация сломана, а не апдейт. Длинный бэкофф, чтобы не
        // молотить, и алерт владельцу — чинить надо руками (secret/route).
        wait = CONFIG_RETRY_MS;
        await notifyDeliverProblem("config", res.status);
        log(`deliver: eve replied ${res.status} (config error, attempt ${attempt}) — retrying in ${wait / 1000}s`);
      } else {
        log(`deliver: eve replied ${res.status} (attempt ${attempt}) — retrying`);
      }
    } catch (e) {
      log(`deliver: eve unavailable (${e.message}, attempt ${attempt}) — waiting for server`);
    }
    await sleep(wait);
  }
}

// Владелец должен узнать и о выброшенном апдейте, и о конфиг-ошибке (secret/route).
// Один раз на процесс и класс — чтобы серия ошибок не превратилась в спам. Класс
// помечается «уведомлённым» только ПОСЛЕ успешной отправки: упавший sendMessage не
// должен навсегда лишать владельца алерта.
const deliverNotified = new Set();
async function notifyDeliverProblem(kind, status) {
  if (deliverNotified.has(kind)) return;
  const target = process.env.TELEGRAM_DIGEST_CHAT_ID || [...ALLOWED][0];
  if (!target) return;
  const text =
    kind === "config"
      ? tr(
          `⚠️ Iva bridge can't deliver to eve: HTTP ${status} — the webhook secret or route looks broken. Messages are queued (retrying every 60s). Check: journalctl --user -u iva-telegram-poll`,
          `⚠️ Мост Iva не может доставить в eve: HTTP ${status} — похоже, разъехались webhook-секрет или маршрут. Сообщения не теряются (ретрай раз в 60с). Проверь: journalctl --user -u iva-telegram-poll`,
        )
      : tr(
          `⚠️ Iva bridge dropped a Telegram update: eve replied ${status} (permanent). Check the logs: journalctl --user -u iva-telegram-poll`,
          `⚠️ Мост Iva выбросил Telegram-апдейт: eve ответила ${status} (постоянная ошибка). Проверь логи: journalctl --user -u iva-telegram-poll`,
        );
  try {
    const res = await tg("sendMessage", { chat_id: target, text });
    if (res?.ok) deliverNotified.add(kind);
  } catch (e) {
    log("deliver notification failed:", e.message);
  }
}

// Время последней доставки по chat key — для паузы SETTLE_MS между апдейтами одного чата.
// МОДУЛЬ-уровень (не локальная в main): её обязан обновлять и синтетический deliver меню
// (дистилляция интервью), иначе реальное сообщение сразу после него ушло бы без паузы —
// в окно, пока eve ещё не записала run-status и не зарегистрировала continuation-hook →
// второй ран на том же токене → HookConflictError.
const lastDeliverAt = new Map();

// Доставка с пейсингом: выдержать SETTLE_MS с последней доставки в этот чат, доставить,
// отметить время. ЕДИНЫЙ путь для главного цикла и для меню (deps.deliver) — оба делят
// lastDeliverAt, поэтому доставка из меню сдвигает паузу для следующего реального сообщения.
async function pacedDeliver(update) {
  const key = chatKey(update);
  if (key !== null && SETTLE_MS > 0) {
    const prev = lastDeliverAt.get(key);
    if (prev !== undefined) {
      const wait = SETTLE_MS - (Date.now() - prev);
      if (wait > 0) await sleep(wait);
    }
  }
  const accepted = await deliver(update); // wait for delivery — ordered and lossless
  if (key !== null) lastDeliverAt.set(key, Date.now());
  return accepted; // false = апдейт выброшен как битый, eve его НЕ получила
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

// ── ESC-stop message queue (Claude Code semantics) ─────────────────────────
// While a turn is running for a chat, ordinary message updates are NOT delivered to eve:
// they are appended to data/telegram-queue.json and acknowledged with a 👀 reaction.
// eve would otherwise buffer them in-memory and auto-process the batch as soon as the
// turn parks (its docs call that drain best-effort) — we want the stricter semantics:
// queued messages enter the context only WITH the next fresh message. When the agent is
// idle again, the next message carries the queue along as update.message.iva_buffered
// (the channel turns it into context lines).
const QUEUE_FILE = join(DATA_DIR, "telegram-queue.json");

export async function loadQueue({ strict = false } = {}) {
  let raw;
  try {
    raw = await readFile(QUEUE_FILE, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  try {
    const queue = JSON.parse(raw);
    if (typeof queue !== "object" || queue === null || Array.isArray(queue)) {
      throw new Error(`${QUEUE_FILE} does not contain a JSON object`);
    }
    return queue;
  } catch (error) {
    if (strict) throw error;
    const backup = `${QUEUE_FILE}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
    // Ordinary polling must stay live, but returning {} before the damaged
    // bytes are safely moved would let the next save overwrite evidence/data.
    await rename(QUEUE_FILE, backup);
    log(`damaged Telegram queue moved to ${backup}:`, error.message);
    return {};
  }
}

export async function writeQueueAtomic(
  queue,
  {
    writeFileImpl = writeFile,
    renameImpl = rename,
    rmImpl = rm,
    nonce = randomBytes(8).toString("hex"),
  } = {},
) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${QUEUE_FILE}.tmp-${process.pid}-${nonce}`;
  try {
    await writeFileImpl(tmp, JSON.stringify(queue), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await renameImpl(tmp, QUEUE_FILE);
  } finally {
    await rmImpl(tmp, { force: true }).catch(() => {});
  }
}

async function saveQueue(q) {
  try {
    await writeQueueAtomic(q);
  } catch (e) {
    log("queue save failed:", e.message);
  }
}

// A scoped reset intentionally discards only messages queued for this chat/topic.
// Other conversations keep both their queues and their Eve histories.
async function clearChatQueue(chatKey) {
  const q = await loadQueue({ strict: true });
  if (!(chatKey in q)) return;
  delete q[chatKey];
  // Reset cleanup must fail loudly: completeScopedResetState keeps the old
  // running status until this atomic rename succeeds.
  await writeQueueAtomic(q);
}

export async function completeScopedResetState(
  chatKey,
  continuationToken,
  {
    clearQueue = false,
    clearQueueImpl = clearChatQueue,
    setStatusImpl = setChatStatus,
  } = {},
) {
  // For private chats the queue belongs to the reset session, so clear it
  // before exposing an idle tombstone. A failed cleanup leaves the old running
  // status in place and lets a repeated /new retry safely.
  if (clearQueue) await clearQueueImpl(chatKey);

  // Keep an idle token tombstone: Telegram updates are at-least-once. If the
  // same group /new is replayed after a crash, the second reset remains an
  // idempotent no_active_session instead of losing the group anchor.
  setStatusImpl(chatKey, {
    status: "idle",
    continuationToken,
    sessionId: null,
    turnId: null,
    statusMessageId: null,
    wasCancelled: null,
    resetAt: Date.now(),
  });
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
  const note = tr(
    `[${kind} — sent while a turn was running; the attachment wasn't processed, ask to resend it if you need it]`,
    `[${kind} — прислано пока шёл ход; вложение не обработано, попроси прислать заново, если оно нужно]`,
  );
  return caption ? `${note} ${tr("Caption:", "Подпись:")} ${caption}` : note;
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
  const status = await reply(chatId, tr("◇ Checking for updates", "◇ Проверяю обновления"));
  if (!status) return;
  let info;
  try {
    info = await inspectImpl({ root: ROOT });
  } catch (e) {
    await edit(chatId, status.message_id, tr("⚠️ Couldn't check for updates", "⚠️ Не удалось проверить обновления"));
    return;
  }
  if (!info.hasCommitUpdate) {
    // Not modelSummary(process.env): the /model wizard edits .env at runtime and restarts
    // only the agent — this bridge keeps running, so its env snapshot may hold the old model.
    const model = modelSummary(await envImpl());
    await edit(chatId, status.message_id, tr(
      `✅ You're up to date\n\nIva v${info.localVersion ?? "?"}\nModel: ${model.line}`,
      `✅ У вас актуальная версия\n\nIva v${info.localVersion ?? "?"}\nМодель: ${model.line}`,
    ));
    return;
  }
  const bump =
    info.remoteVersion && info.remoteVersion !== info.localVersion
      ? `v${info.localVersion ?? "?"} → v${info.remoteVersion}`
      : tr(`v${info.localVersion ?? "?"} → newer build`, `v${info.localVersion ?? "?"} → новая сборка`);
  const offered = await edit(chatId, status.message_id, tr(
    `⬆️ Update available\n\n${bump}\nSettings and local changes will be preserved.`,
    `⬆️ Доступно обновление\n\n${bump}\nНастройки и локальные изменения будут сохранены.`,
  ), updateOffer(info.localVersion, info.remoteVersion, getLang()).replyMarkup);
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
    await edit(chatId, messageId, tr("– Update postponed", "– Обновление отложено"), { inline_keyboard: [] });
    return true;
  }

  const jobId = randomBytes(8).toString("hex");
  const lock = acquireUpdateLock(DATA_DIR, jobId);
  if (!lock.ok) {
    await edit(chatId, messageId, tr("⚠️ An update is already running", "⚠️ Обновление уже идёт"), { inline_keyboard: [] });
    return true;
  }
  const jobs = join(DATA_DIR, "update-jobs");
  await mkdir(jobs, { recursive: true });
  await writeFile(join(jobs, `${jobId}.json`), JSON.stringify({ chatId, messageId, locale: getLang(), startedAt: new Date().toISOString() }), { mode: 0o600 });
  await edit(chatId, messageId, tr("◇ Saving your changes", "◇ Сохраняю ваши изменения"), { inline_keyboard: [] });
  const r = await launchSelfUpdate(jobId);
  if (!r.ok) {
    releaseUpdateLock(lock);
    await rm(join(jobs, `${jobId}.json`), { force: true });
    await edit(chatId, messageId, tr("⚠️ Couldn't start the update", "⚠️ Не удалось запустить обновление"));
  }
  return true;
}

// ── /model & /think wizard (out-of-band, inline keyboards) ─────────────────
// State lives in memory keyed by `${chatId}:${userId}`; each flow edits ONE message
// (like /update). A bridge restart loses state — stale button taps get "диалог устарел".
// Config is always read fresh from .env: this process's env goes stale after writes.
// Примитивы визарда вынесены в scripts/lib/tg-flow.mjs (createFlows): тот же слот на
// пользователя делят /model, /think и /menu. Локальные алиасы сохраняют исходные call-sites —
// дифф визарда минимальный, а стейт-семантика (ключ chatId:userId, TTL 15 мин, identity-replace,
// edit-in-place) дословно та же.
const flows = createFlows({ tg, log });
const getWizard = (chatId, userId) => flows.get(chatId, userId);
const newWizard = (chatId, userId, flow, extra) => flows.start(chatId, userId, flow, extra);
const wizScreen = (st, text, rows) => flows.screen(st, text, rows);
const endWizard = (st, text, rows) => flows.end(st, text, rows);
const wizardIsCurrent = (st) => flows.get(st.chatId, st.userId) === st;

// A network result belongs to the wizard object that started it. The slot can be
// replaced while the request is pending (Cancel, /menu, another /model), so both
// success and error must be discarded before either path mutates or renders state.
export async function runWizardRequest(st, request, isCurrent = wizardIsCurrent) {
  try {
    const value = await request();
    return isCurrent(st) ? { ok: true, value } : { stale: true };
  } catch (error) {
    return isCurrent(st) ? { ok: false, error } : { stale: true };
  }
}

const EFFORT_SET = new Set(EFFORTS);
// effortLabel — функция (tr на месте вызова): язык не замораживается в module-level const.
const effortLabel = (v) => (v && EFFORT_SET.has(v) ? v : tr("not set", "не задан"));

export function isStaleWizard(st, messageId) {
  return !st || (st.msgId != null && messageId != null && st.msgId !== messageId);
}

export function wizardActionAllowed(st, action) {
  if (!st || action === "cancel") return Boolean(st);
  if (action === "keep") return st.step === "intro" || st.step === "effort";
  if (action === "chg") return st.step === "intro";
  if (action.startsWith("prov:")) return st.step === "provider";
  if (action.startsWith("m:")) return st.step === "models";
  if (action.startsWith("eff:")) return st.step === "effort";
  if (action.startsWith("rs:")) return st.step === "saved";
  return false;
}

export function selectWizardModel(st, rawIndex) {
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0) return null;
  const option = st.modelOptions?.[index];
  if (!option) return null;
  st.model = option.id;
  st.efforts = [...option.reasoningLevels];
  return option;
}

export function selectWizardEffort(st, value) {
  if (value === "unset") {
    st.effort = null;
    return true;
  }
  if (!EFFORT_SET.has(value) || !st.efforts?.includes(value)) return false;
  st.effort = value;
  return true;
}

async function currentConfig() {
  const env = await readEnvValues(ENV_PATH);
  const provider = CATALOG[env.MODEL_PROVIDER] ? env.MODEL_PROVIDER : "ollama";
  const cat = CATALOG[provider];
  return {
    provider,
    model: env[cat.modelVar] || cat.def,
    effort: providerSupportsReasoning(provider) ? (env.THINKING_EFFORT ?? "").toLowerCase() : "",
  };
}

const btn = (text, callback_data) => ({ text, callback_data });
// cancelRow/menuRow — функции (tr на месте вызова), не module-level const с переведённой строкой.
const cancelRow = () => [btn(tr("Cancel", "Отмена"), "iva_model:cancel")];
// Ряд «‹ Меню» на терминальных экранах визарда — возврат в /menu. r:o усыновляет
// это сообщение даже без живого стейта (движок меню само-чинится после рестарта моста).
const menuRow = () => [[btn(tr("‹ Menu", "‹ Меню"), "iva_menu:r:o")]];

// Секреты (API-ключи) принимаем ТОЛЬКО в личке: в группе бот может не иметь прав удалить
// сообщение с ключом (deleteMessage вернёт !ok), и его увидят все участники. Знак chatId
// надёжен — id личных чатов положительны, групп/супергрупп отрицательны (та же isPrivate,
// что в menu-экранах search.mjs). Гейтим ОБА пути к ключу: и голый /model, и хендофф из /menu.
const isPrivateChat = (st) => Number(st.chatId) > 0;
const refuseSecretInGroup = (st) =>
  endWizard(st, tr(
    "API keys are secrets — open a private chat with me and set the key there.",
    "Ключи — это секрет. Открой личный чат со мной и введи ключ там.",
  ), menuRow());

function effortRows(ns, withKeep, efforts) {
  const rows = [];
  for (let i = 0; i < efforts.length; i += 3) {
    rows.push(efforts.slice(i, i + 3).map((effort) => btn(effort, `${ns}:eff:${effort}`)));
  }
  rows.push([btn(tr("Don't set", "Не задавать"), `${ns}:eff:unset`), withKeep ? btn(tr("Keep", "Оставить"), `${ns}:keep`) : cancelRow()[0]]);
  return rows;
}

// {msgId} (опц.) — хендофф из /menu: визард заменяет flow-слот и рисует в ТО ЖЕ сообщение меню.
async function handleModelCmd(chatId, from, { msgId } = {}) {
  const { provider, model, effort } = await currentConfig();
  const st = newWizard(chatId, from, "model");
  st.msgId = msgId ?? null;
  st.step = "intro";
  await wizScreen(st, tr(
    `Now: provider ${provider} · model ${model} · thinking: ${effortLabel(effort)}.`,
    `Сейчас: провайдер ${provider} · модель ${model} · размышления: ${effortLabel(effort)}.`,
  ), [
    [btn(tr("Change", "Сменить"), "iva_model:chg"), btn(tr("Keep", "Оставить"), "iva_model:keep")],
  ]);
}

async function handleThinkCmd(chatId, from, { msgId } = {}) {
  const { provider, model, effort } = await currentConfig();
  const st = newWizard(chatId, from, "think");
  st.msgId = msgId ?? null;
  if (!providerSupportsReasoning(provider)) {
    await endWizard(st, tr(
      `Adjustable thinking is unavailable for ${CATALOG[provider].label}. Choose a reasoning-capable provider via /model.`,
      `Настраиваемые размышления недоступны для ${CATALOG[provider].label}. Выбери провайдера с reasoning через /model.`,
    ), menuRow());
    return;
  }
  const cat = CATALOG[provider];
  const env = await readEnvValues(ENV_PATH);
  st.step = "loading";
  await wizScreen(st, tr(
    `Loading thinking levels for ${model}…`,
    `Загружаю уровни размышлений для ${model}…`,
  ), [cancelRow()]);
  if (!wizardIsCurrent(st)) return;
  const loaded = await runWizardRequest(
    st,
    () => fetchModelOptions(provider, cat.keyVar ? env[cat.keyVar] : undefined, { dataDir: DATA_DIR_ABS }),
  );
  if (loaded.stale) return;
  if (!loaded.ok) return endWizard(st, tr(
    "Couldn't load thinking levels. Send /think to try again.",
    "Не удалось загрузить уровни размышлений. Отправь /think, чтобы попробовать снова.",
  ), menuRow());
  const options = loaded.value;
  const option = options.find((candidate) => candidate.id === model)
    || { id: model, reasoningLevels: providerFallbackReasoningLevels(provider) };
  st.modelOptions = [option];
  st.model = model;
  st.efforts = [...option.reasoningLevels];
  st.step = "effort";
  await wizScreen(st,
    tr(`Thinking level for ${model}: ${effortLabel(effort)}.`, `Уровень размышлений для ${model}: ${effortLabel(effort)}.`),
    effortRows("iva_think", true, st.efforts));
}

async function showProviderScreen(st) {
  st.step = "provider";
  const rows = Object.entries(CATALOG).map(([id, c]) => [btn(c.label, `iva_model:prov:${id}`)]);
  rows.push(cancelRow());
  await wizScreen(st, tr("Pick a provider:", "Выбери провайдера:"), rows);
}

async function pickProvider(st, provider) {
  st.provider = provider;
  const cat = CATALOG[provider];
  if (cat.auth === "oauth") {
    st.step = "loading";
    await wizScreen(st, tr(
      "Checking the OpenAI subscription…",
      "Проверяю подписку OpenAI…",
    ), [cancelRow()]);
    if (!wizardIsCurrent(st)) return;
    // File presence is not enough — a revoked/expired refresh token would let the wizard
    // finish into a config that 401s every turn. getAccessToken refreshes a stale token
    // and throws when there is no usable auth → device-link login.
    const auth = await runWizardRequest(st, () => getAccessToken(DATA_DIR_ABS));
    if (auth.stale) return;
    if (!auth.ok) return startCodexLogin(st);
    return showModelScreen(st);
  }
  const env = await readEnvValues(ENV_PATH);
  if (!wizardIsCurrent(st)) return;
  if (!env[cat.keyVar]) {
    // В группе ключ вводить нельзя (его не удалить) — отказ до установки awaitText.
    if (!isPrivateChat(st)) return refuseSecretInGroup(st);
    // awaitText обобщает старый awaitKey (см. handleControl): диспатчер по pending.awaitText
    // отдаёт следующий текст этому визарду (handleKeyMessage), а не eve.
    st.awaitText = { kind: "apikey", secret: true, data: {} };
    st.step = "awaiting_key";
    await wizScreen(st,
      tr(
        `Need a ${cat.label} API key. Send it in the next message — I'll delete it from the chat right away.\n` +
        "If I don't confirm within a couple of seconds — don't resend, start over with /model.",
        `Нужен API-ключ ${cat.label}. Пришли его следующим сообщением — я сразу удалю его из чата.\n` +
        "Если через пару секунд не подтвержу получение — не отправляй повторно, начни заново с /model.",
      ),
      [cancelRow()]);
    return;
  }
  return showModelScreen(st);
}

async function showModelScreen(st) {
  const cat = CATALOG[st.provider];
  const env = await readEnvValues(ENV_PATH);
  if (!wizardIsCurrent(st)) return;
  st.step = "loading";
  await wizScreen(st, tr(
    `Loading models for ${cat.label}…`,
    `Загружаю модели ${cat.label}…`,
  ), [cancelRow()]);
  if (!wizardIsCurrent(st)) return;
  const loaded = await runWizardRequest(
    st,
    () => fetchModelOptions(st.provider, cat.keyVar ? env[cat.keyVar] : undefined, { dataDir: DATA_DIR_ABS }),
  );
  if (loaded.stale) return;
  if (!loaded.ok) {
    // fetchModelOptions only throws when the live /models probe rejected the stored key (401/403) —
    // re-enter the key flow instead of offering a list the dead key can't use.
    // В группе новый ключ вводить нельзя (его не удалить) — отказ до установки awaitText.
    if (!isPrivateChat(st)) return refuseSecretInGroup(st);
    st.awaitText = { kind: "apikey", secret: true, data: {} };
    st.step = "awaiting_key";
    await wizScreen(st,
      tr(
        `The saved ${cat.label} key was rejected. Send a new key in the next message — I'll delete it from the chat right away.`,
        `Сохранённый ключ ${cat.label} не принят. Пришли новый ключ следующим сообщением — я сразу удалю его из чата.`,
      ),
      [cancelRow()]);
    return;
  }
  const options = loaded.value;
  // Keep the currently configured model selectable even when the live list is long.
  const current = env[cat.modelVar];
  const currentOption = current
    ? options.find((option) => option.id === current)
      || { id: current, reasoningLevels: providerFallbackReasoningLevels(st.provider) }
    : null;
  st.modelOptions = [
    ...(currentOption ? [currentOption] : []),
    ...options.filter((option) => option.id !== current),
  ].slice(0, 30);
  st.step = "models";
  const rows = st.modelOptions.map((option, i) => [btn(option.id, `iva_model:m:${i}`)]);
  rows.push(cancelRow());
  await wizScreen(st, tr(`Model (${cat.label}):`, `Модель (${cat.label}):`), rows);
}

// Codex device-link login. runDeviceCodeLogin polls up to 15 min — deliberately NOT
// awaited, so the getUpdates loop keeps running; the continuation discards itself
// when this state object is no longer the current wizard (cancelled/replaced).
function startCodexLogin(st) {
  st.step = "login";
  // Serialize device-code log lines (link, one-time code) into ordered chat messages.
  let q = Promise.resolve();
  const tlog = (m) => { q = q.then(() => reply(st.chatId, String(m).trim())); };
  runDeviceCodeLogin({ dataDir: DATA_DIR_ABS, lang: getLang(), log: tlog })
    .then(() => {
      // Identity-сверка: flows.get !== st истинно и когда слот заменён (другой /model,
      // /menu), и когда протух по TTL — осиротевшая континуация сама себя отбрасывает.
      if (flows.get(st.chatId, st.userId) !== st) return;
      return showModelScreen(st);
    })
    .catch((e) => {
      if (flows.get(st.chatId, st.userId) !== st) return;
      return endWizard(st, tr(
        "Login failed: " + e.message + "\nSend /model to try again.",
        "Вход не удался: " + e.message + "\nОтправь /model, чтобы попробовать снова.",
      ), menuRow());
    });
  return wizScreen(st, tr(
    "Waiting for the OpenAI subscription login — link and code below. The code lives 15 minutes.",
    "Жду вход по подписке OpenAI — ссылка и код ниже. Код живёт 15 минут.",
  ), [cancelRow()]);
}

// Plain-text message while the wizard awaits an API key. Deleted from the chat FIRST;
// the key value must never reach eve, log(), reply() or any error text.
async function handleKeyMessage(msg, st) {
  const chatId = msg.chat.id;
  const del = await tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
  if (!wizardIsCurrent(st)) return true;
  if (!del.ok) {
    await reply(chatId, tr("Couldn't delete the message with the key — delete it manually.", "Не смог удалить сообщение с ключом — удали его вручную."));
    if (!wizardIsCurrent(st)) return true;
  }
  const key = msg.text.trim();
  // Not key-shaped (whitespace / too short) — most likely an ordinary message typed
  // while the prompt was pending. Don't store it; end the wait so the chat works again.
  if (!/^\S{8,}$/.test(key)) {
    await endWizard(st,
      tr(
        "That doesn't look like an API key — the wait is cleared, I deleted the message just in case.\n" +
        "If it was a question — send it again; come back for a key via /model.",
        "Это не похоже на API-ключ — ожидание снято, сообщение удалил на всякий случай.\n" +
        "Если это был вопрос — отправь его ещё раз; за ключом приходи через /model.",
      ), menuRow());
    return true;
  }
  const cat = CATALOG[st.provider];
  const checked = await runWizardRequest(st, () => checkKey(st.provider, key));
  if (checked.stale) return true;
  if (!checked.ok) {
    await endWizard(st, tr(
      "Couldn't validate the key. Start again with /model.",
      "Не удалось проверить ключ. Начни заново через /model.",
    ), menuRow());
    return true;
  }
  const err = checked.value;
  if (err) {
    await wizScreen(st, tr(`Key rejected (${err}). Send another key or tap «Cancel».`, `Ключ не принят (${err}). Пришли другой ключ или нажми «Отмена».`), [cancelRow()]);
    return true;
  }
  st.awaitText = null;
  await upsertEnv(ENV_PATH, { [cat.keyVar]: key }); // persist immediately — the chat copy is gone
  if (!wizardIsCurrent(st)) return true;
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
  if (!wizardIsCurrent(st)) return;
  let text = tr(`Saved: ${provider} · ${model} · thinking: ${effortLabel(effort)}.`, `Сохранил: ${provider} · ${model} · размышления: ${effortLabel(effort)}.`);
  text += tr("\nRestart the agent to apply?", "\nПерезапустить агента, чтобы применить?");
  st.step = "saved";
  await wizScreen(st, text, [[btn(tr("Restart now", "Перезапустить сейчас"), "iva_model:rs:now"), btn(tr("Later", "Позже"), "iva_model:rs:later")]]);
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
  if (isStaleWizard(st, messageId)) {
    await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: tr("This dialog has expired — send /model again.", "Диалог устарел — отправь /model заново.") });
    return true;
  }
  if (!wizardActionAllowed(st, action)) return true;
  if (action === "keep") {
    await endWizard(st, st.flow === "think" ? tr("Kept the current thinking level.", "Оставил текущий уровень размышлений.") : tr("Kept the current configuration.", "Оставил текущую конфигурацию."), menuRow());
    return true;
  }
  if (action === "cancel") {
    await endWizard(st, tr("Cancelled.", "Отменено."), menuRow());
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
    const option = selectWizardModel(st, action.slice("m:".length));
    if (!option) return true;
    if (option.reasoningLevels.length === 0) {
      st.effort = null;
      try {
        await saveWizard(st);
      } catch (e) {
        if (!wizardIsCurrent(st)) return true;
        await endWizard(st, tr("Couldn't save .env: " + e.message, "Не удалось сохранить .env: " + e.message), menuRow());
        return true;
      }
      if (!wizardIsCurrent(st)) return true;
      await showSaved(st);
      return true;
    }
    st.step = "effort";
    await wizScreen(st,
      tr(`Thinking level for ${option.id}:`, `Уровень размышлений для ${option.id}:`),
      effortRows("iva_model", false, st.efforts));
    return true;
  }
  if (action.startsWith("eff:")) {
    const v = action.slice("eff:".length);
    if (!selectWizardEffort(st, v)) return true;
    try {
      await saveWizard(st);
    } catch (e) {
      if (!wizardIsCurrent(st)) return true;
      await endWizard(st, tr("Couldn't save .env: " + e.message, "Не удалось сохранить .env: " + e.message), menuRow());
      return true;
    }
    if (!wizardIsCurrent(st)) return true;
    await showSaved(st);
    return true;
  }
  if (action === "rs:later") {
    await endWizard(st, tr("Saved. It'll apply after a restart (/restart).", "Сохранил. Применится после перезапуска (/restart)."), menuRow());
    return true;
  }
  if (action === "rs:now") {
    await endWizard(st, tr("Restarting the agent… (~30s). The current conversation resumes after the restart.", "Перезапускаю агента… (~30 сек). Текущий диалог продолжится после перезапуска."), menuRow());
    // Plain restart: a config change is not a recovery — parked
    // conversations in .workflow-data survive and resume under the new model.
    const ok = await sc("restart", "iva.service");
    if (ok) {
      const { provider, model, effort } = await currentConfig();
      await reply(chatId, tr(`Done — the new configuration is active: ${provider} · ${model} · thinking: ${effortLabel(effort)}.`, `Готово — новая конфигурация активна: ${provider} · ${model} · размышления: ${effortLabel(effort)}.`));
    } else {
      await reply(chatId, tr("Couldn't restart (systemctl). Check the service on the server.", "Не удалось перезапустить (systemctl). Проверь сервис на сервере."));
    }
    return true;
  }
  return true;
}

export function resetMessageCopy(cmd, env = process.env, locale = getLang()) {
  const pick = (en, ru) => (locale === "ru" ? ru : en);
  const model = modelSummary(env);
  const context = compactNumber(model.contextWindow);
  return cmd === "/restart"
    ? {
        pending: pick("◇ Restarting Iva", "◇ Перезапускаю Iva"),
        complete: pick(`♻️ Iva restarted\n\nModel: ${model.line}\nUnfinished turn cleared`, `♻️ Iva перезапущена\n\nМодель: ${model.line}\nНезавершённый ход очищен`),
      }
    : {
        pending: pick("◇ Starting a new conversation", "◇ Начинаю новый диалог"),
        complete: pick(`✨ New conversation ready\n\nModel: ${model.line}\nContext cleared · window ${context}`, `✨ Новый диалог готов\n\nМодель: ${model.line}\nКонтекст очищен · окно ${context}`),
      };
}

// Движок /menu: делит session-store (flows) с визардами /model//think. deps — мост отдаёт
// экранам всё нужное (пути, systemctl, доставку в eve, allowlist, хендофф в визарды).
const menu = createMenu({
  flows,
  tg,
  deps: {
    envPath: ENV_PATH,
    dataDir: DATA_DIR,
    root: ROOT,
    sc,
    reply,
    deliver: pacedDeliver, // синтетический deliver дистилляции обязан пейситься, как главный цикл
    log,
    allowed: ALLOWED,
    handleModelCmd,
    handleThinkCmd,
    handleUpdateCheck,
  },
});

// setMyCommands: синее командное меню Telegram из общей таблицы COMMANDS (default=en +
// language_code:"ru"). Идемпотентно, зовётся на каждом старте моста; ошибки нефатальны.
async function registerBotCommands() {
  try {
    await tg("setMyCommands", { commands: botCommands("en") });
    await tg("setMyCommands", { commands: botCommands("ru"), language_code: "ru" });
  } catch (e) {
    log("setMyCommands failed:", e.message);
  }
}

// Delete a message carrying a secret, warning the user if Telegram won't let us — a rejected secret
// must never silently linger in the chat (mirrors the delete-first path in menu.onText).
async function deleteSecretMessage(chatId, messageId) {
  const del = await tg("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => ({ ok: false }));
  if (!del?.ok) {
    await reply(chatId, tr("Couldn't delete your message — please delete it manually.", "Не смог удалить сообщение — удали его вручную.")).catch(() => {});
  }
  return del?.ok === true;
}

// Default I/O for handleAwaitNonText — injectable so the delete→download ordering and the
// "never reaches eve" contract can be unit-tested with mocks.
const nonTextIo = {
  deleteSecret: (chatId, id) => deleteSecretMessage(chatId, id),
  reply: (chatId, text) => reply(chatId, text),
  download: (fileId, max) => downloadTelegramFile(fileId, max),
  // Run the screen's own text handler on downloaded content WITHOUT re-deleting (already deleted).
  deliver: (text, msg, st) => menu.onText({ ...msg, text }, st, { skipDelete: true }),
};

// A non-text message arrived while a menu/wizard awaits a SECRET (the caller gates this to
// secret/file-capable states — a non-secret interview attachment falls through to eve untouched).
// It must never reach eve. For a file-capable prompt (gws client_secret) a document is captured;
// crucially the message is DELETED FIRST, before the download, so the secret doesn't linger in the
// chat for the download's duration. Anything else is deleted with a clear ack telling the user how
// to send it. Always returns true (the update is consumed, not delivered).
export async function handleAwaitNonText(msg, pending, io = nonTextIo) {
  const chatId = msg.chat?.id;
  const a = pending.awaitText;
  const MAX_BYTES = 256 * 1024;
  if (a?.file && msg.document && pending.flow === "menu") {
    if ((msg.document.file_size ?? 0) > MAX_BYTES) {
      await io.deleteSecret(chatId, msg.message_id);
      await io.reply(chatId, tr("That file is too large — paste the contents as text instead.", "Файл слишком большой — вставь содержимое текстом."));
      return true;
    }
    // Delete FIRST, and only proceed once the secret has actually left the chat. If Telegram
    // refused the deletion, deleteSecret already told the user to remove it manually — we must NOT
    // download or deliver a secret that is still visible in the conversation. Consume it either way
    // so it never reaches eve.
    const deleted = await io.deleteSecret(chatId, msg.message_id);
    if (!deleted) return true;
    const content = await io.download(msg.document.file_id, MAX_BYTES);
    if (content == null) {
      await io.reply(chatId, tr("Couldn't read that file — paste the contents as text instead.", "Не смог прочитать файл — вставь содержимое текстом."));
      return true;
    }
    await io.deliver(content, msg, pending); // skipDelete is safe now — the message is confirmed gone
    return true;
  }
  // Secret prompt, but not a capturable file (a photo, or a text-only secret) — delete it so it can't
  // reach eve, and tell the user how to send it instead of dropping it silently.
  await io.deleteSecret(chatId, msg.message_id);
  await io.reply(chatId, a?.file
    ? tr("Send client_secret.json as text or attach the .json file — not a photo.", "Пришли client_secret.json текстом или прикрепи .json-файл — не фото.")
    : tr("Send it as text, please.", "Пришли это, пожалуйста, текстом."));
  return true;
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
    // /menu: тот же принцип consume-on-error — тап меню всегда проглатывается (в eve не уходит).
    if (cq.data.startsWith("iva_menu:")) {
      return menu.onCallback(cq).catch((e) => {
        log("menu callback error:", e.message);
        return true;
      });
    }
  }
  const msg = update.message;
  const text = (msg?.text || "").trim();
  // A pending flow (menu screen or /model wizard) awaiting input claims this user's next message
  // (a key must never reach eve); a command aborts the wait — a silently still-visible prompt would
  // invite pasting the key later, when nothing intercepts it. This runs BEFORE the busy-buffer gate
  // (below), so a capture works even mid-turn. Non-text is intercepted only while awaiting a SECRET
  // (or a file-capable secret): a document/photo could be the secret itself and must not reach eve.
  // A non-secret await (e.g. the memory interview) lets a non-text message fall through unchanged.
  if (msg?.from) {
    const pending = getWizard(msg.chat?.id, String(msg.from.id));
    const a = pending?.awaitText;
    if (a) {
      if (text.startsWith("/")) {
        await endWizard(pending, tr("Cancelled — no longer waiting for input.", "Отменено — ожидание ввода снято.")).catch(() => {});
      } else if (text) {
        if (pending.flow === "menu") {
          // Menu screens own their capture (interview / key intake / gws JSON / ubcred).
          return menu.onText(msg, pending).catch((e) => {
            log("menu capture error:", e.message); // e.message never contains a secret value
            return true;
          });
        }
        // /model wizard key intake — consume the update even on failure (the key must never
        // be re-polled into eve). handleKeyMessage stays the wizard's own handler.
        return handleKeyMessage(msg, pending).catch((e) => {
          log("wizard key error:", e.message); // e.message never contains the key value
          return true;
        });
      } else if (a.secret || a.file) {
        // Non-text while awaiting a secret — never let it reach eve (delete-first inside).
        return handleAwaitNonText(msg, pending).catch((e) => {
          log("menu attachment capture error:", e.message); // never contains the secret value
          return true;
        });
      }
      // else: non-secret await + non-text → fall through so eve handles it normally.
    }
  }
  if (!text.startsWith("/")) return false;
  const cmd = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();
  if (!["/menu", "/help", "/stop", "/usage", "/restart", "/new", "/update", "/model", "/think"].includes(cmd)) return false;
  const from = String(msg?.from?.id ?? "");
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return false; // untrusted — let eve drop it
  const chatId = msg?.chat?.id;
  // /menu — open the nested settings menu (out-of-band; errors consumed, never reach eve).
  if (cmd === "/menu") {
    await menu.open(chatId, from).catch((e) => log("menu error:", e.message));
    return true;
  }
  if (cmd === "/help") {
    await reply(chatId, helpText());
    return true;
  }
  // /stop — interrupt the current turn. Same path as the ⏹ Stop button: we synthesize a
  // callback_query with data "iva_cancel"; the channel resolves sessionId from run-status
  // and resumes eve's cancel hook. Out-of-band so it reaches a busy agent (an ordinary
  // message would be queued by the gate below and never processed).
  if (cmd === "/stop") {
    const key = chatKey(update);
    if (!key || !isRunning(key)) {
      await reply(chatId, tr("Nothing is running right now.", "Сейчас ничего не выполняется."));
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
  // /new retires only this exact Telegram session. /restart does the same first,
  // then restarts the agent process; histories and queues of other chats survive.
  const key = chatKey(update);
  const continuationToken = key
    ? continuationTokenForControl(update, getChatStatus(key), BOT_USER_ID)
    : null;
  const resetCopy = resetMessageCopy(cmd, await readEnvFresh(ENV_PATH));
  const status = await reply(chatId, resetCopy.pending);
  if (!continuationToken || !key) {
    if (status) {
      await edit(
        chatId,
        status.message_id,
        tr(
          "⚠️ I couldn't identify this conversation. In a group, reply /new to Iva's latest message.",
          "⚠️ Не удалось определить этот диалог. В группе ответьте /new на последнее сообщение Iva.",
        ),
      );
    }
    return true;
  }

  try {
    await requestTelegramReset({
      url: RESET_ROUTE,
      secret: SECRET,
      continuationToken,
    });
  } catch (e) {
    log(`scoped reset failed for ${key}:`, e.message);
    if (status) {
      await edit(
        chatId,
        status.message_id,
        tr(
          "⚠️ Couldn't reset this conversation. Nothing else was cleared.",
          "⚠️ Не удалось сбросить этот диалог. Остальные данные не затронуты.",
        ),
      );
    }
    return true;
  }

  try {
    await completeScopedResetState(key, continuationToken, {
      // Group/forum queues are keyed only by chat/topic while Eve sessions also
      // include conversationId. Clearing the shared queue here would lose
      // messages belonging to other group conversation anchors.
      clearQueue: msg?.chat?.type === "private",
    });
  } catch (e) {
    log(`scoped reset cleanup failed for ${key}:`, e.message);
    if (status) {
      await edit(
        chatId,
        status.message_id,
        tr(
          "⚠️ Conversation reset, but local cleanup failed. Send /new again before sending anything else.",
          "⚠️ Диалог сброшен, но локальная очистка не завершилась. Отправьте /new ещё раз до новых сообщений.",
        ),
      );
    }
    return true;
  }

  if (cmd === "/restart" && !(await sc("restart", "iva.service"))) {
    if (status) {
      await edit(
        chatId,
        status.message_id,
        tr(
          "⚠️ Conversation reset, but Iva couldn't restart.",
          "⚠️ Диалог сброшен, но перезапустить Iva не удалось.",
        ),
      );
    }
    return true;
  }
  if (status) await edit(chatId, status.message_id, resetCopy.complete);
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
  await registerBotCommands();

  let { offset, delivered } = await loadOffset();
  if (offset === null) {
    offset = await fastForwardOffset();
    log("first run — offset past the tail of the queue:", offset);
    await saveOffset(offset);
  } else {
    log("starting offset:", offset);
  }

  for (;;) {
    let data;
    try {
      data = await tg("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      }, { timeoutMs: 40_000 }); // above the 30s long-poll window
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
      // Переигровка после краша (Telegram = at-least-once): этот апдейт уже уходил в eve
      // в прошлой жизни процесса — второй раз не доставляем, только двигаем offset.
      if (alreadyDelivered(update.update_id, delivered)) {
        log(`skip update ${update.update_id} — already delivered before restart`);
        offset = update.update_id + 1;
        await saveOffset(offset, delivered);
        continue;
      }
      // Control commands (/restart, /help, /new) — the bridge handles them itself, doesn't send to eve.
      if (await handleControl(update)) {
        offset = update.update_id + 1;
        await saveOffset(offset, delivered);
        continue;
      }
      const key = chatKey(update);
      let drainedKey = null; // чей буфер приклеен к этому апдейту — чистится после доставки
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
          await saveOffset(offset, delivered);
          continue;
        }
        // Idle again: the next fresh message carries the queued ones along. The queue is
        // cleared AFTER successful delivery (below) — clearing it here would lose the
        // buffered messages if the process dies before deliver() succeeds.
        const q = await loadQueue();
        const pending = q[key];
        if (Array.isArray(pending) && pending.length) {
          update.message.iva_buffered = pending;
          drainedKey = key;
        }
      }
      // Don't deliver the next update of the same chat until eve has parked the previous turn
      // (pause measured from the last delivery to this chat) — otherwise a burst → HookConflict.
      // pacedDeliver держит lastDeliverAt на модуль-уровне, общую с deps.deliver меню.
      const accepted = await pacedDeliver(update);
      offset = update.update_id + 1;
      if (accepted) {
        // Порядок персиста: СНАЧАЛА маркер delivered, ПОТОМ очистка буфера. Краш между
        // ними оставляет буфер на месте при уже записанном маркере → на переигровке
        // апдейт пропустится, буфер приклеится к следующему сообщению — дубль возможен,
        // потеря нет. Обратный порядок (буфер раньше маркера) терял бы очередь.
        delivered = update.update_id;
        await saveOffset(offset, delivered);
        if (drainedKey !== null) {
          const q = await loadQueue();
          delete q[drainedKey];
          await saveQueue(q);
        }
      } else {
        // Апдейт выброшен как битый: буфер НЕ трогаем (приклеится к следующему сообщению),
        // маркер не ставим — offset двигаем, чтобы не молоть тот же апдейт.
        await saveOffset(offset, delivered);
      }
    }
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("telegram-poll fatal:", e);
    process.exit(1);
  });
}
