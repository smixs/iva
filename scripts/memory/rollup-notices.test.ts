/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
// Контракт ночной свёртки как ОТПРАВИТЕЛЯ — и он честно грепный, а не поведенческий.
//
// Поведение доставки живёт в scripts/lib/notice-policy.test.ts и проверено там настоящим
// транспортом: сколько сообщений уходит за прогон, какое именно, что видит свежая
// установка в первую и во вторую ночь. Сам rollup.ts здесь запустить нечем — он ведёт
// живого агента через eve/client, — а промпт исполняет модель, и ни то ни другое в
// юнит-тесте не воспроизводится. Поэтому здесь проверяется ровно то, что проверяемо
// текстом: что свёртка отдала решение политике и передала ей правильный признак, что
// молчаливые периоды остались молчаливыми, и что системный красный блок инструкций не
// спорит с хвостом ночного промпта.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const source = readFileSync(join(HERE, "rollup.ts"), "utf8");

/** Тело блока «этот период вообще может писать в Telegram», от заголовка до конца файла. */
function deliveryBlock(): string {
  const at = source.indexOf("if (REPORTS_TO_TELEGRAM[period]) {");
  assert.notEqual(at, -1, "the delivery block must stay one readable place");
  return source.slice(at);
}

test("monthly and yearly rollups stay silent, as they always were", () => {
  const table = /const REPORTS_TO_TELEGRAM[^;]+;/u.exec(source)?.[0] ?? "";
  assert.match(table, /daily: true/u);
  assert.match(table, /weekly: true/u);
  assert.match(table, /monthly: false/u);
  assert.match(table, /yearly: false/u);
});

test("what leaves the chat is decided by the policy, not by the script", () => {
  const block = deliveryBlock();
  assert.match(block, /await deliverMemoryReport\(\{/u);
  assert.match(block, /settings,/u);
  assert.match(block, /ranBefore: RAN_BEFORE,/u);
  // Оба шва отправки — только аргументы этого решения; своей отправки у свёртки нет.
  assert.equal(source.split("sendTelegramHtml(").length - 1, 2);
  assert.match(
    block,
    /report: \(text: string\) => sendTelegramHtml\(BOT, CHAT, text\)/u,
  );
  assert.match(
    block,
    /notice: \(text: string\) => sendTelegramHtml\(BOT, CHAT, text\)/u,
  );
  // Чат не настроен — решение о Notice всё равно принимается: send просто null.
  assert.match(block, /: null;/u);
  assert.match(block, /send,/u);
});

test("the run reads the traces of past runs before it leaves its own", () => {
  // Единственная проводка, которую политика увидеть не может: след читается ДО того, как
  // прогон оставит свой собственный. Прочитанный после, он был бы true у всех.
  assert.match(
    source,
    /const RAN_BEFORE = rollupRanBefore\(DATA_DIR, VAULT\);/u,
  );
  assert.ok(
    source.indexOf("const RAN_BEFORE") < source.indexOf("saveSession("),
    "reading it after the save would make every installation look old",
  );
});

test("the delivery half of the prompt is the one that carries the language", () => {
  assert.match(source, /const tail = memoryReportTail\(tr\);/u);
  // Хардкод старого хвоста ушёл целиком: иначе отчёт снова поедет на языке инструкции.
  assert.doesNotMatch(source, /what was created\/updated/u);
  assert.doesNotMatch(source, /Only the finished report/u);
  // Обработка карточек не тронута: язык добавлен только в доставку.
  assert.match(source, /Prefer the write_card tool over write_file/u);
  assert.match(source, /no H1\/H2 headings/u);
});

test("the red line in the instructions exempts both scheduled senders", () => {
  // Красный блок системных инструкций требует rich message для ЛЮБОГО отчёта. Без явного
  // исключения он спорит с хвостом промпта, кричит громче — и владелец получает второе
  // сообщение мимо кода доставки.
  const instructions = readFileSync(
    join(ROOT, "agent/instructions.md"),
    "utf8",
  );
  const red = instructions.slice(0, instructions.indexOf("\nТы — **Iva**"));
  assert.match(red, /ЛЮБОЙ ОТЧЁТ.*ТОЛЬКО RICH MESSAGE/u);
  const at = red.indexOf("ИСКЛЮЧЕНИЕ");
  assert.notEqual(at, -1, "the red line must carry an exception at all");
  const exception = red.slice(at);
  assert.match(exception, /ФИНАЛЬНЫЙ ТЕКСТ хода/u);
  assert.match(exception, /ЗАПРЕЩЕН/u);
  // Оба хода названы В САМОМ исключении, одним предложением: упоминание дайджеста рядом —
  // например во фразе «дайджест из чата — обычный ход» — этому не удовлетворяет.
  assert.match(
    exception,
    /Их два:[^.]*rollup[^.]*утренний дайджест по расписанию/u,
    "the exception itself must name the nightly rollup and the scheduled digest",
  );
});
