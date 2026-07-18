// Self-check: normalizeCwd разворачивает ~, валидирует директорию до exec и даёт понятную
// диагностику вместо сырого EACCES/ENOENT (см. agent/tools/bash.ts, issue #17).
// Запуск: node scripts/check-bash-cwd.mjs
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { normalizeCwd } from "../agent/tools/bash.ts";

// пусто/не задан → без cwd (exec возьмёт process.cwd()), без ошибки
assert.deepEqual(normalizeCwd(undefined), {});
assert.deepEqual(normalizeCwd(""), {});
assert.deepEqual(normalizeCwd("   "), {});

// ~ и ~/... разворачиваются в реальный HOME
assert.equal(normalizeCwd("~").cwd, homedir());
assert.equal(normalizeCwd("~/").cwd, homedir());

// существующая директория проходит как есть
assert.deepEqual(normalizeCwd("/tmp"), { cwd: "/tmp" });

// несуществующий путь → структурированная ошибка с диагностикой, exec не запускается
const missing = normalizeCwd("/workspace/definitely-missing-xyz");
assert.ok(missing.error && !missing.cwd);
assert.match(missing.error, /не существует/);
assert.ok(missing.error.includes(process.cwd()));

// файл (не директория) → тоже ошибка
const file = normalizeCwd(new URL(import.meta.url).pathname);
assert.ok(file.error && !file.cwd);

console.log("check-bash-cwd: OK");
