import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSkill = (name) =>
  readFileSync(new URL(`../agent/skills/${name}.md`, import.meta.url), "utf8");

const instructions = readFileSync(
  new URL("../agent/instructions.md", import.meta.url),
  "utf8",
);
const workspace = readSkill("google-workspace");
const create = readSkill("google-calendar-create");
const reschedule = readSkill("google-calendar-reschedule");
const update = readSkill("google-calendar-update");
const remove = readSkill("google-calendar-delete");

const readDescription = (skill) =>
  skill.match(/^---\s*\ndescription:\s*(.+)\n---/u)?.[1] ?? "";

test("Eve can route Calendar mutations directly from skill descriptions", () => {
  assert.match(readDescription(create), /создания события Google Calendar/);
  assert.match(readDescription(reschedule), /переноса времени.*длительности/s);
  assert.match(readDescription(update), /изменения названия.*напоминаний/s);
  assert.match(readDescription(remove), /удаления события/);
  assert.doesNotMatch(readDescription(workspace), /создать событие|создай встречу/u);
  assert.doesNotMatch(workspace, /google-calendar-(?:create|reschedule|update|delete)/u);
  assert.match(instructions, /Вывод — структурированный\s+JSON/s);
  assert.doesNotMatch(instructions, /сначала загрузи скилл `google-workspace`/u);
  assert.match(instructions, /код выхода 2.*загрузи скилл `google-workspace`/s);
});

test("Google Calendar policy creates one event with explicit reminders", () => {
  assert.match(create, /один\s+объект Google Calendar/);
  assert.match(create, /reminders\.useDefault: false/);
  assert.match(create, /reminders\.overrides/);
  assert.match(create, /до пяти напоминаний/);
});

test("Google Calendar policy persists defaults and validates writes", () => {
  assert.match(create, /Calendar defaults:/);
  assert.match(create, /CORE\.md/);
  assert.match(create, /gws schema calendar\.events\.insert/);
  assert.match(create, /calendar events insert/);
  assert.match(create, /--dry-run/);
});

test("Google Calendar policy covers event boundaries and sensitive data", () => {
  assert.match(create, /end\.date.*следующий день/s);
  assert.match(create, /физический адрес в `location`/);
  assert.match(create, /Проверяй.*чувствительн/s);
  assert.match(create, /категории и маскированные\s+идентификаторы/s);
  assert.match(create, /явное подтверждение/);
});

test("Google Calendar creation preserves safety order and request boundaries", () => {
  const dryRun = create.indexOf("insert` с `--dry-run`");
  const confirmation = create.indexOf("запроси явное подтверждение", dryRun);
  const liveInsert = create.indexOf("запрос в рабочем режиме", confirmation);

  assert.ok(dryRun >= 0 && dryRun < confirmation && confirmation < liveInsert);
  assert.match(create, /`sendUpdates` в `--params` рядом с `calendarId`/);
  assert.match(create, /в `--json` передавай ресурс\s+события/s);
  assert.match(create, /`nextPageToken`.*`pageToken`.*последней страницы/s);
});

test("focused Calendar skills preserve action-specific safety", () => {
  assert.match(reschedule, /сохрани исходную длительность/);
  assert.match(reschedule, /calendar events move/);
  assert.match(reschedule, /useDefault":false/);
  assert.match(update, /полного объекта напоминаний/);
  assert.match(update, /полный итоговый объект/);
  assert.match(update, /sendUpdates/);
  assert.match(update, /родительское событие по `recurringEventId`/);
  assert.match(update, /полный итоговый массив/);
  assert.match(remove, /один экземпляр или вся серия/);
  assert.match(remove, /ID экземпляра как `eventId`/);
  assert.match(remove, /явное подтверждение/);

  for (const skill of [reschedule, update, remove]) {
    assert.match(skill, /sendUpdates.*`--params`/s);
  }
});

test("mutating existing Calendar events checks for concurrent changes", () => {
  for (const skill of [reschedule, update, remove]) {
    assert.match(skill, /сравни `etag`.*При совпадении/s);
  }
});

test("multi-step Calendar moves define partial-failure recovery", () => {
  assert.match(reschedule, /Первая ошибка завершает\s+последовательность/s);
  assert.match(reschedule, /выполненные и ожидающие шаги/);
  assert.match(reschedule, /компенсацию выполненного patch/);
  assert.match(reschedule, /events move`.*через `--params`/s);
});

test("focused Calendar skills use affirmative instructions", () => {
  const negativeInstruction =
    /(?<!\p{L})(?:не|ни|нельзя|никогда|запрещено|без)(?!\p{L})/iu;

  for (const fixture of ["—не", "«ни»", "**без**", "`никогда`", "(запрещено)"]) {
    assert.match(fixture, negativeInstruction);
  }

  for (const fixture of ["небо", "нитка", "бездна", "никогдашний"]) {
    assert.doesNotMatch(fixture, negativeInstruction);
  }

  for (const skill of [create, reschedule, update, remove]) {
    assert.doesNotMatch(skill, negativeInstruction);
  }
});
