import { defineDynamic, defineInstructions } from "eve/instructions";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Язык ответов агента следует за настройкой интерфейса в /menu: кнопка пишет
// data/settings.json на лету, поэтому язык модели пересчитывается КАЖДЫЙ турн, а не
// захватывается на загрузке модуля (иначе замёрзнет до рестарта). Раньше это была
// статическая defineInstructions с env, снятым один раз; теперь defineDynamic на
// turn.started, как в 20-core.ts. Персона в instructions.md остаётся языково-нейтральной —
// это по-прежнему единственный источник правды о языке вывода.
//
// Разрешение языка продублировано инлайн, а НЕ импортом scripts/lib/i18n.mjs:
// инструкции самодостаточны — только eve + node fs/path (гоча eve 0.11.4: authored-
// модули проекта тут не резолвятся при сборке).
const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";

// settings.language ("ru"|"en") → env AGENT_LANGUAGE → "ru". Путь относителен cwd
// (readFileSync резолвит от process.cwd(); iva.service стартует с WorkingDirectory=
// /home/shima/iva), как VAULT в 20-core.ts. Нет файла / битый JSON / чужое значение —
// молча падаем в env-фолбэк.
function resolveLang(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(DATA_DIR, "settings.json"), "utf8"));
    const language = parsed?.language;
    if (language === "ru" || language === "en") return language;
  } catch {
    // нет файла (меню ни разу не меняло язык) / нет доступа / битый JSON.
  }
  return process.env.AGENT_LANGUAGE === "en" ? "en" : "ru";
}

function languageMarkdown(): string {
  const rule =
    resolveLang() === "en"
      ? "Reply in English by default. If the user writes to you in another language, match theirs."
      : "Отвечай по-русски по умолчанию. Если пользователь пишет на другом языке — подстройся под него.";
  return `## Язык / Language\n${rule}`;
}

export default defineDynamic({
  events: {
    // turn.started — перечитывается каждый турн, чтобы смена языка в /menu применялась
    // со следующего сообщения без рестарта.
    "turn.started": () => defineInstructions({ markdown: languageMarkdown() }),
  },
});
