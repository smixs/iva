import { defineDynamic, defineInstructions } from "eve/instructions";

// Динамическая инструкция: каждый турн инжектит текущие дату/время в часовом поясе
// пользователя в системный промпт. Локаль следует за языком агента (AGENT_LANGUAGE).
// Самодостаточна — только eve + node Intl.
const TIMEZONE = process.env.ASSISTANT_TIMEZONE ?? "Asia/Almaty";
const LANG = (process.env.AGENT_LANGUAGE ?? "ru").toLowerCase();
const LOCALE = LANG === "en" ? "en-US" : "ru-RU";

function nowMarkdown(): string {
  const formatted = new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  return LANG === "en"
    ? `Current user date and time: ${formatted}, timezone ${TIMEZONE}.`
    : `Текущая дата и время пользователя: ${formatted}, часовой пояс ${TIMEZONE}.`;
}

export default defineDynamic({
  events: {
    // turn.started — пересчитывается на каждом турне, чтобы время не «застывало».
    "turn.started": () => defineInstructions({ markdown: nowMarkdown() }),
  },
});
