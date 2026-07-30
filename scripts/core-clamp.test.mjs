import { test } from "node:test";
import assert from "node:assert/strict";

import { CORE_CAP } from "./lib/core-cap.mjs";
import { clampCore } from "./memory/core-clamp.mjs";

function fillTo(text, target) {
  const marker = "{FILL}";
  const size = target - (text.length - marker.length);
  assert.ok(size >= 0, "test fixture is already above its target size");
  return text.replace(marker, "x".repeat(size));
}

function pointers(text, heading = "## Указатели") {
  return text.slice(text.indexOf(heading));
}

test("under-cap input is returned byte-identically", () => {
  const input =
    "# CORE — ядро памяти\r\n\r\n" +
    "<!-- comment -->  \r\n\r\n" +
    "## Пользователь\r\n- Шима\r\n\r\n" +
    "## Предпочтения\r\n- Кратко.\r\n\r\n" +
    "## Активные цели (≤3)\r\n- one\r\n- two\r\n- three\r\n- four\r\n\r\n" +
    "## Указатели\r\n- vault/MOC.md\r\n";

  assert.ok(input.length < CORE_CAP);
  assert.equal(clampCore(input), input);
});

test("preferences evict undated bullets first, then oldest dated bullets", () => {
  const undated = "- durable but undated\n";
  const oldest = "- 2024-01: oldest dated\n";
  const input = fillTo(
    "# CORE — ядро памяти\n\n" +
      "<!-- comment -->\n\n" +
      "## Пользователь\n{FILL}\n\n" +
      "## Предпочтения\n" +
      "- 2026-06: newest\n" +
      undated +
      oldest +
      "- 2025-03-14: middle\n\n" +
      "## Активные цели (≤3)\n- goal\n\n" +
      "## Указатели\n- vault/MOC.md\n",
    CORE_CAP + undated.length + oldest.length - 1,
  );

  const output = clampCore(input);
  assert.ok(output.length <= CORE_CAP);
  assert.ok(!output.includes(undated.trim()));
  assert.ok(!output.includes(oldest.trim()));
  assert.ok(output.includes("- 2025-03-14: middle"));
  assert.ok(output.includes("- 2026-06: newest"));
});

test("an oversized goals section keeps its first three bullets", () => {
  const input = fillTo(
    "# CORE — ядро памяти\n\n" +
      "## Пользователь\n{FILL}\n\n" +
      "## Предпочтения\n\n" +
      "## Активные цели (≤3)\n" +
      "- goal one\n- goal two\n- goal three\n- goal four\n- goal five\n\n" +
      "## Указатели\n- exact pointer\n",
    CORE_CAP + 10,
  );

  const output = clampCore(input);
  assert.ok(output.length <= CORE_CAP);
  assert.ok(output.includes("- goal one"));
  assert.ok(output.includes("- goal two"));
  assert.ok(output.includes("- goal three"));
  assert.ok(!output.includes("- goal four"));
  assert.ok(!output.includes("- goal five"));
});

test("pointers are never modified", () => {
  const input = fillTo(
    "# CORE — ядро памяти\n\n" +
      "## Пользователь\n{FILL}\n\n" +
      "## Предпочтения\n- remove me\n\n" +
      "## Активные цели (≤3)\n- goal\n\n" +
      "## Указатели\n" +
      "- Последний день: vault/summaries/daily/2026-07-29\n" +
      "- Оглавление: vault/MOC.md\n" +
      "  continuation with exact spacing  \n",
    CORE_CAP + 5,
  );

  const output = clampCore(input);
  assert.equal(pointers(output), pointers(input));
});

test("last resort truncates only the longest mutable bullet with an ellipsis", () => {
  const input = fillTo(
    "# CORE — ядро памяти\n\n" +
      "## Пользователь\n" +
      "- short identity\n" +
      "- {FILL}\n\n" +
      "## Предпочтения\n\n" +
      "## Активные цели (≤3)\n\n" +
      "## Указатели\n- pointer stays exact\n",
    CORE_CAP + 75,
  );

  const output = clampCore(input);
  assert.ok(output.length <= CORE_CAP);
  assert.ok(output.includes("- short identity"));
  assert.match(output, /x…\n\n## Предпочтения/);
  assert.equal(pointers(output), pointers(input));
});

test("clamp is idempotent", () => {
  const input = fillTo(
    "# CORE — ядро памяти\n\n" +
      "## Пользователь\n- {FILL}\n\n" +
      "## Предпочтения\n- 2024-01: old\n- 2026-07: new\n\n" +
      "## Активные цели (≤3)\n- one\n- two\n- three\n- four\n\n" +
      "## Указатели\n- pointer\n",
    CORE_CAP + 90,
  );
  const once = clampCore(input);
  assert.equal(clampCore(once), once);
});

test("all H1/H2 headings and their formatting are preserved", () => {
  const input = fillTo(
    "# CORE — ядро памяти\r\n\r\n" +
      "<!-- exact comment -->\r\n\r\n" +
      "## Пользователь  \r\n{FILL}\r\n\r\n" +
      "## Неизвестный раздел\r\n- untouched unknown bullet\r\n\r\n" +
      "## Предпочтения\r\n- old undated\r\n\r\n" +
      "## Активные цели (≤3)\r\n- one\r\n\r\n" +
      "## Указатели\r\n- pointer\r\n",
    CORE_CAP + 5,
  );

  const headings = (text) => text.split("\n").filter((line) => /^#{1,2} /.test(line));
  assert.deepEqual(headings(clampCore(input)), headings(input));
  assert.ok(clampCore(input).includes("## Неизвестный раздел\r\n- untouched unknown bullet\r\n"));
});

test("English template headings are recognized", () => {
  const old = "- 2024-02: old preference\n";
  const input = fillTo(
    "# CORE — memory core\n\n" +
      "<!-- comment -->\n\n" +
      "## User\n{FILL}\n\n" +
      "## Preferences\n" +
      old +
      "- 2026-07: current preference\n\n" +
      "## Active goals (≤3)\n- one\n- two\n- three\n- four\n\n" +
      "## Pointers\n- Latest day: vault/daily.md · Index: vault/MOC.md\n",
    CORE_CAP + old.length - 1,
  );

  const output = clampCore(input);
  assert.ok(output.length <= CORE_CAP);
  assert.ok(!output.includes(old.trim()));
  assert.ok(!output.includes("- four"));
  assert.equal(pointers(output, "## Pointers"), pointers(input, "## Pointers"));
});

test("degenerate over-cap files without known sections stay safely unchanged", () => {
  const input = `# unrelated\n${"x".repeat(CORE_CAP + 50)}\n## Custom\n- data\n`;
  assert.doesNotThrow(() => clampCore(input));
  assert.equal(clampCore(input), input);
});
