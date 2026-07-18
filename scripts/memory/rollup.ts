// Memory consolidation (DAG): one parameterized script for all periods.
// Run by a systemd timer (see deploy/iva-memory-*.{service,timer}), drives Iva
// via eve/client (like scripts/daily-digest.ts), and posts a report to Telegram for daily/weekly.
//
//   node --env-file=.env scripts/memory/rollup.ts <daily|weekly|monthly|yearly>
//
// Requires: a running agent (eve start) and a vault with processing rules
// (vault/.claude/rules/*-format.md + skills/dbrain-processor). Date is in ASSISTANT_TIMEZONE.
import { Client } from "eve/client";
import { sendTelegramHtml } from "../lib/telegram-send.mjs";

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
const CHAT = process.env.TELEGRAM_DIGEST_CHAT_ID;
const VAULT = process.env.ASSISTANT_VAULT_DIR ?? "vault";
const TZ = process.env.ASSISTANT_TIMEZONE ?? process.env.TZ ?? "UTC";

// daily/weekly reports go to Telegram; monthly/yearly are silent (vault only).
const POST_TO_TELEGRAM: Record<Period, boolean> = {
  daily: true,
  weekly: true,
  monthly: false,
  yearly: false,
};

// Current date in the user's timezone (systemd sets TZ from .env, but we hedge anyway).
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

// We take the target period as COMPLETED: timers fire at the start of a new period
// (daily ≈04:00, weekly on Sun, monthly on the 1st, yearly on Jan 1), so we process
// the PREVIOUS period, not the empty current one (now is the current local date).
function buildPrompt(p: Period, now: string): string {
  const [y, m] = now.split("-").map(Number);
  const yesterday = shiftDate(now, -1);
  const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const prevYear = String(y - 1);

  const intro =
    `You are processing long-term memory (vault: ${VAULT}). It is now ${now} (${TZ}). ` +
    `Work strictly by the vault rules in ${VAULT}/.claude/rules/ and the dbrain-processor skill. ` +
    `Do not invent facts — take them from the source files. `;

  const tail =
    `At the end, return a SHORT report in plain text (no markdown tables): what was created/updated, ` +
    `key topics and links between cards. Only the finished report, with no preamble or reasoning.`;

  switch (p) {
    case "daily":
      return (
        intro +
        `Process the raw transcript of the completed day (${VAULT}/daily/${yesterday}.md): ` +
        `extract entities and create/update autograph cards. Prefer the write_card tool over write_file ` +
        `for cards — it enforces the schema. For each fact choose one operation: ADD (new), ` +
        `SUPERSEDE (contradicts a current value), or NOOP (already known). ` +
        `On SUPERSEDE: REWRITE the card's current value (frontmatter + top description) to the new fact, ` +
        `and move the OLD value to a '## History' section as a dated line (e.g. '- 2026-03→06: TDI Group'). ` +
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
        `Then update ${VAULT}/CORE.md per the .claude/rules/core-format.md rule: refresh permanent ` +
        `facts about the user, preferences, active goals (≤3), and the pointer to the last day (${yesterday}); ` +
        `keep it ≤~1200 characters — compress on overflow, don't bloat. ` +
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
  ...(BEARER ? { auth: { bearer: async () => BEARER } } : {}),
});

const today = localDate();
const session = client.session();
const response = await session.send(buildPrompt(period, today));
const result = await response.result();

// An interactive turn ends with status "waiting" (the session is ready for the next message),
// so we rely on the presence of text rather than a "completed" status.
if (result.status === "failed" || !result.message) {
  console.error(`rollup ${period}: agent returned no report (status=${result.status})`);
  process.exit(1);
}

console.log(`rollup ${period} (${today}):\n${result.message}`);

// Telegram report only for daily/weekly.
if (POST_TO_TELEGRAM[period]) {
  if (!BOT || !CHAT) {
    console.error(
      `rollup ${period}: no TELEGRAM_BOT_TOKEN/TELEGRAM_DIGEST_CHAT_ID — report not sent`,
    );
    process.exit(1);
  }
  // markdown → Telegram-HTML conversion + self-heal live in a shared helper.
  const r = await sendTelegramHtml(BOT, CHAT, result.message);
  if (r.fellBack) {
    // HTML didn't parse — the report went out flat. Give the agent feedback in the same
    // session so it formats the next report more simply (one turn, no resend).
    await session.send(
      `The last report failed Telegram parse_mode=HTML (${r.error}) and went out as flat text. ` +
        "Next time format it more simply: **bold**, `code`, lists — no raw HTML.",
    );
  }
  if (!r.ok) {
    console.error(`rollup ${period}: Telegram send failed:`, r.error);
    process.exit(1);
  }
  console.log(`rollup ${period}: report sent to Telegram.`);
}

process.exit(0);
