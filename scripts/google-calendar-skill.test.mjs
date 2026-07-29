import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSkill = (name) =>
  readFileSync(new URL(`../agent/skills/${name}.md`, import.meta.url), "utf8");

const workspace = readSkill("google-workspace");
const create = readSkill("google-calendar-create");
const reschedule = readSkill("google-calendar-reschedule");
const update = readSkill("google-calendar-update");
const remove = readSkill("google-calendar-delete");

test("Google Workspace routes Calendar writes to focused skills", () => {
  for (const name of [
    "google-calendar-create",
    "google-calendar-reschedule",
    "google-calendar-update",
    "google-calendar-delete",
  ]) {
    assert.ok(workspace.includes("`" + name + "`"));
  }
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
  assert.match(create, /явное подтверждение/);
});

test("focused Calendar skills preserve action-specific safety", () => {
  assert.match(reschedule, /сохрани исходную длительность/);
  assert.match(reschedule, /calendar events move/);
  assert.match(reschedule, /useDefault":false/);
  assert.match(update, /полного объекта напоминаний/);
  assert.match(update, /полный итоговый объект/);
  assert.match(update, /sendUpdates/);
  assert.match(remove, /один экземпляр или вся серия/);
  assert.match(remove, /явное подтверждение/);
});

test("mutating existing Calendar events checks for concurrent changes", () => {
  for (const skill of [reschedule, update, remove]) {
    assert.match(skill, /сравни `etag`/);
  }
});

test("focused Calendar skills use affirmative instructions", () => {
  const negativeInstruction =
    /(^|[\s.,:;!?()])(?:не|ни|нельзя|никогда|запрещено|без)(?=$|[\s.,:;!?()])/iu;

  for (const skill of [create, reschedule, update, remove]) {
    assert.doesNotMatch(skill, negativeInstruction);
  }
});
