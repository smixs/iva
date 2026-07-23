import test from "node:test";
import assert from "node:assert/strict";
import { createFlows } from "./tg-flow.mjs";

// Мок Bot API: копит вызовы и отвечает по очереди из responses (или ok по умолчанию).
// Каждый ответ — то, что реально возвращает мостовая обёртка tg(): { ok, result, description }.
function makeTg(responses = []) {
  const calls = [];
  let auto = 100;
  const tg = async (method, params) => {
    calls.push({ method, params });
    if (responses.length) return responses.shift();
    // По умолчанию — успех; sendMessage выдаёт растущий message_id.
    return { ok: true, result: { message_id: auto++ } };
  };
  return { tg, calls };
}

test("start сеет полный стейт и кладёт его в стор под ключом chatId:userId", () => {
  const { tg } = makeTg();
  const flows = createFlows({ tg });
  const st = flows.start(10, 20, "model");
  assert.equal(flows.key(10, 20), "10:20");
  assert.deepEqual(
    { flow: st.flow, chatId: st.chatId, userId: st.userId, msgId: st.msgId, awaitText: st.awaitText, screen: st.screen, page: st.page, data: st.data },
    { flow: "model", chatId: 10, userId: 20, msgId: null, awaitText: null, screen: null, page: 0, data: {} },
  );
  assert.equal(flows.get(10, 20), st);
});

test("start(...extra) подмешивает поля (msgId меню) в свежий стейт", () => {
  const { tg } = makeTg();
  const flows = createFlows({ tg });
  const st = flows.start(1, 2, "menu", { msgId: 555, screen: "r" });
  assert.equal(st.msgId, 555);
  assert.equal(st.screen, "r");
  assert.equal(st.flow, "menu");
});

test("screen без msgId шлёт новое сообщение и запоминает message_id", async () => {
  const { tg, calls } = makeTg([{ ok: true, result: { message_id: 777 } }]);
  const flows = createFlows({ tg });
  const st = flows.start(5, 6, "think");
  await flows.screen(st, "привет", [[{ text: "A", callback_data: "x" }]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendMessage");
  assert.deepEqual(calls[0].params.reply_markup, { inline_keyboard: [[{ text: "A", callback_data: "x" }]] });
  assert.equal(st.msgId, 777);
});

test("screen с msgId правит на месте, без фолбэка при ok", async () => {
  const { tg, calls } = makeTg([{ ok: true }]);
  const flows = createFlows({ tg });
  const st = flows.start(5, 6, "think");
  st.msgId = 42;
  await flows.screen(st, "экран", null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "editMessageText");
  assert.equal(calls[0].params.message_id, 42);
  assert.equal(calls[0].params.reply_markup, undefined); // rows отсутствуют -> reply_markup не задаётся
  assert.equal(st.msgId, 42);
});

test('«not modified» на правке считается успехом — фолбэка нет', async () => {
  const { tg, calls } = makeTg([{ ok: false, description: "Bad Request: message is not modified" }]);
  const flows = createFlows({ tg });
  const st = flows.start(5, 6, "think");
  st.msgId = 42;
  await flows.screen(st, "тот же текст");
  assert.equal(calls.length, 1); // только editMessageText, никакого sendMessage
  assert.equal(calls[0].method, "editMessageText");
  assert.equal(st.msgId, 42);
});

test("правка не удалась (сообщение удалено) — фолбэк на новое сообщение с новым msgId", async () => {
  const { tg, calls } = makeTg([
    { ok: false, description: "Bad Request: message to edit not found" },
    { ok: true, result: { message_id: 900 } },
  ]);
  const flows = createFlows({ tg });
  const st = flows.start(5, 6, "think");
  st.msgId = 42;
  await flows.screen(st, "новый экран");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "editMessageText");
  assert.equal(calls[1].method, "sendMessage");
  assert.equal(st.msgId, 900);
});

test("identity-replace: повторный start заменяет слот; старый объект больше не в сторе", () => {
  const { tg } = makeTg();
  const flows = createFlows({ tg });
  const first = flows.start(1, 2, "model");
  const second = flows.start(1, 2, "menu");
  assert.notEqual(first, second);
  assert.equal(flows.get(1, 2), second);
  // Осиротевшая континуация старого стейта сама себя отбрасывает по identity.
  assert.equal(flows.get(1, 2) !== first, true);
});

test("get чистит протухший по TTL стейт и отдаёт null; touch продлевает жизнь", () => {
  const { tg } = makeTg();
  const flows = createFlows({ tg });
  const st = flows.start(3, 4, "model");
  // Состарим стейт за пределы 15-минутного TTL.
  st.createdAt = Date.now() - (16 * 60 * 1000);
  assert.equal(flows.get(3, 4), null); // протух -> удалён
  assert.equal(flows.get(3, 4), null); // и правда снят из стора

  const st2 = flows.start(3, 4, "model");
  st2.createdAt = Date.now() - (16 * 60 * 1000);
  flows.touch(st2); // меню продлевает createdAt -> флоу не протухает
  assert.equal(flows.get(3, 4), st2);
});

test("end снимает стейт и рисует финальный экран с опциональными rows", async () => {
  const { tg, calls } = makeTg([{ ok: true }]);
  const flows = createFlows({ tg });
  const st = flows.start(7, 8, "menu");
  st.msgId = 111;
  const menuRow = [[{ text: "‹ Меню", callback_data: "iva_menu:r:o" }]];
  await flows.end(st, "готово", menuRow);
  assert.equal(flows.get(7, 8), null); // стейт удалён
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "editMessageText");
  assert.deepEqual(calls[0].params.reply_markup, { inline_keyboard: menuRow });
});

test("end без rows — терминальный экран без клавиатуры", async () => {
  const { tg, calls } = makeTg([{ ok: true, result: { message_id: 5 } }]);
  const flows = createFlows({ tg });
  const st = flows.start(7, 8, "model"); // msgId=null -> уйдёт как sendMessage
  await flows.end(st, "сохранил");
  assert.equal(flows.get(7, 8), null);
  assert.equal(calls[0].method, "sendMessage");
  assert.equal(calls[0].params.reply_markup, undefined);
});
