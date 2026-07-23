// Экран «Характер» меню (/menu → 🎭). Тест характера про ЖЕЛАЕМУЮ иву: интро-предупреждение
// → 10 вопросов кнопками (да/скорее да/скорее нет/нет) → детерминированный портрет из 16
// архетипов → [Принять]/[Заново]. «Принять» пишет vault/PERSONA.md; характер применяется со
// следующего хода (dynamic-инструкция 25-persona.ts читает файл каждый ход, без рестарта).
//
// Весь контент/скоринг — в quiz.mjs; этот экран драйвит опрос вслепую (индексы вопросов и
// ответов), поэтому смена формулировок/архетипов не трогает экран.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { QUIZ, QUIZ_ANSWERS, scoreQuiz, quizSummary, personaMarkdown } from "../quiz.mjs";

const SID = "chr";
const PARENT = "r";

// vault/PERSONA.md: каталог = ASSISTANT_VAULT_DIR ?? "vault", относительный — от cwd
// (как канал agent/channels/telegram.ts:182; оба процесса стартуют из /home/shima/iva).
function vaultDir() {
  const raw = process.env.ASSISTANT_VAULT_DIR ?? "vault";
  return raw.startsWith("/") ? raw : join(process.cwd(), raw);
}

// Экран одного вопроса «i/10» + 4 кнопки-ответа (2×2, индекс = позиция в QUIZ_ANSWERS).
// Рендерится напрямую (не через render()), т.к. вопрос — под-состояние квиза, а render()
// показывает интро при заходе на экран.
function renderQuestion(st, ctx) {
  const i = st.data.quiz.i;
  const lang = ctx.getLang();
  const q = QUIZ[i];
  const a = QUIZ_ANSWERS[lang] ?? QUIZ_ANSWERS.ru;
  const text = [
    ctx.tr(`🎭 Character · ${i + 1}/${QUIZ.length}`, `🎭 Характер · ${i + 1}/${QUIZ.length}`),
    "",
    q.text[lang] ?? q.text.ru,
  ].join("\n");
  const rows = [
    [ctx.btn(a[0], `iva_menu:${SID}:q:${i}:0`), ctx.btn(a[1], `iva_menu:${SID}:q:${i}:1`)],
    [ctx.btn(a[2], `iva_menu:${SID}:q:${i}:2`), ctx.btn(a[3], `iva_menu:${SID}:q:${i}:3`)],
    ctx.backRow(PARENT),
  ];
  return ctx.flows.screen(st, text, rows);
}

// Экран портрета: сводка архетипа + [Принять]/[Пройти заново].
function renderPortrait(st, ctx) {
  const code = st.data.quiz.code;
  const rows = [
    [
      ctx.btn(ctx.tr("✅ Accept", "✅ Принять"), `iva_menu:${SID}:apply`),
      ctx.btn(ctx.tr("↻ Retake", "↻ Пройти заново"), `iva_menu:${SID}:redo`),
    ],
    ctx.backRow(PARENT),
  ];
  return ctx.flows.screen(st, quizSummary(code, ctx.getLang()), rows);
}

export default {
  parent: PARENT,

  // Заход на экран (verb o) — интро-предупреждение. Квиз стартует по кнопке go.
  render(st, ctx) {
    const text = [
      ctx.tr("🎭 Iva's character", "🎭 Характер Ивы"),
      "",
      ctx.tr(
        "This is NOT a test of you — it sets what you want Iva to be like. 10 statements, answer yes / rather yes / rather no / no. At the end you'll get a portrait out of 16 archetypes and decide whether to apply it.",
        "Это НЕ тест тебя — это настройка того, какой ты хочешь видеть иву. 10 утверждений, отвечай да / скорее да / скорее нет / нет. В конце получишь портрет из 16 архетипов и решишь, применять ли его.",
      ),
    ].join("\n");
    return {
      text,
      rows: [[ctx.btn(ctx.tr("Start", "Начать"), `iva_menu:${SID}:go`)], ctx.backRow(PARENT)],
    };
  },

  async on(verb, args, st, ctx) {
    if (verb === "go" || verb === "redo") {
      st.data.quiz = { i: 0, answers: [], code: null };
      return renderQuestion(st, ctx);
    }
    if (verb === "q") {
      const i = Number.parseInt(args[0], 10);
      const v = Number.parseInt(args[1], 10);
      // Гард от протухшего даблтапа: принимаем ответ только на ТЕКУЩИЙ вопрос. Иначе просто
      // перерисовываем актуальное состояние (или интро, если квиз не идёт).
      if (!st.data.quiz || i !== st.data.quiz.i) {
        return st.data.quiz && st.data.quiz.code === null ? renderQuestion(st, ctx) : ctx.show(st, SID);
      }
      st.data.quiz.answers[i] = v;
      st.data.quiz.i = i + 1;
      if (st.data.quiz.i < QUIZ.length) return renderQuestion(st, ctx);
      // Все 10 отвечены — детерминированный скоринг и портрет.
      st.data.quiz.code = scoreQuiz(st.data.quiz.answers).code;
      return renderPortrait(st, ctx);
    }
    if (verb === "apply") {
      const code = st.data.quiz?.code;
      if (!code) return ctx.show(st, SID); // нечего применять — вернуться в интро
      const dir = vaultDir();
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "PERSONA.md"), personaMarkdown(code, ctx.getLang()), "utf8");
      } catch (e) {
        return ctx.flows.screen(
          st,
          ctx.tr(`Couldn't write the character file: ${e.message}`, `Не удалось записать файл характера: ${e.message}`),
          [ctx.backRow(PARENT)],
        );
      }
      return ctx.flows.screen(
        st,
        ctx.tr(
          "Character saved. It applies from your next message.",
          "Характер сохранён. Применится со следующего сообщения.",
        ),
        [ctx.backRow(PARENT)],
      );
    }
    return ctx.show(st, SID);
  },
};
