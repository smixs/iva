import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDailyUpdateCheck } from "../check-update.mjs";
import {
  compareStableVersions,
  inspectUpstream,
  markVersionNotified,
  notificationChat,
  readNotifiedVersion,
  updateOffer,
} from "./update-check.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repoFixture() {
  const temp = mkdtempSync(join(tmpdir(), "iva-update-check-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  writeFileSync(join(seed, "package.json"), '{"name":"iva","version":"1.2.3"}\n');
  git(seed, "add", "package.json");
  git(seed, "commit", "-m", "initial");
  git(temp, "init", "--bare", remote);
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(temp, "clone", "--branch", "main", remote, local);
  git(local, "config", "user.email", "test@example.com");
  git(local, "config", "user.name", "Test");
  return { temp, remote, seed, local };
}

test("stable version comparison accepts only numeric release triples", () => {
  assert.equal(compareStableVersions("1.2.3", "1.2.4"), 1);
  assert.equal(compareStableVersions("1.2.3", "1.3.0"), 1);
  assert.equal(compareStableVersions("1.2.3", "2.0.0"), 1);
  assert.equal(compareStableVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareStableVersions("1.2.3", "1.2.2"), -1);
  assert.equal(compareStableVersions("1.2.3", "1.3.0-beta.1"), null);
  assert.equal(compareStableVersions("not-semver", "1.3.0"), null);
});

test("upstream inspection separates commit updates from release updates", async () => {
  const { seed, local } = repoFixture();
  let info = await inspectUpstream({ root: local });
  assert.equal(info.hasCommitUpdate, false);
  assert.equal(info.hasVersionUpdate, false);

  writeFileSync(join(seed, "README.md"), "docs only\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-m", "docs");
  git(seed, "push");
  info = await inspectUpstream({ root: local });
  assert.equal(info.hasCommitUpdate, true);
  assert.equal(info.hasVersionUpdate, false);

  writeFileSync(join(seed, "package.json"), '{"name":"iva","version":"1.3.0"}\n');
  git(seed, "add", "package.json");
  git(seed, "commit", "-m", "release");
  git(seed, "push");
  info = await inspectUpstream({ root: local });
  assert.equal(info.hasCommitUpdate, true);
  assert.equal(info.hasVersionUpdate, true);
  assert.equal(info.remoteVersion, "1.3.0");
});

test("a locally ahead repository has no upstream update", async () => {
  const { local } = repoFixture();
  writeFileSync(join(local, "local.txt"), "local\n");
  git(local, "add", "local.txt");
  git(local, "commit", "-m", "local");
  const info = await inspectUpstream({ root: local });
  assert.equal(info.hasCommitUpdate, false);
  assert.equal(info.hasVersionUpdate, false);
});

test("notification target prefers digest chat and falls back to the first trusted user", () => {
  assert.equal(notificationChat({ TELEGRAM_DIGEST_CHAT_ID: "99", TELEGRAM_ALLOWED_USER_IDS: "1,2" }), "99");
  assert.equal(notificationChat({ TELEGRAM_ALLOWED_USER_IDS: " 1, 2" }), "1");
  assert.equal(notificationChat({}), "");
});

test("notification state is atomic, private and readable", async () => {
  const data = mkdtempSync(join(tmpdir(), "iva-update-state-"));
  await markVersionNotified(data, "1.2.4");
  assert.equal(await readNotifiedVersion(data), "1.2.4");
  assert.equal(statSync(join(data, "update-check.json")).mode & 0o777, 0o600);
});

test("daily check sends one offer per version and records only successful sends", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-daily-check-"));
  const env = {
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_DIGEST_CHAT_ID: "42",
    AGENT_LANGUAGE: "ru",
    ASSISTANT_DATA_DIR: "data",
  };
  const info = { hasVersionUpdate: true, localVersion: "1.2.3", remoteVersion: "1.2.4" };
  const sent = [];
  const options = {
    root,
    env,
    inspectImpl: async () => info,
    sendImpl: async (request) => sent.push(request),
  };
  assert.equal((await runDailyUpdateCheck(options)).status, "notified");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].offer.replyMarkup.inline_keyboard[0].length, 2);
  assert.match(sent[0].offer.text, /Доступна новая версия Iva/);
  assert.equal((await runDailyUpdateCheck(options)).status, "already-notified");
  assert.equal(sent.length, 1);

  info.remoteVersion = "1.2.5";
  assert.equal((await runDailyUpdateCheck(options)).status, "notified");
  assert.equal(sent.length, 2);

  info.remoteVersion = "1.2.6";
  await assert.rejects(() => runDailyUpdateCheck({ ...options, sendImpl: async () => { throw new Error("offline"); } }), /offline/);
  assert.equal(await readNotifiedVersion(join(root, "data")), "1.2.5");
});

test("daily check is silent without config, without a release, or during an update", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-daily-silent-"));
  assert.equal((await runDailyUpdateCheck({ root, env: {} })).status, "not-configured");

  const env = { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOWED_USER_IDS: "1" };
  const current = await runDailyUpdateCheck({
    root,
    env,
    inspectImpl: async () => ({ hasVersionUpdate: false }),
    sendImpl: async () => assert.fail("must stay silent"),
  });
  assert.equal(current.status, "current");

  mkdirSync(join(root, "data", "update.lock"), { recursive: true });
  const locked = await runDailyUpdateCheck({
    root,
    env,
    inspectImpl: async () => assert.fail("must not fetch during update"),
  });
  assert.equal(locked.status, "update-running");
});

test("offer copy is bilingual and keeps existing callback actions", () => {
  const en = updateOffer("1.2.3", "1.2.4", "en");
  const ru = updateOffer("1.2.3", "1.2.4", "ru");
  assert.match(en.text, /new Iva version/);
  assert.match(ru.text, /новая версия Iva/);
  assert.deepEqual(en.replyMarkup.inline_keyboard[0].map((button) => button.callback_data), ["iva_update:do", "iva_update:skip"]);
});

test("systemd templates schedule a persistent 10:00 local check and lifecycle commands include it", () => {
  const root = join(import.meta.dirname, "..", "..");
  const timer = readFileSync(join(root, "deploy", "iva-update-check.timer"), "utf8");
  const service = readFileSync(join(root, "deploy", "iva-update-check.service"), "utf8");
  const pollService = readFileSync(join(root, "deploy", "iva-telegram-poll.service"), "utf8");
  const cli = readFileSync(join(root, "bin", "iva.mjs"), "utf8");
  const installer = readFileSync(join(root, "install.sh"), "utf8");
  assert.match(timer, /OnCalendar=\*-\*-\* 10:00:00/);
  assert.match(timer, /Persistent=true/);
  assert.match(service, /scripts\/check-update\.mjs/);
  assert.match(service, /EnvironmentFile=__PROJECT_DIR__\/\.env/);
  assert.match(cli, /const TIMERS = \[\.\.\.MEMORY_TIMERS, UPDATE_TIMER\]/);
  assert.match(cli, /"enable", "--now", UPDATE_TIMER/);
  assert.match(installer, /enable --now iva-update-check\.timer/);
  assert.match(pollService, /ExecStartPost=-\/usr\/bin\/systemctl --user enable --now iva-update-check\.timer/);
});
