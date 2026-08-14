/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test from "node:test";
import assert from "node:assert/strict";
import { createFlows } from "../tg-flow.ts";
import { SCREENS } from "./index.ts";
import root from "./root.ts";

type Params = {
  message_id?: number;
  text?: string;
  reply_markup?: unknown;
  [key: string]: unknown;
};
type Call = { method: string; params: Params };
type AwaitText = {
  kind: string;
  secret: boolean;
  data: Record<string, unknown>;
};
type MenuState = {
  flow: string;
  msgId: number;
  screen: string;
  page: number;
  awaitText: AwaitText | null;
};
type FlowStore = { get: (chatId: number, userId: string) => MenuState | null };
type Menu = {
  open: (chatId: number, userId: string) => Promise<MenuState>;
  onCallback: (callback: Callback) => Promise<boolean>;
  onText: (message: TextMessage, state: MenuState) => Promise<void>;
};
type Callback = {
  id: string;
  from: { id: string };
  message: { chat: { id: number }; message_id: number };
  data: string;
};
type TextMessage = {
  chat: { id: number };
  from: { id: number };
  message_id: number;
  text: string;
};
type ScreenContext = {
  backRow: (screen: string) => Array<Record<string, unknown>>;
  show: (state: MenuState, screen: string) => Promise<void>;
};
type Screen = {
  parent: string | null;
  render: (
    state: MenuState,
    context: ScreenContext,
  ) => { text: string; rows: Array<Array<Record<string, unknown>>> };
  on: (verb: string, args: string[]) => void;
  texts: {
    demo: (
      text: string,
      message: unknown,
      state: MenuState,
      context: ScreenContext,
    ) => Promise<void>;
  };
};
type Log = {
  render: string[];
  on: Array<{ sid: string; verb: string; args: string[] }>;
  texts: Array<{ sid: string; text: string }>;
};
const indexModulePath: string = "./index.ts";
const { createMenu } = (await import(indexModulePath)) as {
  createMenu: (options: Record<string, unknown>) => Menu;
};

// Тестируем ЛОГИКУ движка (парс грамматики, stale-политика, allowlist, close) на фейковом
// реестре экранов — так тест не зависит от контента реальных экранов (в т.ч. тех, что пишет
// параллельный агент). createMenu({screens}) даёт эту инъекцию.

// Мок Bot API: копит вызовы, sendMessage выдаёт растущий message_id (как tg-flow.test).
function makeTg() {
  const calls: Call[] = [];
  let auto = 100;
  const tg = (method: string, params: Params) => {
    calls.push({ method, params });
    if (method === "sendMessage")
      return Promise.resolve({ ok: true, result: { message_id: auto++ } });
    return Promise.resolve({ ok: true, result: { message_id: auto } });
  };
  return { tg, calls };
}

// Фейковые экраны: пишут в log каждый вызов render/on/texts, чтобы проверить диспатч.
function fakeScreens() {
  const log: Log = { render: [], on: [], texts: [] };
  const mk = (sid: string, parent: string | null): Screen => ({
    parent,
    render(st: MenuState, ctx: ScreenContext) {
      log.render.push(st.screen);
      return { text: `[${st.screen}#${st.page}]`, rows: [ctx.backRow("r")] };
    },
    on(verb: string, args: string[]) {
      log.on.push({ sid, verb, args: [...args] });
    },
    texts: {
      demo(text: string, _msg: unknown, st: MenuState, ctx: ScreenContext) {
        log.texts.push({ sid, text });
        st.awaitText = null;
        return ctx.show(st, sid);
      },
    },
  });
  const screens: Record<string, Screen> = {};
  const screenParents: Array<[string, string | null]> = [
    ["r", null],
    ["srch", "r"],
    ["lang", "r"],
    ["chr", "r"],
    ["core", "r"],
    ["ub", "r"],
    ["gws", "r"],
    ["cron", "r"],
    ["sk", "r"],
    ["st", "r"],
  ];
  for (const [sid, parent] of screenParents) {
    screens[sid] = mk(sid, parent);
  }
  return { screens, log };
}

function setup({ allowed = new Set(["20"]) }: { allowed?: Set<string> } = {}) {
  const { tg, calls } = makeTg();
  const flows = createFlows({ tg }) as unknown as FlowStore;
  const { screens, log } = fakeScreens();
  const modelCalls: Array<{
    chatId: number;
    from: string;
    opts: { msgId: number };
  }> = [];
  const thinkCalls: Array<{
    chatId: number;
    from: string;
    opts: { msgId: number };
  }> = [];
  const replies: Array<{ chatId: number; text: string }> = [];
  const deps = {
    envPath: "/nonexistent/.env",
    dataDir: "/nonexistent/data",
    root: "/nonexistent",
    sc: () => Promise.resolve(true),
    reply: (chatId: number, text: string) =>
      Promise.resolve(replies.push({ chatId, text })),
    deliver: () => Promise.resolve(),
    log: () => {},
    allowed,
    handleModelCmd: (chatId: number, from: string, opts: { msgId: number }) =>
      Promise.resolve(modelCalls.push({ chatId, from, opts })),
    handleThinkCmd: (chatId: number, from: string, opts: { msgId: number }) =>
      Promise.resolve(thinkCalls.push({ chatId, from, opts })),
  };
  const menu = createMenu({ flows, tg, deps, screens });
  return {
    menu,
    flows,
    tg,
    calls,
    screens,
    log,
    modelCalls,
    thinkCalls,
    replies,
  };
}

const cb = (
  data: string,
  { from = "20", chat = 10, messageId = 100, id = "cq" } = {},
): Callback => ({
  id,
  from: { id: from },
  message: { chat: { id: chat }, message_id: messageId },
  data,
});

test("open рисует root, заводит menu-стейт и шлёт новое сообщение", async () => {
  const { menu, flows, calls } = setup();
  const st = await menu.open(10, "20");
  assert.equal(st.flow, "menu");
  assert.equal(st.screen, "r");
  assert.ok(st.msgId); // sendMessage выдал message_id
  assert.equal(flows.get(10, "20"), st);
  assert.equal(calls[0].method, "sendMessage");
});

test("грамматика: одноаргументный data-верб уходит в screen.on(verb, args)", async () => {
  const { menu, log } = setup();
  const st = await menu.open(10, "20");
  await menu.onCallback(
    cb("iva_menu:srch:set:tavily", { messageId: st.msgId }),
  );
  assert.deepEqual(log.on.at(-1), {
    sid: "srch",
    verb: "set",
    args: ["tavily"],
  });
});

test("грамматика: многоаргументный верб q:<i>:<v> разбирается в args=[i,v]", async () => {
  const { menu, log } = setup();
  const st = await menu.open(10, "20");
  await menu.onCallback(cb("iva_menu:chr:q:3:1", { messageId: st.msgId }));
  assert.deepEqual(log.on.at(-1), { sid: "chr", verb: "q", args: ["3", "1"] });
});

test("навигация o переключает st.screen и рендерит целевой экран", async () => {
  const { menu, log } = setup();
  const st = await menu.open(10, "20");
  log.render.length = 0;
  await menu.onCallback(cb("iva_menu:st:o", { messageId: st.msgId }));
  assert.equal(st.screen, "st");
  assert.equal(log.render.at(-1), "st");
});

test("pg меняет страницу того же экрана", async () => {
  const { menu } = setup();
  const st = await menu.open(10, "20");
  await menu.onCallback(cb("iva_menu:sk:pg:2", { messageId: st.msgId }));
  assert.equal(st.screen, "sk");
  assert.equal(st.page, 2);
});

test("NAV-верб o/pg/rf снимает ждущий ввод (awaitText=null)", async () => {
  for (const data of ["iva_menu:ub:o", "iva_menu:sk:pg:1", "iva_menu:st:rf"]) {
    const { menu } = setup();
    const st = await menu.open(10, "20");
    st.awaitText = { kind: "demo", secret: true, data: {} }; // экран поставил ожидание ключа
    await menu.onCallback(cb(data, { messageId: st.msgId }));
    assert.equal(st.awaitText, null, `${data} должен снять awaitText`);
  }
});

test("после NAV-верба обычное сообщение НЕ перехватывается и НЕ удаляется", async () => {
  const { menu, calls } = setup();
  const st = await menu.open(10, "20");
  st.screen = "ub";
  st.awaitText = { kind: "demo", secret: true, data: {} };
  await menu.onCallback(cb("iva_menu:ub:o", { messageId: st.msgId })); // «Отмена»/«Назад» = o
  await menu.onText(
    {
      chat: { id: 10 },
      from: { id: 20 },
      message_id: 950,
      text: "обычный вопрос",
    },
    st,
  );
  assert.ok(!calls.some((c) => c.method === "deleteMessage")); // secret-удаление не сработало
});

test("stale: нет стейта, o-верб УСЫНОВЛЯЕТ тапнутое сообщение и рендерит", async () => {
  const { menu, flows, log } = setup();
  const r = await menu.onCallback(cb("iva_menu:srch:o", { messageId: 555 }));
  assert.equal(r, true);
  const st = flows.get(10, "20");
  assert.ok(st);
  assert.equal(st.msgId, 555);
  assert.equal(st.screen, "srch");
  assert.equal(log.render.at(-1), "srch");
});

test("stale: нет стейта, data-верб -> «устарело» (editMessageText), без диспатча в on", async () => {
  const { menu, flows, calls, log } = setup();
  const r = await menu.onCallback(
    cb("iva_menu:srch:set:tavily", { messageId: 555 }),
  );
  assert.equal(r, true);
  assert.equal(flows.get(10, "20"), null); // стейт не создан
  assert.equal(log.on.length, 0); // экран не тронут
  const edit = calls.find((c) => c.method === "editMessageText");
  assert.ok(edit && /устарело|expired/i.test(edit.params.text ?? ""));
});

test("stale: msgId mismatch на data-верб -> «устарело», экран не тронут", async () => {
  const { menu, log, calls } = setup();
  const st = await menu.open(10, "20");
  await menu.onCallback(
    cb("iva_menu:srch:set:tavily", { messageId: st.msgId + 1 }),
  );
  assert.equal(log.on.length, 0);
  assert.ok(
    calls.some(
      (c) =>
        c.method === "editMessageText" &&
        /устарело|expired/i.test(c.params.text ?? ""),
    ),
  );
});

test("stale: msgId mismatch на o-верб -> усыновляет новое сообщение (новый msgId)", async () => {
  const { menu, flows } = setup();
  await menu.open(10, "20");
  await menu.onCallback(cb("iva_menu:st:o", { messageId: 777 }));
  const st = flows.get(10, "20");
  assert.ok(st);
  assert.equal(st.msgId, 777);
  assert.equal(st.screen, "st");
});

test("allowlist: чужой тап ack-нут и проглочен — без диспатча, стейт не тронут", async () => {
  const { menu, flows, calls, log } = setup();
  const st = await menu.open(10, "20");
  const r = await menu.onCallback(
    cb("iva_menu:srch:set:tavily", { from: "999", messageId: st.msgId }),
  );
  assert.equal(r, true);
  assert.equal(log.on.length, 0);
  assert.ok(calls.some((c) => c.method === "answerCallbackQuery")); // спиннер всё же погашен
  assert.equal(flows.get(10, "20"), st); // стейт владельца не тронут
});

test("allowlist пуст: любой тап проглочен", async () => {
  const { menu, log } = setup({ allowed: new Set() });
  await menu.onCallback(cb("iva_menu:srch:o", { messageId: 1 }));
  assert.equal(log.render.length, 0);
  assert.equal(log.on.length, 0);
});

test("close r:x снимает стейт и убирает клавиатуру (edit без reply_markup)", async () => {
  const { menu, flows, calls } = setup();
  const st = await menu.open(10, "20");
  await menu.onCallback(cb("iva_menu:r:x", { messageId: st.msgId }));
  assert.equal(flows.get(10, "20"), null);
  const lastEdit = calls.filter((c) => c.method === "editMessageText").at(-1);
  assert.ok(lastEdit);
  assert.equal(lastEdit.params.reply_markup, undefined); // клавиатура снята
});

test("close без стейта: правит тапнутое сообщение, не создаёт стейт", async () => {
  const { menu, flows, calls } = setup();
  const r = await menu.onCallback(cb("iva_menu:r:x", { messageId: 42 }));
  assert.equal(r, true);
  assert.equal(flows.get(10, "20"), null);
  assert.ok(
    calls.some(
      (c) => c.method === "editMessageText" && c.params.message_id === 42,
    ),
  );
});

test("handoff mdl/thk зовёт визарды с msgId текущего меню", async () => {
  const { menu, modelCalls, thinkCalls } = setup();
  const st = await menu.open(10, "20");
  await menu.onCallback(cb("iva_menu:mdl", { messageId: st.msgId }));
  assert.deepEqual(modelCalls.at(-1), {
    chatId: 10,
    from: "20",
    opts: { msgId: st.msgId },
  });
  await menu.onCallback(cb("iva_menu:thk", { messageId: st.msgId }));
  assert.deepEqual(thinkCalls.at(-1), {
    chatId: 10,
    from: "20",
    opts: { msgId: st.msgId },
  });
});

test("onText secret: удаляет сообщение ПЕРВЫМ, затем зовёт texts-обработчик экрана", async () => {
  const { menu, calls, log } = setup();
  const st = await menu.open(10, "20");
  st.screen = "srch";
  st.awaitText = { kind: "demo", secret: true, data: {} };
  await menu.onText(
    {
      chat: { id: 10 },
      from: { id: 20 },
      message_id: 900,
      text: "SECRETKEY123",
    },
    st,
  );
  const delIdx = calls.findIndex(
    (c) => c.method === "deleteMessage" && c.params.message_id === 900,
  );
  assert.ok(delIdx >= 0);
  assert.deepEqual(log.texts.at(-1), { sid: "srch", text: "SECRETKEY123" });
});

test("onText не-secret: сообщение НЕ удаляется, обработчик зван", async () => {
  const { menu, calls, log } = setup();
  const st = await menu.open(10, "20");
  st.screen = "core";
  st.awaitText = { kind: "demo", secret: false, data: {} };
  await menu.onText(
    { chat: { id: 10 }, from: { id: 20 }, message_id: 902, text: "мой ответ" },
    st,
  );
  assert.ok(!calls.some((c) => c.method === "deleteMessage"));
  assert.equal(log.texts.at(-1)?.text, "мой ответ");
});

test("onText: команда прерывает ожидание (flows.end), обработчик НЕ зван", async () => {
  const { menu, flows, log } = setup();
  const st = await menu.open(10, "20");
  st.screen = "srch";
  st.awaitText = { kind: "demo", secret: true, data: {} };
  await menu.onText(
    { chat: { id: 10 }, from: { id: 20 }, message_id: 903, text: "/help" },
    st,
  );
  assert.equal(flows.get(10, "20"), null); // стейт снят
  assert.equal(log.texts.length, 0);
});

// Кнопка корня, чей sid не зарегистрирован в SCREENS, в Telegram превращается в вечный
// спиннер: движок гасит спиннер, ищет экран, не находит и молча выходит. Ни tsgo, ни линт
// этого не видят — sid живёт в строке callback_data. Проверяется весь корень разом.
test("every button on the root screen resolves to a registered screen", () => {
  const view = root.render(
    {},
    {
      tr: (_english: string, russian: string) => russian,
      btn: (text: string, callback_data: string) => ({ text, callback_data }),
    },
  );

  // Псевдо-sid — хендофф в визарды /model и /think, их обрабатывает сам движок (index.ts).
  const known = new Set([...Object.keys(SCREENS), "mdl", "thk"]);
  const sids = view.rows
    .flat()
    .map((button: { callback_data: string }) => button.callback_data)
    .map((data: string) => data.replace(/^iva_menu:/u, "").split(":")[0]);

  assert.ok(sids.length > 0, "the root screen must have buttons at all");
  for (const sid of sids)
    assert.ok(
      known.has(sid),
      `root offers "${sid}", which no screen in SCREENS answers — the button would spin forever`,
    );
  // И наоборот: экран, до которого из корня не дойти, — мёртвый код в реестре.
  const reachable = new Set(sids);
  for (const sid of Object.keys(SCREENS))
    assert.ok(
      reachable.has(sid),
      `SCREENS holds "${sid}", but no root button leads there`,
    );
});
