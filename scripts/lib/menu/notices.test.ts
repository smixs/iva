/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// settings.ts берёт каталог данных из окружения на импорте — задаём ДО загрузки экрана,
// чтобы тумблер не тронул настоящий data/ (тот же приём, что в lang.test.ts).
const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-notices-"));
process.env.ASSISTANT_DATA_DIR = dataDir;

const loaded: unknown = await import(
  new URL("./notices.ts", import.meta.url).href
);
if (typeof loaded !== "object" || loaded === null || !("default" in loaded))
  throw new Error("notices menu has no default screen");
const screen = loaded.default as Screen;

after(() => rmSync(dataDir, { recursive: true, force: true }));

type Button = { text: string; callback_data: string };
type View = { text: string; rows: Button[][] };
type MenuState = { page: number };
type MenuContext = {
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screenId: string) => Button[];
  show: (state: MenuState, screenId: string) => Promise<void>;
};
type Screen = {
  parent: string;
  render: (state: MenuState, context: MenuContext) => View;
  on: (
    verb: string,
    args: string[],
    state: MenuState,
    context: MenuContext,
  ) => Promise<void>;
};

const settingsPath = join(dataDir, "settings.json");

function writeSettingsFile(settings: Record<string, unknown>): void {
  writeFileSync(settingsPath, JSON.stringify(settings));
}

function readSettingsFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
    string,
    unknown
  >;
}

function makeContext(lang: string, redrawn: string[] = []): MenuContext {
  return {
    tr: (english, russian) => (lang === "ru" ? russian : english),
    btn: (text, callbackData) => ({ text, callback_data: callbackData }),
    backRow: (screenId) => [
      { text: "Back", callback_data: `iva_menu:${screenId}:o` },
    ],
    show: (_state, screenId) => {
      redrawn.push(screenId);
      return Promise.resolve();
    },
  };
}

const labels = (view: View) =>
  view.rows.flat().map((button) => [button.text, button.callback_data]);

test("both toggles render off on a fresh installation, in either language", () => {
  rmSync(settingsPath, { force: true });

  const russian = screen.render({ page: 3 }, makeContext("ru"));
  assert.match(russian.text, /🔔 Уведомления/);
  assert.match(
    russian.text,
    /Алерты — о проблемах и обновлениях — приходят всегда/,
  );
  assert.deepEqual(labels(russian), [
    ["○ Отчёты памяти", "iva_menu:ntc:set:rep:1"],
    ["○ Утренний дайджест", "iva_menu:ntc:set:dig:1"],
    ["Back", "iva_menu:r:o"],
  ]);

  const english = screen.render({ page: 0 }, makeContext("en"));
  assert.match(english.text, /🔔 Notices/);
  assert.match(english.text, /Alerts — problems and updates — always arrive/);
  assert.deepEqual(labels(english), [
    ["○ Memory reports", "iva_menu:ntc:set:rep:1"],
    ["○ Morning digest", "iva_menu:ntc:set:dig:1"],
    ["Back", "iva_menu:r:o"],
  ]);
  assert.equal(screen.parent, "r");
});

test("a switched-on toggle is ticked and offers the way back off", () => {
  writeSettingsFile({
    memoryReports: { enabled: true },
    digestSchedule: { enabled: true },
  });

  assert.deepEqual(labels(screen.render({ page: 0 }, makeContext("ru"))), [
    ["✓ Отчёты памяти", "iva_menu:ntc:set:rep:0"],
    ["✓ Утренний дайджест", "iva_menu:ntc:set:dig:0"],
    ["Back", "iva_menu:r:o"],
  ]);
});

test("a toggle writes its own key and leaves the neighbours alone", async () => {
  // Соседи двух видов: чужой ключ верхнего уровня (язык, второй тумблер) и сосед ВНУТРИ
  // того же объекта. Второго сегодня в коде нет — и потому он здесь: тумблер обязан патчить
  // вложенный объект целиком, а не переписывать его одним своим полем.
  writeSettingsFile({
    language: "en",
    digestSchedule: { enabled: true },
    memoryReports: { enabled: false, chatId: "123" },
  });
  const redrawn: string[] = [];
  const context = makeContext("ru", redrawn);

  await screen.on("set", ["rep", "1"], { page: 4 }, context);

  assert.deepEqual(readSettingsFile(), {
    language: "en",
    digestSchedule: { enabled: true },
    memoryReports: { enabled: true, chatId: "123" },
  });
  assert.deepEqual(redrawn, ["ntc"], "the screen redraws itself, not the root");

  await screen.on("set", ["dig", "0"], { page: 0 }, context);
  assert.deepEqual(readSettingsFile(), {
    language: "en",
    digestSchedule: { enabled: false },
    memoryReports: { enabled: true, chatId: "123" },
  });
});

test("a stale tap sets the value it carries instead of flipping twice", async () => {
  writeSettingsFile({ memoryReports: { enabled: true } });
  const context = makeContext("ru");

  await screen.on("set", ["rep", "1"], { page: 0 }, context);
  await screen.on("set", ["rep", "1"], { page: 0 }, context);

  assert.deepEqual(readSettingsFile(), { memoryReports: { enabled: true } });
});

test("junk callback arguments change nothing and throw nothing", async () => {
  writeSettingsFile({ memoryReports: { enabled: true } });
  const before = readSettingsFile();
  const redrawn: string[] = [];
  const context = makeContext("en", redrawn);

  for (const args of [
    [],
    [""],
    ["rep"],
    ["rep", ""],
    ["rep", "true"],
    ["rep", "yes", "please"],
    ["REP", "1"],
    ["dig", "2"],
    ["toString", "1"],
    ["constructor", "1"],
    ["__proto__", "1"],
    ["hasOwnProperty", "0"],
  ])
    await screen.on("set", args, { page: 0 }, context);
  // Неизвестный верб тоже ничего не делает.
  await screen.on("rf", ["rep", "1"], { page: 0 }, context);

  assert.deepEqual(readSettingsFile(), before);
  assert.deepEqual(redrawn, [], "a junk tap redraws nothing");
});

test("a settings file that is not an object cannot break the screen", async () => {
  for (const corrupt of ["", "{ not json", "null", "[]", '"ru"', "42"]) {
    writeFileSync(settingsPath, corrupt);
    const view = screen.render({ page: 0 }, makeContext("en"));
    assert.deepEqual(labels(view)[0], [
      "○ Memory reports",
      "iva_menu:ntc:set:rep:1",
    ]);
    await screen.on("set", ["rep", "1"], { page: 0 }, makeContext("en"));
    assert.deepEqual(readSettingsFile(), { memoryReports: { enabled: true } });
  }
});
