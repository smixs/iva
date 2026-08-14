// Rollup: one parameterized script for all periods (daily → weekly → monthly → yearly).
// Run by the in-process eve schedules in agent/schedules/memory-*.ts, drives Iva
// via eve/client (like scripts/daily-digest.ts), and posts a report to Telegram for daily/weekly.
//
//   node --env-file=.env scripts/memory/rollup.ts <daily|weekly|monthly|yearly>
//
// Requires: a running agent (eve start) and a vault to write into. The processing rules
// (scripts/memory/instructions/) ship with the repo. Date is in ASSISTANT_TIMEZONE.
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type MessageResult, type SessionState } from "eve/client";
import { CORE_CAP } from "#lib/core-cap.ts";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
import { tr } from "#lib/i18n.ts";
import { readSettings } from "#lib/settings.ts";
import {
  deliverMemoryReport,
  memoryReportTail,
  memoryReportsEnabled,
  rollupRanBefore,
} from "../lib/notice-policy.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import {
  cancelTurnAndConfirmQuietly,
  canRetryFresh,
  cancelTurnQuietly,
  resolveTurnTimeoutMs,
  withTurnTimeout,
} from "../lib/rollup-turn.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";

type Period = "daily" | "weekly" | "monthly" | "yearly";

const PERIODS: readonly Period[] = ["daily", "weekly", "monthly", "yearly"];
// process.argv: [node, script, <period>] — the period is the first CLI argument.
const period = process.argv[2] as Period | undefined;

if (!period || !PERIODS.includes(period)) {
  console.error(`Usage: rollup.ts <${PERIODS.join("|")}>`);
  process.exit(1);
}

const PORT = process.env.IVA_PORT ?? "8723";
const HOST = process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`;
const BEARER = process.env.ASSISTANT_BEARER; // needed if the prod eve channel requires auth
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = notificationChat();
const VAULT = process.env.ASSISTANT_VAULT_DIR ?? "vault";
const TZ = process.env.ASSISTANT_TIMEZONE ?? process.env.TZ ?? "UTC";
// Format rules and the memory-processor prompts live in the repo, not in the vault: they
// are product, and must update with it instead of rotting inside every user's vault.
// Absolute, so the agent can read them whatever its working directory is.
const INSTRUCTIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "instructions",
);

// daily/weekly may carry a Report to Telegram; monthly/yearly are silent by design (vault
// only). Whether the Report actually goes out is the owner's switch, read at the end of the
// run — a toggle flipped tonight applies tonight, with no restart (ADR-0007).
const REPORTS_TO_TELEGRAM: Record<Period, boolean> = {
  daily: true,
  weekly: true,
  monthly: false,
  yearly: false,
};

// Current date in the user's timezone (iva.service sets TZ from .env, but we hedge anyway).
function localDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Shift an ISO date (YYYY-MM-DD) by N days; arithmetic in UTC, no DST edge cases.
function shiftDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

// We take the target period as COMPLETED: schedules fire at the start of a new period
// (daily ≈04:00, weekly on Mon, monthly on the 1st, yearly on Jan 1), so we process
// the PREVIOUS period, not the empty current one (now is the current local date).
function buildPrompt(p: Period, now: string): string {
  const [y, m] = now.split("-").map(Number);
  const yesterday = shiftDate(now, -1);
  const prevMonth =
    m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const prevYear = String(y - 1);

  const intro =
    `You are processing long-term memory (vault: ${VAULT}). It is now ${now} (${TZ}). ` +
    `Work strictly by the format rules in ${INSTRUCTIONS}/rules/ and the memory-processor ` +
    `instructions in ${INSTRUCTIONS}/memory-processor/. ` +
    `Do not invent facts — take them from the source files. `;

  // Delivery half of the prompt: language, human wording, no self-delivery. Built per call,
  // so a language switched in /menu applies to the next night without a restart.
  const tail = memoryReportTail(tr);

  switch (p) {
    case "daily":
      return (
        intro +
        `Process the raw transcript of the completed day (${VAULT}/daily/${yesterday}.md): ` +
        `extract entities and create/update autograph cards. Prefer the write_card tool over write_file ` +
        `for cards — it enforces the schema. For each fact choose one operation: ADD (new), ` +
        `UPDATE (existing subject, compatible new fact), SUPERSEDE (contradicts a current value), ` +
        `or NOOP (already known). Pass history_entry only for SUPERSEDE, never for ADD, UPDATE, or NOOP. ` +
        `On SUPERSEDE: REWRITE the card's current value (frontmatter + top description) to the new fact ` +
        `and pass the OLD value through history_entry as a single dated line ` +
        `'YYYY-MM-DD: fact' (e.g. '2026-07-31: TDI Group (held 2026-03→06)') — the fact's own date, ` +
        `not today's; write_card owns the '## History' section. ` +
        `A card 'body' is facts only, with no H1/H2 headings: write_card builds the card ` +
        `structure itself (the title, '## Log', '## Related', '## History') and refuses a body ` +
        `that carries a heading of its own. ` +
        `Never leave two contradictory CURRENT values; History is append-only, never edited. ` +
        `Tag each fact's certainty with 'confidence:' — EXTRACTED (user stated it directly) or ` +
        `INFERRED (you deduced it). ` +
        `Emotional venting and momentary states ("I'm useless", "wasted the whole day", tiredness, ` +
        `frustration) are NEVER identity-level facts: never put them into CORE or entity cards. ` +
        `At most mention them as a dated mood line in the daily-summary, or — only if clearly worth ` +
        `keeping — a note card with status: archived. ` +
        `First read ${VAULT}/.graph/supersede-candidates.json (the deterministic conflict scan) and ` +
        `resolve every listed same-entity conflict by superseding the stale card. ` +
        `Then assemble a daily-summary for ${yesterday} with the day's topics and MOC links down to the cards ` +
        `and to the raw transcript daily/${yesterday}.md. ` +
        `Then update ${VAULT}/CORE.md per the ${INSTRUCTIONS}/rules/core-format.md rule: refresh permanent ` +
        `facts about the user, preferences, active goals (≤3), and the pointer to the last day (${yesterday}); ` +
        `keep it ≤~${CORE_CAP} characters — compress on overflow, don't bloat. ` +
        `Separately, reflect on the day's interactions: for each notable exchange judge the outcome — ` +
        `useful, dead_end, or corrected (user corrected you, asked again, or was dissatisfied). ` +
        `When a corrected/dead_end outcome reveals a REPEATABLE behavioral lesson (not a one-off fix), ` +
        `add/refine ONE dated line in the CORE Preferences section (e.g. '- 2026-07: отвечать короче, ` +
        `без преамбул') so you don't repeat it. Keep lessons recency-ordered, drop the stalest when the ` +
        `section grows; a lesson consistently honored for weeks can be dropped. Skip this whole step if ` +
        `the day held no corrections (no-op — don't invent lessons). ` +
        tail
      );
    case "weekly":
      return (
        intro +
        `Assemble a weekly-summary for the completed week (7 days ending ${yesterday}): ` +
        `read the daily-summaries of those 7 days, pull out cross-cutting topics and the week's takeaways, ` +
        `create a weekly-summary with MOC links down to those daily-summaries. ` +
        tail
      );
    case "monthly":
      return (
        intro +
        `Assemble a monthly-summary for the completed month ${prevMonth}: ` +
        `read the weekly-summaries of month ${prevMonth}, pull out the main topics and the month's takeaways, ` +
        `create a monthly-summary with MOC links down to the weekly summaries. ` +
        tail
      );
    case "yearly":
      return (
        intro +
        `Assemble a yearly-summary for the completed year ${prevYear}: ` +
        `read the monthly-summaries of year ${prevYear}, pull out the main topics and the year's takeaways, ` +
        `create a yearly-summary with MOC links down to the monthly summaries. ` +
        tail
      );
  }
}

const client = new Client({
  host: HOST,
  ...(BEARER ? { auth: { bearer: () => Promise.resolve(BEARER) } } : {}),
});

// Session REUSE, not a fresh session per night. eve backs every client session with a
// workflowEntry run in .eve/.workflow-data that nothing ever closes (the client API has
// no delete), so a fresh session per rollup leaked one forever-"running" run per night
// and eve re-enqueued the whole pile on every start. One persistent session per period
// caps that at one run. Rotation is deliberately RARE (90d): every rotation abandons one
// run in the store (nothing can close it), so frequent rotation would just re-create the
// leak. Abandoned sessions are logged to data/rollup-abandoned.jsonl for the record;
// `iva reset` clears them together with the store. Parked cursor lives in data/.
const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";
const SESSION_FILE = join(DATA_DIR, `rollup-session-${period}.json`);
const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;
// Did a rollup ever run on this installation? Read here, before this run leaves traces of
// its own, and read from every trace at once (cursors of all four periods, the schedule
// status file, daily summaries in the vault) — a single cursor is not enough, dropHungSession
// deletes it. It separates an installation that used to get the morning report from a fresh
// one, which has nothing to miss and must hear nothing. Best-effort by design: ADR-0007.
const RAN_BEFORE = rollupRanBefore(DATA_DIR, VAULT);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSessionState(value: unknown): value is SessionState {
  if (!isRecord(value)) return false;
  return (
    typeof value.streamIndex === "number" &&
    Number.isFinite(value.streamIndex) &&
    (value.sessionId === undefined || typeof value.sessionId === "string") &&
    (value.continuationToken === undefined ||
      typeof value.continuationToken === "string")
  );
}

function loadSession(): { state: SessionState; createdAt: number } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    if (!isRecord(parsed) || !isSessionState(parsed.state)) return null;
    const createdAt =
      typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt)
        ? parsed.createdAt
        : 0;
    if (Date.now() - createdAt > SESSION_TTL_MS) {
      logAbandoned(parsed.state, "ttl-rotation");
      return null;
    }
    return { state: parsed.state, createdAt };
  } catch {
    return null;
  }
}

// Курсор сессии не должен превращаться в полфайла: следующий прогон прочитал бы
// огрызок и бросил бы недособранную память.
function saveSession(state: SessionState, createdAt: number): void {
  writeFileAtomicSync(SESSION_FILE, JSON.stringify({ state, createdAt }));
}

// Брошенные сессии (ротация/несовместимый курсор) — в журнал: их run-обёртки остаются
// в сторе до ближайшего `iva reset`, и по журналу видно, чьи они.
function logAbandoned(state: SessionState, reason: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(
      join(DATA_DIR, "rollup-abandoned.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        period,
        reason,
        sessionId: state.sessionId ?? null,
      }) + "\n",
      "utf8",
    );
  } catch {
    /* журнал не должен ронять ночь */
  }
}

// Ход целиком (send + result) под таймаутом: резюм припаркованной сессии после рестарта
// сервера умеет виснуть молча (#104), и без гонки с таймером ночь просто не заканчивается.
const TURN_TIMEOUT_MS = resolveTurnTimeoutMs(
  process.env.ROLLUP_TURN_TIMEOUT_MS,
  {
    warn: (message) => console.error(`rollup ${period}: ${message}`),
  },
);
const guardedTurn = (
  session: ReturnType<typeof client.session>,
  prompt: string,
  label: string,
  onAccepted: (result: Promise<MessageResult>) => void = () => {},
  onSendRejected: () => void = () => {},
) =>
  withTurnTimeout(
    async () => {
      let response;
      try {
        response = await session.send(prompt);
      } catch (error) {
        onSendRejected();
        throw error;
      }
      const result = response.result();
      onAccepted(result);
      return await result;
    },
    { timeoutMs: TURN_TIMEOUT_MS, label },
  );

// Зависший ход на сервере не останавливается сам, а его курсор в SESSION_FILE описывает
// недочитанный ход: следующая ночь резюмнулась бы об него и повисла снова. Поэтому ход
// гасим, сессию помечаем брошенной и выбрасываем курсор — завтра стартуем со свежей.
async function dropHungSession(label: string): Promise<void> {
  await cancelTurnQuietly(session);
  logAbandoned(session.state, `${label}-timeout`);
  try {
    rmSync(SESSION_FILE, { force: true });
  } catch {
    /* курсор — кэш, его потеря не должна ронять ночь */
  }
}

const today = localDate();
const saved = loadSession();
let sessionCreatedAt = saved?.createdAt ?? Date.now();
let session = saved ? client.session(saved.state) : client.session();
let result;
let accepted = false;
let sendRejected = false;
let acceptedTurnResult: Promise<MessageResult> | undefined;
try {
  result = await guardedTurn(
    session,
    buildPrompt(period, today),
    "main-turn",
    (turnResult) => {
      accepted = true;
      acceptedTurnResult = turnResult;
    },
    () => {
      sendRejected = true;
    },
  );
} catch (e) {
  // The parked session may be gone (iva reset quarantined the store) or hung on resume —
  // fall back to a fresh one once only after proving the old turn cannot keep writing.
  const hung = (e as { code?: string }).code === "ROLLUP_TURN_TIMEOUT";
  // Выход наверх роняет процесс и отпускает .memory.lock, а зависший ход продолжает писать
  // в vault — уже без всякой защиты от параллельного роллапа. Гасим и на терминальных путях.
  if (!saved) {
    if (hung) await cancelTurnQuietly(session);
    throw e;
  }
  // Принятый ход и зависший send могли продолжить писать после локального таймаута. Перед retry
  // оба требуют терминального подтверждения: no_active_turn либо turn.cancelled в дочитанном
  // потоке. Успешный ответ cancel со статусом accepted сам по себе второго писателя не разрешает.
  const cancelConfirmed =
    accepted || hung
      ? await cancelTurnAndConfirmQuietly(session, acceptedTurnResult)
      : false;
  if (!canRetryFresh({ accepted, sendRejected, cancelConfirmed })) {
    console.error(
      `rollup ${period}: could not confirm cancellation of the unresolved turn — refusing fresh retry`,
    );
    logAbandoned(saved.state, "cancel-unconfirmed");
    throw e;
  }
  console.error(
    `rollup ${period}: parked session ${hung ? "hung" : "unusable"} (${(e as Error).message}) — starting fresh`,
  );
  logAbandoned(saved.state, hung ? "resume-timeout" : "unusable-cursor");
  session = client.session();
  sessionCreatedAt = Date.now();
  // Ровно одна попытка: второй сбой уходит наверх и роняет юнит с ненулевым кодом.
  try {
    result = await guardedTurn(
      session,
      buildPrompt(period, today),
      "main-turn",
    );
  } catch (retryError) {
    if ((retryError as { code?: string }).code === "ROLLUP_TURN_TIMEOUT")
      await cancelTurnQuietly(session);
    throw retryError;
  }
}
saveSession(session.state, sessionCreatedAt);

// An interactive turn ends with status "waiting" (the session is ready for the next message),
// so we rely on the presence of text rather than a "completed" status.
if (result.status === "failed" || !result.message) {
  console.error(
    `rollup ${period}: agent returned no report (status=${result.status})`,
  );
  process.exit(1);
}

// Daily is the only rollup that updates CORE. Verify the actual file, not just the turn
// status: one same-session correction is allowed, then fail loudly and leave brain as
// the deterministic 05:00 backstop.
if (period === "daily") {
  const corePath = join(VAULT, "CORE.md");
  let core = readFileSync(corePath, "utf8");
  if (core.length > CORE_CAP) {
    const oldLength = core.length;
    console.error(
      `rollup daily: CORE.md still exceeds the cap (${oldLength}/${CORE_CAP}); requesting one correction`,
    );
    // Таймаут здесь не заводит новую сессию: это просто «коррекция не удалась» — файл
    // перечитывается как есть, и дальше срабатывает существующая проверка капа.
    try {
      await guardedTurn(
        session,
        `Re-open ${corePath}: it is ${oldLength} characters, above the hard ${CORE_CAP}-character cap. ` +
          "Compress it now per the core-format rule. Preserve every heading and the Pointers/Указатели " +
          "section; remove stale Preferences/Предпочтения first. Do not return until the file itself is within the cap.",
        "core-correction",
      );
      saveSession(session.state, sessionCreatedAt);
    } catch (e) {
      console.error(
        `rollup daily: CORE.md correction turn failed (${(e as Error).message})`,
      );
      if ((e as { code?: string }).code === "ROLLUP_TURN_TIMEOUT")
        await dropHungSession("core-correction");
    }
    core = readFileSync(corePath, "utf8");
    if (core.length > CORE_CAP) {
      console.error(
        `rollup daily: CORE.md remains over cap after one correction (${core.length}/${CORE_CAP}); ` +
          "brain will clamp it at 05:00",
      );
      process.exit(1);
    }
    console.log(
      `rollup daily: CORE.md compressed ${oldLength} → ${core.length} chars`,
    );
  }
}

console.log(`rollup ${period} (${today}):\n${result.message}`);

// Telegram report only for daily/weekly, and only when the owner turned Reports on. What
// leaves the chat is one decision, taken in the policy module and proven there by test:
// the report, or — once in the life of an installation that used to get it — the notice
// that reports are now off. Never both, never twice.
if (REPORTS_TO_TELEGRAM[period]) {
  const settings = readSettings();
  // markdown → Telegram-HTML conversion, chunking, the outbound Gate and the self-heal all
  // live in the shared seam. No token or chat means no seam — and the policy still decides
  // the one-time notice, so a chat configured later cannot revive a question already closed.
  const send =
    BOT && CHAT
      ? {
          report: (text: string) => sendTelegramHtml(BOT, CHAT, text),
          notice: (text: string) => sendTelegramHtml(BOT, CHAT, text),
        }
      : null;
  if (!send && memoryReportsEnabled(settings)) {
    console.error(
      `rollup ${period}: no TELEGRAM_BOT_TOKEN/TELEGRAM_DIGEST_CHAT_ID — report not sent`,
    );
    process.exit(1);
  }
  const delivery = await deliverMemoryReport({
    dataDir: DATA_DIR,
    settings,
    ranBefore: RAN_BEFORE,
    report: result.message,
    tr,
    send,
  });
  if (delivery.status === "off") {
    if (delivery.notice === "sent")
      console.log(`rollup ${period}: told the chat that reports are now off`);
    if (delivery.notice === "failed")
      console.error(
        `rollup ${period}: could not deliver the reports-off notice`,
      );
    console.log(
      `rollup ${period}: memory reports are off — the report stays in the log`,
    );
    process.exit(0);
  }
  const r = delivery;
  if (r.fellBack) {
    // HTML didn't parse — the report went out flat. Give the agent feedback in the same
    // session so it formats the next report more simply (one turn, no resend).
    // ВАЖНО: дождаться конца хода и пересохранить курсор — иначе следующий ночной send
    // поедет со старым continuation-токеном недочитанного хода.
    // Best-effort ход: отчёт уже доставлен, поэтому сбой или таймаут здесь только логируем —
    // ронять из-за подсказки о форматировании всю ночь незачем.
    try {
      await guardedTurn(
        session,
        `The last report failed Telegram parse_mode=HTML (${r.error}) and went out as flat text. ` +
          "Next time format it more simply: **bold**, `code`, lists — no raw HTML.",
        "format-feedback",
      );
      saveSession(session.state, sessionCreatedAt);
    } catch (e) {
      console.error(
        `rollup ${period}: format-feedback turn failed (${(e as Error).message})`,
      );
      if ((e as { code?: string }).code === "ROLLUP_TURN_TIMEOUT")
        await dropHungSession("format-feedback");
    }
  }
  if (r.status === "failed") {
    console.error(`rollup ${period}: Telegram send failed:`, r.error);
    process.exit(1);
  }
  console.log(`rollup ${period}: report sent to Telegram.`);
}

process.exit(0);
