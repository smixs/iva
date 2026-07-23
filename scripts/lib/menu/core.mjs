// Экран «Память» (core memory) меню (/menu → 💾). Показывает выдержку из vault/CORE.md и
// проводит интервью из 6 свободных вопросов. Мост НЕ дистиллирует сам: он сохраняет сырые
// ответы (core-interview.mjs → vault/core-interview.md) и отдаёт их иве синтетическим
// сообщением buildDistillMessage — она своими инструментами ужимает их в ядро и обновляет
// vault/CORE.md (лимит 1200 симв. — забота модели). Так формат ядра не знает ни мост, ни экран.
//
// ВАЖНО про синтетический deliver: он идёт в eve в обход busy-гейта моста (telegram-poll.mjs:805).
// Если по чату уже идёт ход — второй апдейт на том же continuation-token даст HookConflictError.
// Поэтому перед deliver ОБЯЗАТЕЛЬНА проверка isRunning(chatKey): занято → не доставляем, а
// честно говорим сохранить и повторить, когда ива освободится.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { INTERVIEW, saveInterview, buildDistillMessage } from "../core-interview.mjs";
import { isRunning, chatKeyOf } from "../run-status.mjs";

const SID = "core";
const PARENT = "r";
const EXCERPT_LIMIT = 400;

function vaultDir() {
  const raw = process.env.ASSISTANT_VAULT_DIR ?? "vault";
  return raw.startsWith("/") ? raw : join(process.cwd(), raw);
}

async function coreExcerpt() {
  try {
    const text = (await readFile(join(vaultDir(), "CORE.md"), "utf8")).trim();
    if (!text) return null;
    return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT).trimEnd()}…` : text;
  } catch {
    return null; // файла нет / нет доступа — ядро считаем пустым
  }
}

// Экран одного вопроса интервью: ставит awaitText{kind:"interview"} (движок отдаст следующий
// текст в texts.interview) и показывает кнопки [Пропустить]/[Завершить]. Ответы не секретны —
// движок их не удаляет; в eve/дневник они не попадают, только в vault через saveInterview.
function renderInterviewQuestion(st, ctx) {
  const i = st.data.iv.i;
  const lang = ctx.getLang();
  const q = INTERVIEW[i];
  st.awaitText = { kind: "interview", secret: false, data: {} };
  const text = [
    ctx.tr(`💾 Core memory · ${i + 1}/${INTERVIEW.length}`, `💾 Память · ${i + 1}/${INTERVIEW.length}`),
    "",
    q.text[lang] ?? q.text.ru,
    "",
    ctx.tr("Reply with text, or skip / finish below.", "Ответь текстом, или пропусти / заверши кнопкой ниже."),
  ].join("\n");
  const rows = [
    [
      ctx.btn(ctx.tr("Skip", "Пропустить"), `iva_menu:${SID}:skip`),
      ctx.btn(ctx.tr("Finish", "Завершить"), `iva_menu:${SID}:fin`),
    ],
    ctx.backRow(PARENT),
  ];
  return ctx.flows.screen(st, text, rows);
}

// Записать ответ (или пропуск) и перейти к следующему вопросу; после последнего — завершить.
function advance(st, ctx, answer) {
  const i = st.data.iv.i;
  const lang = ctx.getLang();
  st.data.iv.qa.push({ q: INTERVIEW[i].text[lang] ?? INTERVIEW[i].text.ru, a: answer });
  st.data.iv.i = i + 1;
  if (st.data.iv.i < INTERVIEW.length) return renderInterviewQuestion(st, ctx);
  return finish(st, ctx);
}

// Завершение: сохранить сырой архив и (если ива свободна) отдать ответы на дистилляцию.
async function finish(st, ctx) {
  st.awaitText = null;
  const iv = st.data.iv ?? { qa: [] };
  const qa = iv.qa;
  const lang = ctx.getLang();
  try {
    await saveInterview(vaultDir(), qa);
  } catch (e) {
    return ctx.flows.screen(
      st,
      ctx.tr(`Couldn't save the interview: ${e.message}`, `Не удалось сохранить интервью: ${e.message}`),
      [ctx.backRow(PARENT)],
    );
  }

  // chatKey как у continuation-hook eve: threadId берём из реального сообщения ответа, если
  // оно было (иначе главный чат). Занятость проверяем ПЕРЕД deliver — иначе HookConflict.
  const threadId = iv.threadId;
  const key = chatKeyOf(st.chatId, threadId);
  if (isRunning(key)) {
    return ctx.flows.screen(
      st,
      ctx.tr(
        "Answers saved to vault/core-interview.md. Iva is busy right now — send her «update your memory core» once she's free.",
        "Ответы сохранены в vault/core-interview.md. Ива сейчас занята — напиши ей «обнови ядро памяти», когда освободится.",
      ),
      [ctx.backRow(PARENT)],
    );
  }

  // Синтетическое сообщение «от имени юзера» (как /stop синтезирует callback, telegram-poll.mjs:697-706).
  // Реальные chat/from стэшим из ответа интервью; при пустом интервью синтезируем из st.
  const from = iv.from ?? { id: Number(st.userId), is_bot: false };
  const chat = iv.chat ?? { id: st.chatId, type: Number(st.chatId) > 0 ? "private" : "supergroup" };
  const message = {
    message_id: Date.now(),
    date: Math.floor(Date.now() / 1000),
    chat,
    from,
    text: buildDistillMessage(qa, lang),
    ...(threadId != null ? { message_thread_id: threadId } : {}),
  };
  try {
    await ctx.deps.deliver({ update_id: 0, message });
  } catch (e) {
    ctx.deps.log?.("core deliver error:", e.message);
  }
  return ctx.flows.screen(
    st,
    ctx.tr(
      "Sent to Iva — she'll distill your answers into the memory core and confirm.",
      "Передал иве — она сожмёт ответы в ядро памяти и подтвердит.",
    ),
    [ctx.backRow(PARENT)],
  );
}

export default {
  parent: PARENT,

  async render(st, ctx) {
    const excerpt = await coreExcerpt();
    const head = ctx.tr("💾 Memory core", "💾 Ядро памяти");
    const body = excerpt
      ? `${ctx.tr("Current core:", "Текущее ядро:")}\n\n${excerpt}`
      : ctx.tr("The memory core is empty.", "Ядро памяти пусто.");
    const hint = ctx.tr(
      "The interview asks 6 questions; Iva turns your answers into the core.",
      "Интервью — 6 вопросов; ответы ива сама превратит в ядро.",
    );
    return {
      text: `${head}\n\n${body}\n\n${hint}`,
      rows: [[ctx.btn(ctx.tr("Take the interview", "Пройти интервью"), `iva_menu:${SID}:go`)], ctx.backRow(PARENT)],
    };
  },

  async on(verb, args, st, ctx) {
    if (verb === "go") {
      st.data.iv = { i: 0, qa: [], chat: null, from: null, threadId: null };
      return renderInterviewQuestion(st, ctx);
    }
    if (!st.data.iv) return ctx.show(st, SID); // skip/fin без активного интервью — назад в выдержку
    if (verb === "skip") return advance(st, ctx, ""); // пустой ответ = пропуск (архив покажет прочерк)
    if (verb === "fin") return finish(st, ctx);
    return ctx.show(st, SID);
  },

  texts: {
    // Свободный ответ на вопрос интервью (не секрет — движок не удаляет). Стэшим реальные
    // chat/from/thread для будущего синтетического deliver, пишем ответ, идём дальше.
    async interview(text, msg, st, ctx) {
      if (!st.data.iv) return ctx.show(st, SID);
      st.data.iv.chat = msg.chat;
      st.data.iv.from = msg.from;
      st.data.iv.threadId = msg.message_thread_id ?? null;
      return advance(st, ctx, String(text).trim());
    },
  },
};
