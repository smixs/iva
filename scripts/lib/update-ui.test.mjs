import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelSummary } from "./model-summary.mjs";
import { createTerminalProgress } from "./progress.mjs";
import { createTelegramUpdateReporter, UPDATE_LOADER } from "./telegram-status.mjs";
import { acquireUpdateLock, createUpdateTransaction, releaseUpdateLock } from "./update-safety.mjs";

test("modelSummary uses configured provider values without runtime defaults", () => {
  assert.deepEqual(modelSummary({ MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5", CODEX_CONTEXT_WINDOW: "272000" }), {
    provider: "OpenAI",
    model: "gpt-5.5",
    contextWindow: 272000,
    line: "OpenAI · gpt-5.5",
  });
});

test("terminal progress is deterministic outside a TTY", () => {
  let output = "";
  const stream = { isTTY: false, write: (chunk) => { output += chunk; } };
  const progress = createTerminalProgress({ stream, env: {} });
  progress.start("Saving changes");
  progress.done("Changes saved");
  progress.dispose();
  assert.equal(output, "◇ Saving changes\n✓ Changes saved\n");
});

test("terminal progress restores the cursor when disposed", () => {
  let output = "";
  const stream = { isTTY: true, write: (chunk) => { output += chunk; } };
  const progress = createTerminalProgress({ stream, env: { TERM: "xterm" }, intervalMs: 60_000 });
  progress.start("Building");
  progress.dispose();
  assert.match(output, /\x1b\[\?25l/);
  assert.match(output, /\x1b\[\?25h/);
});

test("Telegram update edits one message through every phase and final result", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").at(-1);
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "ru" },
    env: { MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5" },
    fetchImpl,
  });
  await reporter.start("protect");
  await reporter.done("protect");
  await reporter.start("fetch");
  await reporter.done("fetch");
  await reporter.start("build");
  await reporter.done("build");
  await reporter.complete({ beforeVersion: "v1", afterVersion: "v2", changedLocal: true });
  reporter.dispose();

  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
  const edits = calls.filter((call) => call.method === "editMessageText");
  assert.equal(edits.length, 4);
  assert.deepEqual(edits.map((call) => call.body.message_id), [100, 100, 100, 100]);
  assert.deepEqual(edits.slice(0, 3).map((call) => call.body.entities[0].custom_emoji_id), [
    UPDATE_LOADER.customEmojiId,
    UPDATE_LOADER.customEmojiId,
    UPDATE_LOADER.customEmojiId,
  ]);
  assert.deepEqual(edits.slice(0, 3).map((call) => call.body.text), [
    `${UPDATE_LOADER.alt} Сохраняю ваши изменения`,
    `${UPDATE_LOADER.alt} Получаю обновление`,
    `${UPDATE_LOADER.alt} Собираю Iva`,
  ]);
  assert.match(edits[3].body.text, /Iva обновлена/);
  assert.match(edits[3].body.text, /OpenAI · gpt-5.5/);
  assert.equal(edits[3].body.entities, undefined);
});

test("Telegram does not recreate phase messages after the active message was deleted", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").at(-1);
    calls.push({ method, body: JSON.parse(init.body) });
    if (method === "editMessageText") {
      return { ok: false, status: 400, json: async () => ({ ok: false, description: "Bad Request: message to edit not found" }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 200 } }) };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: { MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5" },
    fetchImpl,
  });
  await reporter.start("protect");
  await reporter.start("fetch");
  await reporter.start("build");
  await reporter.complete({ beforeVersion: "v1", afterVersion: "v2" });
  reporter.dispose();
  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 1, "only the final result is recreated");
});

test("Telegram retries 429 without downgrading the custom emoji and deduplicates phase edits", async () => {
  const calls = [];
  let first = true;
  const fetchImpl = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    if (first) {
      first = false;
      return { ok: false, status: 429, json: async () => ({ ok: false, parameters: { retry_after: 1 } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "ru" },
    env: {},
    fetchImpl,
    sleepImpl: async () => {},
  });
  await reporter.start("protect");
  await reporter.start("protect");
  await reporter.done("protect");
  await reporter.done("protect");
  reporter.dispose();
  assert.equal(calls.length, 2, "one retry and no duplicate edit");
  assert.ok(calls.every((call) => call.body.entities?.[0].custom_emoji_id === UPDATE_LOADER.customEmojiId));
});

test("Telegram falls back to a simple Unicode marker when custom emoji is unavailable", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: url.split("/").at(-1), body });
    if (body.entities) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ ok: false, description: "Bad Request: custom emoji entities are not allowed" }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  await reporter.start("protect");
  await reporter.start("fetch");
  reporter.dispose();

  assert.equal(calls.length, 3);
  assert.ok(calls[0].body.entities);
  assert.equal(calls[1].body.text, `${UPDATE_LOADER.fallback} Saving your changes`);
  assert.equal(calls[2].body.text, `${UPDATE_LOADER.fallback} Getting the update`);
  assert.equal(calls[1].body.entities, undefined);
  assert.equal(calls[2].body.entities, undefined);
});

test("Telegram update failure replaces the active phase in the same message", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  await reporter.start("fetch");
  await reporter.fail("fetch", "v1");
  reporter.dispose();

  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
  assert.deepEqual(calls.map((call) => call.body.message_id), [100, 100]);
  assert.match(calls[1].body.text, /Couldn't get the update/);
  assert.match(calls[1].body.text, /still running v1/);
});

test("update callback is acknowledged before any message edit", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url.split("/").at(-1));
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  try {
    const bridge = await import(`../telegram-poll.mjs?test=${Date.now()}`);
    await bridge.handleUpdateCallback({
      id: "callback",
      from: { id: 42 },
      data: "iva_update:skip",
      message: { chat: { id: 1 }, message_id: 2 },
    });
    assert.deepEqual(calls, ["answerCallbackQuery", "editMessageText"]);
    assert.deepEqual(
      bridge.resetMessageCopy("/new", { MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5", CODEX_CONTEXT_WINDOW: "272000" }, "ru"),
      {
        pending: "◇ Начинаю новый диалог",
        complete: "✨ Новый диалог готов\n\nМодель: OpenAI · gpt-5.5\nКонтекст очищен · окно 272k",
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousAllowed === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = previousAllowed;
  }
});

test("manual update offer keeps commit-based behavior and marks a stable release as shown", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const method = url.split("/").at(-1);
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return {
      ok: true,
      json: async () => ({ ok: true, result: method === "sendMessage" ? { message_id: 10 } : { message_id: 10 } }),
    };
  };
  try {
    const bridge = await import(`../telegram-poll.mjs?manual=${Date.now()}`);
    const marked = [];
    await bridge.handleUpdateCheck(1, {
      inspectImpl: async () => ({
        hasCommitUpdate: true,
        hasVersionUpdate: true,
        localVersion: "1.2.3",
        remoteVersion: "1.2.4",
      }),
      markNotifiedImpl: async (_dataDir, version) => marked.push(version),
    });
    assert.deepEqual(calls.map((call) => call.method), ["sendMessage", "editMessageText"]);
    assert.equal(calls[1].body.reply_markup.inline_keyboard[0].length, 2);
    assert.deepEqual(marked, ["1.2.4"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousAllowed === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = previousAllowed;
  }
});

test("update lock is exclusive and owner-reentrant", () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-lock-"));
  const first = acquireUpdateLock(dir, "one");
  assert.equal(first.ok, true);
  assert.equal(acquireUpdateLock(dir, "one").ok, true);
  assert.equal(acquireUpdateLock(dir, "two").ok, false);
  releaseUpdateLock(first);
  assert.equal(acquireUpdateLock(dir, "two").ok, true);
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configureGit(cwd) {
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Iva Test");
}

test("safe update preserves staged, unstaged and untracked user files", async () => {
  const temp = mkdtempSync(join(tmpdir(), "iva-update-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  const data = join(temp, "data");
  git(temp, "init", "--bare", remote);
  git(temp, "init", "-b", "main", seed);
  configureGit(seed);
  writeFileSync(join(seed, ".gitignore"), ".env\n.output\n");
  writeFileSync(join(seed, "package.json"), JSON.stringify({ version: "1.0.0" }));
  writeFileSync(join(seed, "tracked.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(temp, "clone", "--branch", "main", remote, local);
  configureGit(local);

  writeFileSync(join(seed, "upstream.txt"), "upstream\n");
  writeFileSync(join(seed, "package.json"), JSON.stringify({ version: "1.1.0" }));
  git(seed, "add", ".");
  git(seed, "commit", "-m", "upstream");
  git(seed, "push", "origin", "main");

  writeFileSync(join(local, "tracked.txt"), "user change\n");
  git(local, "add", "tracked.txt");
  writeFileSync(join(local, "unstaged.txt"), "unstaged\n");
  writeFileSync(join(local, "custom-skill.txt"), "custom\n");
  writeFileSync(join(local, ".env"), "SECRET=kept\n", { mode: 0o600 });
  mkdirSync(data, { recursive: true });
  const tx = createUpdateTransaction({
    root: local,
    dataDir: data,
    envPath: join(local, ".env"),
    logFile: join(temp, "update.log"),
  });
  await tx.protect();
  const result = await tx.fetchAndIntegrate();
  await tx.restoreLocalChanges();
  assert.equal(result.changed, true);
  assert.equal(readFileSync(join(local, "tracked.txt"), "utf8"), "user change\n");
  assert.equal(readFileSync(join(local, "unstaged.txt"), "utf8"), "unstaged\n");
  assert.equal(readFileSync(join(local, "custom-skill.txt"), "utf8"), "custom\n");
  assert.equal(readFileSync(join(local, ".env"), "utf8"), "SECRET=kept\n");
  assert.equal(readFileSync(join(local, "upstream.txt"), "utf8"), "upstream\n");
  assert.match(git(local, "status", "--porcelain=v1"), /^M  tracked\.txt/m);
  await tx.commit();
  assert.equal(git(local, "stash", "list"), "");
});

function updateFixture() {
  const temp = mkdtempSync(join(tmpdir(), "iva-update-failure-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  const data = join(temp, "data");
  git(temp, "init", "--bare", remote);
  git(temp, "init", "-b", "main", seed);
  configureGit(seed);
  writeFileSync(join(seed, ".gitignore"), ".env\n.output\n");
  writeFileSync(join(seed, "package.json"), JSON.stringify({ version: "1.0.0" }));
  writeFileSync(join(seed, "tracked.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(temp, "clone", "--branch", "main", remote, local);
  configureGit(local);
  mkdirSync(data, { recursive: true });
  return { temp, remote, seed, local, data };
}

test("stash conflict rolls back HEAD, output and user files byte-for-byte", async () => {
  const { temp, seed, local, data } = updateFixture();
  const originalHead = git(local, "rev-parse", "HEAD");
  writeFileSync(join(local, "tracked.txt"), "user version\n");
  writeFileSync(join(local, "custom.bin"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(local, ".env"), "SECRET=before\n", { mode: 0o600 });
  mkdirSync(join(local, ".output"));
  writeFileSync(join(local, ".output", "server"), "old build");

  writeFileSync(join(seed, "tracked.txt"), "upstream version\n");
  git(seed, "add", "tracked.txt");
  git(seed, "commit", "-m", "conflicting upstream");
  git(seed, "push", "origin", "main");

  const tx = createUpdateTransaction({ root: local, dataDir: data, envPath: join(local, ".env"), logFile: join(temp, "log") });
  await tx.protect();
  await tx.fetchAndIntegrate();
  await assert.rejects(() => tx.restoreLocalChanges(), /conflict/);
  tx.backupOutput();
  mkdirSync(join(local, ".output"));
  writeFileSync(join(local, ".output", "server"), "bad build");
  writeFileSync(join(local, ".env"), "SECRET=changed\n");
  await tx.rollback();

  assert.equal(git(local, "rev-parse", "HEAD"), originalHead);
  assert.equal(readFileSync(join(local, "tracked.txt"), "utf8"), "user version\n");
  assert.deepEqual(readFileSync(join(local, "custom.bin")), Buffer.from([0, 1, 2, 255]));
  assert.equal(readFileSync(join(local, ".env"), "utf8"), "SECRET=before\n");
  assert.equal(readFileSync(join(local, ".output", "server"), "utf8"), "old build");
  assert.notEqual(git(local, "stash", "list"), "", "protective stash is retained after rollback");
  assert.equal(existsSync(join(local, ".output.iva-backup")), false);
});

test("conflicting local commits abort rebase and restore the original branch", async () => {
  const { temp, seed, local, data } = updateFixture();
  writeFileSync(join(local, "tracked.txt"), "local commit\n");
  git(local, "add", "tracked.txt");
  git(local, "commit", "-m", "local");
  const originalHead = git(local, "rev-parse", "HEAD");
  writeFileSync(join(seed, "tracked.txt"), "upstream commit\n");
  git(seed, "add", "tracked.txt");
  git(seed, "commit", "-m", "upstream");
  git(seed, "push", "origin", "main");
  const tx = createUpdateTransaction({ root: local, dataDir: data, envPath: join(local, ".env"), logFile: join(temp, "log") });
  await tx.protect();
  await assert.rejects(() => tx.fetchAndIntegrate(), /local commits conflict/);
  await tx.rollback();
  assert.equal(git(local, "rev-parse", "HEAD"), originalHead);
  assert.equal(readFileSync(join(local, "tracked.txt"), "utf8"), "local commit\n");
  assert.equal(git(local, "status", "--porcelain=v1"), "");
});
