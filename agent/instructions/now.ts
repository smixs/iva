import { defineDynamic, defineInstructions } from "eve/instructions";

// Динамическая инструкция: каждый турн инжектит текущие дату/время в часовом поясе
// пользователя в системный промпт. Самодостаточна — только eve + node Intl.
const TIMEZONE = process.env.ASSISTANT_TIMEZONE ?? "Asia/Almaty";

function nowMarkdown(): string {
  const formatted = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  return `Текущая дата и время пользователя: ${formatted}, часовой пояс ${TIMEZONE}.`;
}

export default defineDynamic({
  events: {
    // turn.started — пересчитывается на каждом турне, чтобы время не «застывало».
    "turn.started": () => defineInstructions({ markdown: nowMarkdown() }),
  },
});
