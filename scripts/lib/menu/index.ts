// Движок вложенного inline-меню (/menu). Живёт в мосте (out-of-band): работает, пока
// агент занят, ничего не стоит по токенам, деплой = рестарт только iva-telegram-poll.
//
// Экраны — отдельные модули scripts/lib/menu/<name>; каждый экспортит по умолчанию
// { parent, render(st, ctx) -> {text, rows}, on(verb, args, st, ctx), texts? }. Реестр
// импортируется статически (SCREENS ниже), но createMenu({screens}) позволяет его
// подменить — так юнит-тест проверяет ЛОГИКУ движка, не завися от контента экранов.
//
// Грамматика callback_data: "iva_menu:<sid>:<verb>[:<arg>[:<arg>]]" — ASCII, только
// enum/индексы, <=64 байта (тот же принцип, что m:<index> в /model). Никаких user data.
// sid: r srch lang chr core ub gws cron ntc sk st svc (+псевдо mdl/thk — хендофф в визарды).
// verbs: o(навигация) x(закрыть) pg:<n> rf(обновить) + data-вербы экрана (set key rs go
// q:<i>:<v> skip fin redo apply do).

import { getLang } from "#lib/i18n.ts";
import type { TelegramFlowState } from "../tg-flow.ts";
import type {
  TelegramCallbackQuery as CallbackQuery,
  TelegramId,
  TelegramQueueMessage as TelegramMessage,
  TelegramQueueUpdate,
} from "../telegram-queue.ts";

import root from "./root.ts";
import search from "./search.ts";
import lang from "./lang.ts";
import character from "./character.ts";
import core from "./core.ts";
import userbot from "./userbot.ts";
import gws from "./gws.ts";
import crons from "./crons.ts";
import notices from "./notices.ts";
import skills from "./skills.ts";
import status from "./status.ts";
import service from "./service.ts";

type MaybePromise<T> = T | Promise<T>;
type MenuButton = { text: string; callback_data: string };
type MenuAwaitText = { kind: string; secret: boolean; [key: string]: unknown };
type MenuState = TelegramFlowState;
type MenuFlows = {
  get(chatId: TelegramId, userId: TelegramId): MenuState | null;
  start(
    chatId: TelegramId,
    userId: TelegramId,
    flow: string,
    extra: Record<string, unknown>,
  ): MenuState;
  touch(state: MenuState): void;
  screen(
    state: MenuState,
    text: string,
    rows?: Array<MenuButton[]>,
  ): Promise<void>;
  end(state: MenuState, text: string): Promise<void>;
};
type TelegramTransport = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;
type MenuDeps = {
  allowed?: ReadonlySet<string>;
  deliver(update: TelegramQueueUpdate): MaybePromise<unknown>;
  handleModelCmd(
    chatId: number,
    userId: TelegramId,
    options: { msgId?: number },
  ): MaybePromise<unknown>;
  handleThinkCmd(
    chatId: number,
    userId: TelegramId,
    options: { msgId?: number },
  ): MaybePromise<unknown>;
  reply(chatId: number, text: string): MaybePromise<unknown>;
  [key: string]: unknown;
};
type MenuContext = {
  flows: MenuFlows;
  tg: TelegramTransport;
  deps: MenuDeps;
  lang: string;
  tr: (english: string, russian: string) => string;
  getLang: () => string;
  btn: (text: string, callbackData: string) => MenuButton;
  show: (state: MenuState, screen: string) => Promise<void>;
  backRow: (screen: string) => MenuButton[];
};
type MenuView = { text: string; rows: Array<MenuButton[]> };
type MenuScreen = {
  render?: (
    state: MenuState,
    context: MenuContext,
  ) => MaybePromise<MenuView | null | undefined>;
  on?: (
    verb: string,
    args: string[],
    state: MenuState,
    context: MenuContext,
  ) => MaybePromise<unknown>;
  texts?: Record<
    string,
    (
      text: string,
      message: TelegramMessage,
      state: MenuState,
      context: MenuContext,
    ) => MaybePromise<unknown>
  >;
};
type ScreenRegistry = Record<string, unknown>;
type MenuOptions = {
  flows: MenuFlows;
  tg: TelegramTransport;
  deps: MenuDeps;
  screens?: ScreenRegistry;
};
type OpenOptions = { msgId?: number };

function isMenuAwaitText(value: unknown): value is MenuAwaitText {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { secret?: unknown }).secret === "boolean"
  );
}

function telegramCallOk(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true
  );
}

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
  ntc: notices,
  sk: skills,
  st: status,
  svc: service,
};

const PREFIX = "iva_menu:";
// Навигационные вербы «усыновляют» протухшее сообщение: все они — чистые функции от
// .env/settings/fs, потому меню само-чинится после рестарта моста или тапа по старому меню.
const NAV_VERBS = new Set(["o", "pg", "rf"]);

export function createMenu({
  flows,
  tg,
  deps,
  screens = SCREENS,
}: MenuOptions) {
  // ctx.lang — снимок языка на момент взаимодействия. tr/getLang берут его, а НЕ глобальный
  // getLang напрямую: сразу после смены языка кнопкой lang.on обновляет ctx.lang, и root
  // перерисовывается уже на новом языке (глобальный mtime-кэш i18n догоняет за ~2с).
  // Ни одной module-level const с переведённой строкой — правило репо соблюдено.
  const ctx: MenuContext = {
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
      ctx.btn(
        sid === "r" ? ctx.tr("‹ Menu", "‹ Меню") : ctx.tr("‹ Back", "‹ Назад"),
        `${PREFIX}${sid}:o`,
      ),
    ],
  };

  async function renderScreen(st: MenuState) {
    const screen = typeof st.screen === "string" ? st.screen : "";
    const mod = screens[screen] as MenuScreen | undefined;
    if (!mod || typeof mod.render !== "function") return;
    const view = await mod.render(st, ctx);
    if (!view) return;
    await flows.screen(st, view.text, view.rows);
  }

  // "iva_menu:srch:set:tavily" -> { sid:"srch", verb:"set", args:["tavily"] }.
  // "iva_menu:mdl" -> { sid:"mdl", verb:undefined, args:[] }.
  function parse(data: string) {
    const parts = data.slice(PREFIX.length).split(":");
    return { sid: parts[0], verb: parts[1], args: parts.slice(2) };
  }

  async function onCallback(cq: CallbackQuery) {
    const chatId = cq.message?.chat?.id;
    const userId = String(cq.from?.id ?? "");
    const messageId = cq.message?.message_id;
    // Гасим спиннер кнопки СРАЗУ (mirror handleWizardCallback :562) — дальше можно не спешить.
    await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(
      () => {},
    );
    // Не-allowlisted тап глотаем ПОСЛЕ ack (mirror :563): флоу существует только у того,
    // кто прошёл гейт /menu, поэтому чужой тап и так не имеет стейта — но глушим явно.
    const allowed = deps.allowed;
    if (!allowed || allowed.size === 0 || !allowed.has(userId)) return true;
    if (typeof cq.data !== "string" || !cq.data.startsWith(PREFIX)) return true;
    if (chatId === undefined || messageId === undefined) return true;

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
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: closed,
        }).catch(() => {});
      }
      return true;
    }

    let st = flows.get(chatId, userId);
    const fresh = Boolean(st && st.flow === "menu" && st.msgId === messageId);
    if (!fresh) {
      if (NAV_VERBS.has(verb)) {
        // Усыновить сообщение: создать стейт, привязанный к тапнутому message_id, и отрендерить.
        st = flows.start(chatId, userId, "menu", {
          screen: sid,
          page: 0,
          msgId: messageId,
        });
      } else {
        // Data-верб без живого стейта (рестарт моста / тап по старому меню): мид-флоу данные
        // потеряны — честно говорим «устарело» (mirror :567-570).
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: ctx.tr(
            "Menu expired — send /menu",
            "Меню устарело — отправь /menu заново",
          ),
        }).catch(() => {});
        return true;
      }
    }

    const active = st!;
    flows.touch(active); // активные квиз/интервью не протухают на полуслове; заброшенное меню — за 15 мин
    // Любой возврат/обновление экрана (‹ Назад, ‹ Меню, Отмена=o, пагинация, refresh) снимает
    // ждущий ввод: иначе следующее ОБЫЧНОЕ сообщение перехватится как креденшл (secret:true —
    // ещё и удалится из чата). Ручная чистка в search.render остаётся как защита в глубину.
    if (NAV_VERBS.has(verb)) active.awaitText = null;

    if (verb === "o") {
      active.page = 0;
      await ctx.show(active, sid);
      return true;
    }
    if (verb === "pg") {
      active.screen = sid;
      active.page = Number.parseInt(args[0], 10) || 0;
      await renderScreen(active);
      return true;
    }
    if (verb === "rf") {
      active.screen = sid;
      await renderScreen(active);
      return true;
    }

    // Data-верб — экрану sid (тапнутая кнопка принадлежит ему). Экран сам решает, что
    // отрисовать (ctx.show / flows.screen / awaitText). Ошибки экрана НЕ роняют мост:
    // onCallback вызывается из моста через .catch (см. handleControl-интеграцию).
    active.screen = sid;
    const mod = screens[sid] as MenuScreen | undefined;
    if (mod && typeof mod.on === "function")
      await mod.on(verb, args, active, ctx);
    return true;
  }

  // Перехват текста, пока экран ждёт ввод (st.awaitText установлен ЭКРАНОМ). Секрет
  // (apikey/ubcred/gwsjson) удаляется ДО всего остального — значение не уходит в eve/лог/reply.
  // Отказ secret вне лички — на этапе установки awaitText (обязанность экрана); сюда доходит
  // только уже разрешённый ввод.
  // opts.skipDelete — the caller has ALREADY removed the message and CONFIRMED the deletion succeeded
  // (the bridge deletes a secret file, checks the result, and only then downloads + delivers the
  // content here). Callers must never set it without a confirmed deletion — otherwise a still-visible
  // secret would be processed. When set, we don't try to delete a second time.
  async function onText(
    msg: TelegramMessage,
    st: MenuState,
    opts: { skipDelete?: boolean } = {},
  ) {
    ctx.lang = getLang();
    const a = isMenuAwaitText(st?.awaitText) ? st.awaitText : null;
    if (!a) return true;
    const chatId = msg.chat?.id;
    if (chatId === undefined) return true;
    const text = (msg.text || "").trim();
    flows.touch(st);
    // Команда прерывает ожидание: молча висящий промпт пригласил бы вставить ключ позже,
    // когда его уже некому перехватить (:666-668). Команду не удаляем — это не секрет.
    if (text.startsWith("/")) {
      await flows.end(
        st,
        ctx.tr(
          "Cancelled — no longer waiting for input.",
          "Отменено — ожидание ввода снято.",
        ),
      );
      return true;
    }
    if (a.secret && !opts.skipDelete) {
      // delete-message-FIRST (:512-515). При провале удаления — предупреждение как в мосте;
      // текст ошибки НИКОГДА не содержит значение ключа.
      const del = await tg("deleteMessage", {
        chat_id: chatId,
        message_id: msg.message_id,
      });
      if (!telegramCallOk(del)) {
        await deps.reply(
          chatId,
          ctx.tr(
            "Couldn't delete your message — please delete it manually.",
            "Не смог удалить сообщение — удали его вручную.",
          ),
        );
      }
    }
    const screen = typeof st.screen === "string" ? st.screen : "";
    const handler = (screens[screen] as MenuScreen | undefined)?.texts?.[
      a.kind
    ];
    if (typeof handler !== "function") {
      await flows.end(
        st,
        ctx.tr(
          "Input handler is unavailable — flow reset.",
          "Обработчик ввода недоступен — флоу сброшен.",
        ),
      );
      return true;
    }
    await handler(text, msg, st, ctx);
    return true;
  }

  // /menu: заводит свежий стейт и рисует root. opts.msgId (опц.) — редактировать существующее
  // сообщение вместо нового (напр. возврат из визарда). Двойной /menu заменяет стейт и
  // best-effort снимает клавиатуру со старого меню — мёртвое сообщение не зовёт на протухшие тапы.
  async function open(
    chatId: TelegramId,
    userId: TelegramId,
    opts: OpenOptions = {},
  ) {
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
    const st = flows.start(chatId, uid, "menu", {
      screen: "r",
      page: 0,
      msgId: opts.msgId ?? null,
    });
    await renderScreen(st);
    return st;
  }

  return { open, onCallback, onText };
}
