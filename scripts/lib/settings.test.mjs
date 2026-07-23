import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// settings.mjs фиксирует каталог данных на импорте, поэтому ASSISTANT_DATA_DIR ставим
// ДО динамического импорта. Абсолютный temp-путь заодно уводит запись подальше от
// репо (ветку прода трогать нельзя) и минует cwd-относительную ветку — её проверяем
// отдельным подпроцессом ниже.
const DATA_DIR = mkdtempSync(join(tmpdir(), "iva-settings-"));
process.env.ASSISTANT_DATA_DIR = DATA_DIR;
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const { readSettings, writeSettings } = await import("./settings.mjs");

function reset() {
  rmSync(SETTINGS_FILE, { force: true });
  rmSync(`${SETTINGS_FILE}.tmp`, { force: true });
}

test("readSettings returns {} when the file is missing", () => {
  reset();
  assert.deepEqual(readSettings(), {});
});

test("readSettings returns {} on corrupt JSON", () => {
  reset();
  writeFileSync(SETTINGS_FILE, "{ broken");
  assert.deepEqual(readSettings(), {});
});

test("readSettings returns {} for non-object JSON", () => {
  reset();
  writeFileSync(SETTINGS_FILE, "42");
  assert.deepEqual(readSettings(), {});
});

test("writeSettings persists and returns the merged object", () => {
  reset();
  assert.deepEqual(writeSettings({ language: "ru" }), { language: "ru" });
  assert.deepEqual(readSettings(), { language: "ru" });
});

test("writeSettings merges over existing keys", () => {
  reset();
  writeSettings({ language: "ru" });
  assert.deepEqual(writeSettings({ theme: "dark" }), { language: "ru", theme: "dark" });
  assert.deepEqual(writeSettings({ language: "en" }), { language: "en", theme: "dark" });
});

test("a null patch value deletes the key", () => {
  reset();
  writeSettings({ language: "ru", theme: "dark" });
  assert.deepEqual(writeSettings({ theme: null }), { language: "ru" });
  assert.deepEqual(readSettings(), { language: "ru" });
});

test("deleting a missing key is a no-op", () => {
  reset();
  writeSettings({ language: "ru" });
  assert.deepEqual(writeSettings({ missing: null }), { language: "ru" });
});

test("the write is atomic: no leftover .tmp and the file is valid JSON", () => {
  reset();
  writeSettings({ language: "ru" });
  const leftovers = readdirSync(DATA_DIR).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
  assert.deepEqual(JSON.parse(readFileSync(SETTINGS_FILE, "utf8")), { language: "ru" });
});

test("data dir defaults to <cwd>/data for a relative ASSISTANT_DATA_DIR", () => {
  // Абсолютный ASSISTANT_DATA_DIR у родителя минует эту ветку, поэтому проверяем её
  // в отдельном процессе с cwd=temp и без ASSISTANT_DATA_DIR (дефолт "data").
  const cwd = mkdtempSync(join(tmpdir(), "iva-settings-cwd-"));
  const url = pathToFileURL(join(import.meta.dirname, "settings.mjs")).href;
  const code = 'const { writeSettings } = await import(process.env.__URL); writeSettings({ language: "en" });';
  const env = { ...process.env, __URL: url };
  delete env.ASSISTANT_DATA_DIR;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], { env, cwd, encoding: "utf8" });
  assert.deepEqual(
    JSON.parse(readFileSync(join(cwd, "data", "settings.json"), "utf8")),
    { language: "en" },
  );
});
