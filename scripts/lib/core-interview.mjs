// Контент-слот интервью core memory для экрана «Память» (scripts/lib/menu/core.mjs).
// Три вещи: список вопросов (двуязычно), запись сырых ответов в vault и сборка
// синтетического сообщения, которым мост отдаёт ответы иве на дистилляцию.
//
// РАЗДЕЛЕНИЕ ОТВЕТСТВЕННОСТИ: тут НЕТ никакой «дистилляции» и НЕ трогаем vault/CORE.md.
// saveInterview кладёт только сырой архив (полные ответы никогда не теряются), а ужать
// их в ядро (лимит 1200 симв. — MAX_CHARS из agent/instructions/20-core.ts) должна сама
// ива своими write-инструментами, получив buildDistillMessage. Так лимит и «не выдумывай»
// остаются заботой модели, а мост не знает про формат ядра.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Шесть тем ядра памяти (см. план: обращение · занятие · город/ритм · люди/контекст ·
// приоритеты · антипаттерны). Вопросы-приглашения к свободному тексту, оба языка рядом —
// экран берёт нужный по getLang(). id стабильны: попадают в архив и удобны для тестов.
export const INTERVIEW = [
  {
    id: "address",
    text: {
      en: "How should I address you — your name, and would you prefer a casual or a more formal tone?",
      ru: "Как к тебе обращаться? Имя и на «ты» или на «вы».",
    },
  },
  {
    id: "occupation",
    text: {
      en: "What do you do? Your work, projects, the role you play.",
      ru: "Чем ты занимаешься? Работа, проекты, роль.",
    },
  },
  {
    id: "location",
    text: {
      en: "Where are you and how is your day shaped — city, timezone, when you're usually around?",
      ru: "Где ты и как устроен день? Город, часовой пояс, ритм — когда обычно на связи.",
    },
  },
  {
    id: "people",
    text: {
      en: "Who and what matters in your world — close people, colleagues, companies, topics that keep coming up?",
      ru: "Кто и что важно в твоём контексте? Близкие, коллеги, компании, темы, что всплывают часто.",
    },
  },
  {
    id: "priorities",
    text: {
      en: "What are your priorities right now — what matters most to move forward on soon?",
      ru: "Какие у тебя сейчас приоритеты? Над чем важнее всего продвигаться в ближайшее время.",
    },
  },
  {
    id: "dislikes",
    text: {
      en: "What annoys you about assistants, and what should I never do — style, habits, boundaries?",
      ru: "Что бесит в ассистентах и чего точно не делать? Стиль, привычки, границы.",
    },
  },
];

// Пусто/скип показываем прочерком, чтобы архив читался и не рвал разметку.
const orDash = (v) => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s === "" ? "—" : s;
};

// Сырой архив интервью в <vaultDir>/core-interview.md: полная копия ответов с датой,
// ПЕРЕЗАПИСЬ (одно интервью на юзера, прошлое не копим — актуально то, что сказали сейчас).
// vaultDir приходит явным параметром (ASSISTANT_VAULT_DIR ?? "vault" считает вызывающий),
// поэтому в тестах сюда легко подсунуть tmp-каталог. Возвращает путь записанного файла.
export async function saveInterview(vaultDir, qa) {
  const items = Array.isArray(qa) ? qa : [];
  const stamp = new Date().toISOString(); // машинная дата в UTC — архив не для глаз, для ивы
  const body = items
    .map((item) => `## ${orDash(item?.q)}\n\n${orDash(item?.a)}`)
    .join("\n\n");
  const md = `# Core interview — ${stamp}\n\n${body}\n`;
  await mkdir(vaultDir, { recursive: true });
  const file = join(vaultDir, "core-interview.md");
  await writeFile(file, md, "utf8");
  return file;
}

// Синтетическое сообщение «от имени юзера»: мост шлёт его иве вместо реального текста,
// чтобы она сама сжала ответы в ядро. Вежливо, коротко, с ЯВНЫМ «ничего не выдумывай»
// и упоминанием лимита 1200 (тот же MAX_CHARS, что режет 20-core.ts). lang: "ru"|"en",
// незнакомое значение → русский (дефолт канала).
export function buildDistillMessage(qa, lang) {
  const items = Array.isArray(qa) ? qa : [];
  const ru = lang !== "en";
  const block = items
    .map((item, i) => `${i + 1}. ${orDash(item?.q)}\n— ${orDash(item?.a)}`)
    .join("\n\n");
  if (ru) {
    return [
      "[Настройка core memory]",
      "",
      "Ниже мои ответы о себе. Сожми их в ядро памяти и обнови файл vault/CORE.md своими инструментами (лимит 1200 символов).",
      "Опирайся только на мои ответы — ничего не выдумывай и не додумывай. Когда обновишь ядро, кратко подтверди.",
      "",
      block,
    ].join("\n");
  }
  return [
    "[Core memory setup]",
    "",
    "Below are my answers about myself. Distill them into the memory core and update the file vault/CORE.md with your own tools (1200-character limit).",
    "Rely only on my answers — don't make anything up or add extra. Once the core is updated, confirm briefly.",
    "",
    block,
  ].join("\n");
}
