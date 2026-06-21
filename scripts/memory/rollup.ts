// Консолидация памяти (DAG): один параметризованный скрипт для всех периодов.
// Запускается systemd-таймером (см. deploy/iva-memory-*.{service,timer}), драйвит Iva
// через eve/client (как scripts/daily-digest.ts), и для daily/weekly шлёт отчёт в Telegram.
//
//   node --env-file=.env scripts/memory/rollup.ts <daily|weekly|monthly|yearly>
//
// Требует: запущенный агент (eve start) и vault с правилами обработки
// (vault/.claude/rules/*-format.md + skills/dbrain-processor). Дата — в ASSISTANT_TIMEZONE.
import { Client } from "eve/client";

type Period = "daily" | "weekly" | "monthly" | "yearly";

const PERIODS: readonly Period[] = ["daily", "weekly", "monthly", "yearly"];
// process.argv: [node, script, <period>] — период это первый CLI-аргумент.
const period = process.argv[2] as Period | undefined;

if (!period || !PERIODS.includes(period)) {
  console.error(`Использование: rollup.ts <${PERIODS.join("|")}>`);
  process.exit(1);
}

const PORT = process.env.IVA_PORT ?? "8723";
const HOST = process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`;
const BEARER = process.env.ASSISTANT_BEARER; // нужен, если eve-канал в проде требует auth
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_DIGEST_CHAT_ID;
const VAULT = process.env.ASSISTANT_VAULT_DIR ?? "vault";
const TZ = process.env.ASSISTANT_TIMEZONE ?? process.env.TZ ?? "UTC";

// daily/weekly отчёты уходят в Telegram; monthly/yearly — тихие (только в vault).
const POST_TO_TELEGRAM: Record<Period, boolean> = {
  daily: true,
  weekly: true,
  monthly: false,
  yearly: false,
};

// Текущая дата в часовом поясе пользователя (systemd ставит TZ из .env, но подстрахуемся).
function localDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Сдвиг ISO-даты (YYYY-MM-DD) на N дней; арифметика в UTC, без DST-краёв.
function shiftDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

// Целевой период берём ЗАВЕРШЁННЫМ: таймеры срабатывают в начале нового периода
// (daily ≈04:00, weekly в Вс, monthly 1-го, yearly 1 янв), поэтому обрабатываем
// ПРЕДЫДУЩИЙ период, а не пустой текущий (now — текущая локальная дата).
function buildPrompt(p: Period, now: string): string {
  const [y, m] = now.split("-").map(Number);
  const yesterday = shiftDate(now, -1);
  const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const prevYear = String(y - 1);

  const intro =
    `Ты обрабатываешь долговременную память (vault: ${VAULT}). Сейчас ${now} (${TZ}). ` +
    `Работай строго по правилам vault в ${VAULT}/.claude/rules/ и скиллу dbrain-processor. ` +
    `Не выдумывай факты — бери их из исходных файлов. `;

  const tail =
    `В конце верни КОРОТКИЙ отчёт обычным текстом (без markdown-таблиц): что создано/обновлено, ` +
    `ключевые темы и ссылки между карточками. Только готовый отчёт, без вступлений и рассуждений.`;

  switch (p) {
    case "daily":
      return (
        intro +
        `Обработай сырой транскрипт за завершившийся день (${VAULT}/daily/${yesterday}.md): ` +
        `извлеки сущности и создай/обнови карточки autograph, ` +
        `затем собери daily-summary за ${yesterday} с темами дня и MOC-ссылками вниз на карточки ` +
        `и на сырой транскрипт daily/${yesterday}.md. ` +
        `Затем обнови ${VAULT}/CORE.md по правилу .claude/rules/core-format.md: актуализируй постоянные ` +
        `факты о пользователе, предпочтения, активные цели (≤3) и указатель на последний день (${yesterday}); ` +
        `держи ≤~1200 символов — при переполнении ужми, не раздувай. ` +
        tail
      );
    case "weekly":
      return (
        intro +
        `Собери weekly-summary за завершившуюся неделю (7 дней, заканчивающихся ${yesterday}): ` +
        `прочитай daily-summary этих 7 дней, выдели сквозные темы и итоги недели, ` +
        `создай weekly-summary с MOC-ссылками вниз на эти daily-summary. ` +
        tail
      );
    case "monthly":
      return (
        intro +
        `Собери monthly-summary за завершившийся месяц ${prevMonth}: ` +
        `прочитай weekly-summary месяца ${prevMonth}, выдели главные темы и итоги месяца, ` +
        `создай monthly-summary с MOC-ссылками вниз на недельные саммари. ` +
        tail
      );
    case "yearly":
      return (
        intro +
        `Собери yearly-summary за завершившийся год ${prevYear}: ` +
        `прочитай monthly-summary года ${prevYear}, выдели главные темы и итоги года, ` +
        `создай yearly-summary с MOC-ссылками вниз на месячные саммари. ` +
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

// Интерактивный ход завершается статусом "waiting" (сессия готова к следующему сообщению),
// поэтому ориентируемся на наличие текста, а не на статус "completed".
if (result.status === "failed" || !result.message) {
  console.error(`rollup ${period}: агент не вернул отчёт (status=${result.status})`);
  process.exit(1);
}

console.log(`rollup ${period} (${today}):\n${result.message}`);

// Отчёт в Telegram только для daily/weekly.
if (POST_TO_TELEGRAM[period]) {
  if (!BOT || !CHAT) {
    console.error(
      `rollup ${period}: нет TELEGRAM_BOT_TOKEN/TELEGRAM_DIGEST_CHAT_ID — отчёт не отправлен`,
    );
    process.exit(1);
  }
  const res = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text: result.message }),
  });
  if (!res.ok) {
    console.error("Telegram sendMessage failed:", res.status, await res.text());
    process.exit(1);
  }
  console.log(`rollup ${period}: отчёт отправлен в Telegram.`);
}

process.exit(0);
