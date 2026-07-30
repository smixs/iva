// Тесты write_card: слияние вместо перезаписи, идентичность по H1 (легаси-слаги),
// алиасы типов, безопасный YAML, конфликт кандидатов.
// Запуск: node --test scripts/write-card.test.mjs  (TS импортируется напрямую — Node 24
// стрипает типы; отдельная сборка не нужна).

import "./lib/ts-esm-hooks.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const VAULT = mkdtempSync(join(tmpdir(), "iva-card-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
process.env.ASSISTANT_TIMEZONE = "UTC";
mkdirSync(join(VAULT, "cards", "contacts"), { recursive: true });
mkdirSync(join(VAULT, "cards", "notes"), { recursive: true });
cpSync(join(REPO, "vault-template", "schema.json"), join(VAULT, "schema.json"));

process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

// Модуль читает схему на импорте — env выставлен выше.
const writeCard = (await import(join(REPO, "agent", "tools", "write_card.ts"))).default;
const call = (args) => writeCard.execute(writeCard.inputSchema.parse(args));

const read = (rel) => readFileSync(join(VAULT, rel), "utf8");

// Реальная карточка: без title во frontmatter, свёрнутый скаляр description, латинский
// легаси-слаг при кириллическом H1, поля вне схемы тула (tier/relevance/phone/…).
const LEGACY = `---
type: contact
description: >-
  Ясмин — AI-контент криейтор, фрилансер. Связалась через Telegram с предложением услуг.
tags: [contact, freelancer]
status: active
created: 2026-06-29
source: daily/2026-06-29.md
relevance: 0.55
tier: cold
domain: work
last_accessed: 2026-06-27
access_count: 1
phone: "+998 90 000 00 00"
---

# Ясмин (AI Content Creator)

Связалась через личный Telegram Шимы 29.06.2026 с холодным предложением услуг.

## Портфолио
https://drive.google.com/drive/folders/abc
`;

test("повторный write_card сливает карточку: поля вне схемы, created и старый body живы", async () => {
  writeFileSync(join(VAULT, "cards/contacts/yasmin.md"), LEGACY, "utf8");

  const res = await call({
    type: "contact",
    title: "Ясмин",
    description: "AI-контент криейтор, прислала новую смету",
    tags: ["contact", "ai-content"],
    body: "Прислала смету на видеоролик: 400 USD за 30 секунд.",
  });

  assert.equal(res.ok, true);
  // Найден легаси-файл, а не создан дубль «ясмин.md».
  assert.equal(res.file, "cards/contacts/yasmin.md");
  assert.equal(res.matchedBy, "title");
  assert.equal(res.action, "merged");

  const out = read("cards/contacts/yasmin.md");
  for (const kept of [
    "relevance: 0.55",
    "tier: cold",
    "last_accessed: 2026-06-27",
    "access_count: 1",
    "created: 2026-06-29",
    "source: daily/2026-06-29.md",
  ]) {
    assert.ok(out.includes(kept), `потеряно поле: ${kept}`);
  }
  assert.ok(out.includes('phone: "+998 90 000 00 00"'), "потерян phone");
  assert.ok(out.includes("Портфолио"), "потерян старый body");
  assert.ok(out.includes("холодным предложением услуг"), "потерян старый текст");
  assert.ok(out.includes("400 USD"), "новый текст не дописан");
  // description обновлён и не задвоен (исторический баг свёрнутых скаляров).
  assert.equal(out.match(/^description:/gm).length, 1);
  assert.ok(!out.includes("Связалась через Telegram с предложением услуг."), "старый description остался");
  // Теги слиты, а не заменены.
  const tags = /^tags: \[(.*)\]$/m.exec(out)[1];
  assert.ok(tags.includes("freelancer") && tags.includes("ai-content"));
  // Один frontmatter, один H1.
  assert.equal(out.match(/^---$/gm).length, 2);
  assert.equal(out.match(/^# /gm).length, 1);
});

test("тот же body второй раз не дублируется", async () => {
  const args = {
    type: "note",
    title: "Заметка про кэш",
    description: "Кэш инвалидируется по тегам",
    tags: ["note", "cache"],
    body: "Инвалидация кэша идёт по тегам, TTL 300 секунд.",
  };
  const first = await call(args);
  assert.equal(first.action, "created");
  const second = await call(args);
  assert.equal(second.action, "updated");
  const out = read(second.file);
  assert.equal(out.match(/TTL 300 секунд/g).length, 1);
  assert.ok(!out.includes("## Обновление"));
});

test("алиас типа person → contact применяется до валидации", async () => {
  const res = await call({
    type: "person",
    title: "Тестовый Контакт",
    description: "проверка алиаса",
    tags: ["contact"],
    body: "Алиас person должен маппиться в contact.",
  });
  assert.equal(res.ok, true);
  assert.equal(res.type, "contact");
  assert.ok(res.file.startsWith("cards/contacts/"));
});

test("алиас в тип вне тула (daily) по-прежнему отклоняется", () => {
  assert.throws(() => writeCard.inputSchema.parse({
    type: "daily",
    title: "x",
    description: "x",
    tags: ["x"],
    body: "x",
  }));
});

test("description длиннее 500 символов отклоняется с просьбой сократить", () => {
  assert.throws(
    () =>
      writeCard.inputSchema.parse({
        type: "note",
        title: "Слишком длинное описание",
        description: "x".repeat(501),
        tags: ["note"],
        body: "тело",
      }),
    /максимум 500 символов; сократи/,
  );
});

test("tags и domain квотируются, если содержат YAML-спецсимволы", async () => {
  const res = await call({
    type: "note",
    title: "YAML квотинг",
    description: "проверка квотинга",
    tags: ["a: b", "plain"],
    domain: "work: personal",
    body: "тело",
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const out = read(res.file);
  // Пробелы в теге схлопываются в дефис, но двоеточие остаётся — элемент обязан быть в кавычках.
  assert.ok(out.includes('tags: ["a:-b", plain]'), out);
  assert.ok(out.includes('domain: "work: personal"'), out);
});

test("несколько кандидатов по заголовку → отказ без записи", async () => {
  const dir = join(VAULT, "cards", "notes");
  const card = (h1) => `---\ntype: note\nstatus: active\n---\n\n# ${h1}\n\nтекст\n`;
  writeFileSync(join(dir, "dup-a.md"), card("Дубль Тема"), "utf8");
  writeFileSync(join(dir, "dup-b.md"), card("Дубль Тема (второй)"), "utf8");

  const res = await call({
    type: "note",
    title: "Дубль Тема",
    description: "конфликт",
    tags: ["note"],
    body: "новый текст",
  });
  assert.equal(res.ok, false);
  assert.equal(res.candidates.length, 2);
  assert.ok(!readFileSync(join(dir, "dup-a.md"), "utf8").includes("новый текст"));
  assert.ok(!readFileSync(join(dir, "dup-b.md"), "utf8").includes("новый текст"));
});

test("related дописываются в существующую секцию без дублей", async () => {
  const base = {
    type: "note",
    title: "Связи",
    description: "проверка related",
    tags: ["note"],
    body: "первичный текст",
    related: ["majento"],
  };
  const first = await call(base);
  await call({ ...base, body: "второй текст", related: ["majento", "aimasters"] });
  const out = read(first.file);
  assert.equal(out.match(/^## Related$/gm).length, 1);
  assert.equal(out.match(/\[\[majento\]\]/g).length, 1);
  assert.ok(out.includes("[[aimasters]]"));
});

// ─── лок и атомарная запись ────────────────────────────────────────────────
const { acquireLock, atomicWrite } = await import(join(REPO, "agent", "lib", "card-store.ts"));

test("лок сериализует запись: второй захват ждёт и падает по таймауту", () => {
  const file = join(VAULT, "cards", "notes", "lock-probe.md");
  const release = acquireLock(file);
  assert.throws(() => acquireLock(file, 100), /занята другим процессом/);
  release();
  acquireLock(file, 100)(); // после освобождения — снова доступно
});

test("atomicWrite не оставляет временных файлов и пишет целиком", () => {
  const dir = join(VAULT, "cards", "notes");
  const file = join(dir, "atomic-probe.md");
  atomicWrite(file, "содержимое\n");
  assert.equal(readFileSync(file, "utf8"), "содержимое\n");
  assert.equal(readdirSync(dir).filter((n) => n.includes(".tmp-")).length, 0);
});
