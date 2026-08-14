/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test from "node:test";
import assert from "node:assert/strict";

import root from "./root.ts";

function makeCtx(lang: string) {
  return {
    tr: (en: string, ru: string) => (lang === "ru" ? ru : en),
    btn: (text: string, callback_data: string) => ({ text, callback_data }),
  };
}

const englishRows = [
  [
    ["🧠 Model", "iva_menu:mdl"],
    ["🤔 Thinking", "iva_menu:thk"],
  ],
  [
    ["🔍 Search", "iva_menu:srch:o"],
    ["🌐 Language", "iva_menu:lang:o"],
  ],
  [
    ["🎭 Character", "iva_menu:chr:o"],
    ["💾 Memory", "iva_menu:core:o"],
  ],
  [
    ["📡 Userbot", "iva_menu:ub:o"],
    ["🔗 Google", "iva_menu:gws:o"],
  ],
  [
    ["⏰ Timers", "iva_menu:cron:o"],
    ["🔔 Notices", "iva_menu:ntc:o"],
  ],
  [
    ["🧩 Skills", "iva_menu:sk:o"],
    ["📊 Status", "iva_menu:st:o"],
  ],
  [["🛠 Maintenance", "iva_menu:svc:o"]],
  [["✖ Close", "iva_menu:r:x"]],
];

const russianRows = [
  [
    ["🧠 Модель", "iva_menu:mdl"],
    ["🤔 Размышления", "iva_menu:thk"],
  ],
  [
    ["🔍 Поиск", "iva_menu:srch:o"],
    ["🌐 Язык", "iva_menu:lang:o"],
  ],
  [
    ["🎭 Характер", "iva_menu:chr:o"],
    ["💾 Память", "iva_menu:core:o"],
  ],
  [
    ["📡 Userbot", "iva_menu:ub:o"],
    ["🔗 Google", "iva_menu:gws:o"],
  ],
  [
    ["⏰ Кроны", "iva_menu:cron:o"],
    ["🔔 Уведомления", "iva_menu:ntc:o"],
  ],
  [
    ["🧩 Скиллы", "iva_menu:sk:o"],
    ["📊 Статус", "iva_menu:st:o"],
  ],
  [["🛠 Обслуживание", "iva_menu:svc:o"]],
  [["✖ Закрыть", "iva_menu:r:x"]],
];

function compact(
  rows: Array<Array<{ text: string; callback_data: string }>>,
): Array<Array<[string, string]>> {
  return rows.map((row) =>
    row.map(({ text, callback_data }) => [text, callback_data]),
  );
}

test("root preserves English row order, callbacks, and close action", () => {
  const state = { page: 3 };
  const view = root.render(state, makeCtx("en"));

  assert.equal(view.text, "⚙️ Settings\n\nPick a section.");
  assert.deepEqual(compact(view.rows), englishRows);
  assert.deepEqual(state, { page: 3 });
});

test("root translates labels without changing callback routing", () => {
  const view = root.render({}, makeCtx("ru"));

  assert.equal(view.text, "⚙️ Настройки\n\nВыбери раздел.");
  assert.deepEqual(compact(view.rows), russianRows);
  assert.deepEqual(
    compact(view.rows)
      .flat()
      .map(([, callback]) => callback),
    englishRows.flat().map(([, callback]) => callback),
  );
});

test("root exposes the top-level screen contract", () => {
  assert.equal(root.parent, null);
  assert.equal(root.on("ignored", [], {}, makeCtx("en")), undefined);
});
