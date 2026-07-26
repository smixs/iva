import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags } from "./todoist.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "todoist.mjs");

// Run the CLI with a fake HOME (so no real token leaks in) and controlled env/stdin.
function run(args, { home, token, input } = {}) {
  const env = { ...process.env };
  delete env.TODOIST_API_TOKEN;
  if (token) env.TODOIST_API_TOKEN = token;
  if (home) env.HOME = home;
  const r = spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: "utf8" });
  let json;
  try { json = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch { /* non-json */ }
  return { code: r.status, json };
}

test("parseFlags handles --flag value, --flag=value, and bare boolean flags", () => {
  assert.deepEqual(parseFlags(["--content", "buy milk", "--due=tomorrow", "--urgent"]), {
    content: "buy milk",
    due: "tomorrow",
    urgent: true,
  });
});

test("no token → exit 2 (unauthorized)", () => {
  const home = mkdtempSync(join(tmpdir(), "iva-td-"));
  try {
    const { code, json } = run(["auth"], { home });
    assert.equal(code, 2);
    assert.equal(json.ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unknown command → exit 3", () => {
  const { code, json } = run(["frobnicate"], { token: "x" });
  assert.equal(code, 3);
  assert.equal(json.ok, false);
});

test("add without --content → exit 3 before any network call", () => {
  const { code, json } = run(["add", "--due", "tomorrow"], { token: "x" });
  assert.equal(code, 3);
  assert.match(json.error, /content/);
});

test("tasks --filter with --project → exit 3 (distinct endpoints, don't mix)", () => {
  const { code, json } = run(["tasks", "--filter", "today", "--project", "123"], { token: "x" });
  assert.equal(code, 3);
  assert.match(json.error, /project|filter/);
});

test("set-token stores the token 0600 from stdin", () => {
  const home = mkdtempSync(join(tmpdir(), "iva-td-"));
  try {
    const { code, json } = run(["set-token"], { home, input: "abc123def456ghi789jkl\n" });
    assert.equal(code, 0);
    assert.equal(json.ok, true);
    const file = join(home, ".config/iva-todoist/token");
    assert.equal(readFileSync(file, "utf8").trim(), "abc123def456ghi789jkl");
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("empty token on stdin → exit 3", () => {
  const home = mkdtempSync(join(tmpdir(), "iva-td-"));
  try {
    const { code } = run(["set-token"], { home, input: "  \n" });
    assert.equal(code, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
