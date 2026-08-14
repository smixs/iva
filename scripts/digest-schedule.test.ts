/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
// Утренний дайджест — Report, а Report по умолчанию выключен (ADR-0007). Проверяется само
// расписание, поведением: со включённым тумблером ход стартует, без него — не стартует
// ничего, что бы ни лежало в settings.json. Тест живёт в scripts/, а не рядом с расписанием:
// eve собирает authored tree по файлам в agent/schedules/, и лишний файл там стал бы шестым
// расписанием (scripts/eve-schedules-guard.test.ts).
import "./lib/ts-esm-hooks.ts"; // agent/** импортирует соседей как "./x.js" — см. сам хук
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryReportTail, writtenInLanguage } from "./lib/notice-policy.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// settings.ts берёт каталог данных из окружения ОДИН раз, на импорте, поэтому и каталог, и
// переменная задаются до загрузки расписания — иначе тумблер читался бы из настоящего data/.
const DATA = mkdtempSync(join(tmpdir(), "iva-digest-data-"));
const HOME = mkdtempSync(join(tmpdir(), "iva-digest-home-"));
process.env.ASSISTANT_DATA_DIR = DATA;

type Schedule = {
  cron: string;
  run: (context: { waitUntil: (work: Promise<unknown>) => void }) => void;
};

const loaded: unknown = await import(
  new URL("../agent/schedules/digest.ts", import.meta.url).href
);
if (typeof loaded !== "object" || loaded === null || !("default" in loaded))
  throw new Error("the digest schedule has no default export");
const digest = loaded.default as Schedule;

const previousCwd = process.cwd();
// Работа спавнится от рабочего каталога процесса: уводим его в пустой временный, чтобы
// запуск не мог достать настоящий scripts/daily-digest.ts и .env этого репозитория.
mkdirSync(HOME, { recursive: true });
process.chdir(HOME);
after(() => {
  process.chdir(previousCwd);
  rmSync(DATA, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

function fire(settings: string | null): Promise<unknown>[] {
  const path = join(DATA, "settings.json");
  if (settings === null) rmSync(path, { force: true });
  else writeFileSync(path, settings);
  const started: Promise<unknown>[] = [];
  digest.run({ waitUntil: (work) => started.push(work) });
  return started;
}

test("the morning digest stays silent until the owner switches it on", () => {
  for (const settings of [
    null, // свежая установка: файла настроек ещё нет
    "",
    "{ not json",
    "null",
    "[]",
    '"digestSchedule"',
    "{}",
    '{"digestSchedule":null}',
    '{"digestSchedule":{}}',
    '{"digestSchedule":{"enabled":false}}',
    '{"digestSchedule":{"enabled":"true"}}',
    '{"digestSchedule":{"enabled":1}}',
    '{"memoryReports":{"enabled":true}}', // чужой тумблер дайджест не включает
  ])
    assert.deepEqual(
      fire(settings),
      [],
      `settings ${String(settings)} must start no digest`,
    );
});

test("the morning digest runs once the switch says true", async () => {
  const started = fire('{"digestSchedule":{"enabled":true}}');

  assert.equal(started.length, 1, "the job is handed to waitUntil");
  // В пустом временном каталоге нет ни скрипта, ни .env, поэтому ход падает сразу и ничего
  // наружу не отправляет. Дожидаемся его, чтобы не оставить процесс после теста.
  const result = await started[0];
  assert.equal(typeof result, "object");
});

test("the digest keeps the cadence the schedule table declares", async () => {
  const table: unknown = await import(
    new URL("../agent/lib/schedule-table.ts", import.meta.url).href
  );
  const cron = (table as { SCHEDULE_CRON: Record<string, string> })
    .SCHEDULE_CRON.digest;
  assert.equal(digest.cron, cron);
});

// Второй плановый отправитель обязан говорить модели ровно то же, что первый: результат хода
// доставляет код. Проверка грепом — промпт исполняет модель, иначе его не проверить; зато
// формулировка берётся из хвоста rollup, поэтому разъехаться они не могут.
test("the digest prompt forbids self-delivery in the same words as the rollup", () => {
  const clause =
    "Do not send it anywhere yourself: no rich messages, no digest chat, no Telegram tools.";
  assert.ok(
    memoryReportTail((english) => english).includes(clause),
    "the shared clause must be the one the rollup tail really carries",
  );

  const script = readFileSync(join(ROOT, "scripts/daily-digest.ts"), "utf8");
  // Промпт склеен из строковых литералов, поэтому сравнивается склеенный вид.
  const prompt = script.replace(/"\s*\+\s*\n?\s*"/gu, "");
  assert.ok(
    prompt.includes(clause),
    "scripts/daily-digest.ts must carry the same no-self-delivery clause",
  );
  assert.match(prompt, /Return the digest as the final text of this turn\./u);
});

// Язык — вторая половина той же жалобы: без явной фразы системный блок 05-language тянет
// плановый ход на язык инструкции, и дайджест приходит по-английски на русской установке.
// Формулировка у обоих ходов одна функция, поэтому разъехаться они не могут.
test("the digest prompt names the language the same way the rollup does", () => {
  assert.equal(
    writtenInLanguage((english) => english),
    "written in English",
  );
  assert.equal(
    writtenInLanguage((_english, russian) => russian),
    "written in Russian",
  );
  assert.ok(
    memoryReportTail((english) => english).includes(
      writtenInLanguage((english) => english),
    ),
    "the rollup tail must take the phrase from the shared function",
  );

  const script = readFileSync(join(ROOT, "scripts/daily-digest.ts"), "utf8");
  assert.match(
    script,
    /\$\{writtenInLanguage\(tr\)\}/u,
    "scripts/daily-digest.ts must name the language through the same function",
  );
  assert.match(script, /import \{ tr \} from "#lib\/i18n\.ts";/u);
});
