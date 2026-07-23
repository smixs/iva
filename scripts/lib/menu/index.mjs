// Движок вложенного inline-меню (/menu). Живёт в мосте (out-of-band): работает, пока
// агент занят, ничего не стоит по токенам, деплой = рестарт только iva-telegram-poll.
//
// Экраны — отдельные модули scripts/lib/menu/<name>.mjs; каждый экспортит по умолчанию
// { parent, render(st, ctx) -> {text, rows}, on(verb, args, st, ctx), texts? }. Реестр
// импортируется статически (SCREENS ниже), но createMenu({screens}) позволяет его
// подменить — так юнит-тест проверяет ЛОГИКУ движка, не завися от контента экранов.
//
// Грамматика callback_data: "iva_menu:<sid>:<verb>[:<arg>[:<arg>]]" — ASCII, только
// enum/индексы, <=64 байта (тот же принцип, что m:<index> в /model). Никаких user data.
// sid: r srch lang chr core ub gws cron sk st (+псевдо mdl/thk — хендофф в визарды).
// verbs: o(навигация) x(закрыть) pg:<n> rf(обновить) + data-вербы экрана (set key rs go
// q:<i>:<v> skip fin redo apply do).

import { getLang } from "../i18n.mjs";

import root from "./root.mjs";
import search from "./search.mjs";
import lang from "./lang.mjs";
import character from "./character.mjs";
import core from "./core.mjs";
import userbot from "./userbot.mjs";
import gws from "./gws.mjs";
import crons from "./crons.mjs";
import skills from "./skills.mjs";
import status from "./status.mjs";

// sid → экранный модуль. Псевдо-sid mdl/thk сюда не входят: это хендофф в визарды
// /model//think (обрабатывается в onCallback ниже до диспатча на экран).
export const SCREENS = {
  r: root,
  srch: search,
  lang,
  chr: character,
  core,
  ub: userbot,
  gws,
  cron: crons,
  sk: skills,
  st: status,
};

const PREFIX = "iva_menu:";
// Навигационные вербы «усыновляют» протухшее сообщение: все они — чистые функции от
// .env/settings/fs, потому меню само-чинится после рестарта моста или тапа по старому меню.
const NAV_VERBS = new Set(["o", "pg", "rf"]);

export function createMenu({ flows, tg, deps, screens = SCREENS }) {
  // ctx.lang — снимок языка на момент взаимодействия. tr/getLang берут его, а НЕ глобальный
  // getLang напрямую: сразу после смены языка кнопкой lang.on обновляет ctx.lang, и root
  // перерисовывается уже на новом языке (глобальный mtime-кэш i18n догоняет за ~2с).
  // Ни одной module-level const с переведённой строкой — правило репо соблюдено.
  const ctx = {
    tg,
    deps,
    flows,
    lang: "ru",
    tr: (en, ru) => (ctx.lang === "ru" ? ru : en),
    getLang: () => ctx.lang,
    btn: (text, data) => ({ text, callback_data: data }),
    // Переключить экран и перерисовать. Страницу НЕ сбрасывает — этим управляет вызывающий
    // (движок сбрасывает page на o-верб; экраны, зовущие show для под-экранов, — сами).
    show: async (st, sid) => {
      st.screen = sid;
      await renderScreen(st);
    },
    // Ряд «назад»: в корень — «‹ Меню», иначе «‹ Назад». Кнопка статическая (o-верб) —
    // возврат работает даже когда стейт потерян (усыновление в onCallback).
    backRow: (sid) => [
      ctx.btn(sid === "r" ? ctx.tr("‹ Menu", "‹ Меню") : ctx.tr("‹ Back", "‹ Назад"), `${PREFIX}${sid}:o`),
    ],
  };

  async function renderScreen(st) {
    const mod = screens[st.screen];
    if (!mod || typeof mod.render !== "function") return;
    const view = await mod.render(st, ctx);
    if (!view) return;
    await flows.screen(st, view.text, view.rows);
  }

  // "iva_menu:srch:set:tavily" -> { sid:"srch", verb:"set", args:["tavily"] }.
  // "iva_menu:mdl" -> { sid:"mdl", verb:undefined, args:[] }.
  function parse(data) {
    const parts = data.slice(PREFIX.length).split(":");
    return { sid: parts[0], verb: parts[1], args: parts.slice(2) };
  }

  async function onCallback(cq) {
    const chatId = cq.message?.chat?.id;
    const userId = String(cq.from?.id ?? "");
    const messageId = cq.message?.message_id;
    // Гасим спиннер кнопки СРАЗУ (mirror handleWizardCallback :562) — дальше можно не спешить.
    await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
    // Не-allowlisted тап глотаем ПОСЛЕ ack (mirror :563): флоу существует только у того,
    // кто прошёл гейт /menu, поэтому чужой тап и так не имеет стейта — но глушим явно.
    const allowed = deps.allowed;
    if (!allowed || allowed.size === 0 || !allowed.has(userId)) return true;
    if (typeof cq.data !== "string" || !cq.data.startsWith(PREFIX)) return true;

    ctx.lang = getLang();
    const { sid, verb, args } = parse(cq.data);

    // Псевдо-sid: хендофф в существующие визарды. newWizard внутри заменит flow-слот
    // (single-flow), а визард отрисуется в ЭТО же сообщение (msgId меню).
    if (sid === "mdl") {
      await deps.handleModelCmd(chatId, userId, { msgId: messageId });
      return true;
    }
    if (sid === "thk") {
      await deps.handleThinkCmd(chatId, userId, { msgId: messageId });
      return true;
    }

    // Закрытие: снять стейт + убрать клавиатуру. editMessageText без reply_markup её снимает.
    if (verb === "x") {
      const st = flows.get(chatId, userId);
      const closed = ctx.tr("Menu closed.", "Меню закрыто.");
      if (st && st.flow === "menu" && st.msgId === messageId) {
        // Закрывают ТЕКУЩЕЕ меню: end редактирует то же сообщение и снимает стейт.
        await flows.end(st, closed);
      } else {
        // Закрывают старое/протухшее сообщение (msgId не совпал): правим именно его, а
        // активный menu-стейт в другом сообщении не трогаем.
        await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: closed }).catch(() => {});
      }
      return true;
    }

    let st = flows.get(chatId, userId);
    const fresh = Boolean(st && st.flow === "menu" && st.msgId === messageId);
    if (!fresh) {
      if (NAV_VERBS.has(verb)) {
        // Усыновить сообщение: создать стейт, привязанный к тапнутому message_id, и отрендерить.
        st = flows.start(chatId, userId, "menu", { screen: sid, page: 0, msgId: messageId });
      } else {
        // Data-верб без живого стейта (рестарт моста / тап по старому меню): мид-флоу данные
        // потеряны — честно говорим «устарело» (mirror :567-570).
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: ctx.tr("Menu expired — send /menu", "Меню устарело — отправь /menu заново"),
        }).catch(() => {});
        return true;
      }
    }

    flows.touch(st); // активные квиз/интервью не протухают на полуслове; заброшенное меню — за 15 мин
    // Любой возврат/обновление экрана (‹ Назад, ‹ Меню, Отмена=o, пагинация, refresh) снимает
    // ждущий ввод: иначе следующее ОБЫЧНОЕ сообщение перехватится как креденшл (secret:true —
    // ещё и удалится из чата). Ручная чистка в search.render остаётся как защита в глубину.
    if (NAV_VERBS.has(verb)) st.awaitText = null;

    if (verb === "o") {
      st.page = 0;
      await ctx.show(st, sid);
      return true;
    }
    if (verb === "pg") {
      st.screen = sid;
      st.page = Number.parseInt(args[0], 10) || 0;
      await renderScreen(st);
      return true;
    }
    if (verb === "rf") {
      st.screen = sid;
      await renderScreen(st);
      return true;
    }

    // Data-верб — экрану sid (тапнутая кнопка принадлежит ему). Экран сам решает, что
    // отрисовать (ctx.show / flows.screen / awaitText). Ошибки экрана НЕ роняют мост:
    // onCallback вызывается из моста через .catch (см. handleControl-интеграцию).
    st.screen = sid;
    const mod = screens[sid];
    if (mod && typeof mod.on === "function") await mod.on(verb, args, st, ctx);
    return true;
  }

  // Перехват текста, пока экран ждёт ввод (st.awaitText установлен ЭКРАНОМ). Секрет
  // (apikey/ubcred/gwsjson) удаляется ДО всего остального — значение не уходит в eve/лог/reply.
  // Отказ secret вне лички — на этапе установки awaitText (обязанность экрана); сюда доходит
  // только уже разрешённый ввод.
  async function onText(msg, st) {
    ctx.lang = getLang();
    if (!st || !st.awaitText) return true;
    const chatId = msg.chat?.id;
    const text = (msg.text || "").trim();
    flows.touch(st);
    // Команда прерывает ожидание: молча висящий промпт пригласил бы вставить ключ позже,
    // когда его уже некому перехватить (:666-668). Команду не удаляем — это не секрет.
    if (text.startsWith("/")) {
      await flows.end(st, ctx.tr("Cancelled — no longer waiting for input.", "Отменено — ожидание ввода снято."));
      return true;
    }
    const a = st.awaitText;
    if (a.secret) {
      // delete-message-FIRST (:512-515). При провале удаления — предупреждение как в мосте;
      // текст ошибки НИКОГДА не содержит значение ключа.
      const del = await tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
      if (!del.ok) {
        await deps.reply(chatId, ctx.tr(
          "Couldn't delete your message — please delete it manually.",
          "Не смог удалить сообщение — удали его вручную.",
        ));
      }
    }
    const handler = screens[st.screen]?.texts?.[a.kind];
    if (typeof handler !== "function") {
      await flows.end(st, ctx.tr("Input handler is unavailable — flow reset.", "Обработчик ввода недоступен — флоу сброшен."));
      return true;
    }
    await handler(text, msg, st, ctx);
    return true;
  }

  // /menu: заводит свежий стейт и рисует root. opts.msgId (опц.) — редактировать существующее
  // сообщение вместо нового (напр. возврат из визарда). Двойной /menu заменяет стейт и
  // best-effort снимает клавиатуру со старого меню — мёртвое сообщение не зовёт на протухшие тапы.
  async function open(chatId, userId, opts = {}) {
    ctx.lang = getLang();
    const uid = String(userId);
    const prev = flows.get(chatId, uid);
    if (prev && prev.flow === "menu" && prev.msgId) {
      await tg("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: prev.msgId,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }
    const st = flows.start(chatId, uid, "menu", { screen: "r", page: 0, msgId: opts.msgId ?? null });
    await renderScreen(st);
    return st;
  }

  return { open, onCallback, onText };
}
