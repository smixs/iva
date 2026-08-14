/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/unbound-method -- Node's test runner owns registration promises, async doubles preserve adapter boundaries, and the tested JavaScript entrypoint is loaded through createRequire */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareStableVersions,
  inspectUpstream,
  markVersionNotified,
  notificationChat,
  readNotifiedVersion,
  updateOffer,
} from "./update-check.ts";

type UpdateOfferRequest = {
  token: string;
  chatId: string;
  offer: { text: string; replyMarkup: { inline_keyboard: unknown[][] } };
};
type DailyUpdateResult = {
  status: string;
  info?: { remoteVersion?: string };
};
type DailyUpdateOptions = {
  root?: string;
  env?: Record<string, string>;
  inspectImpl?: (options: { root: string; head?: string }) => Promise<{
    hasVersionUpdate: boolean;
    localVersion?: string;
    remoteVersion?: string;
  }>;
  sendImpl?: (request: UpdateOfferRequest) => Promise<unknown>;
};
const require = createRequire(import.meta.url);
const { runDailyUpdateCheck } = require("../check-update.mjs") as unknown as {
  runDailyUpdateCheck(options?: DailyUpdateOptions): Promise<DailyUpdateResult>;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repoFixture() {
  const temp = mkdtempSync(join(tmpdir(), "iva-update-check-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  writeFileSync(
    join(seed, "package.json"),
    '{"name":"iva","version":"1.2.3"}\n',
  );
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

test("stable version comparison preserves runtime string coercion", () => {
  assert.equal(compareStableVersions({ toString: () => "1.2.3" }, "1.2.4"), 1);
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

  writeFileSync(
    join(seed, "package.json"),
    '{"name":"iva","version":"1.3.0"}\n',
  );
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

test("a merged legacy feature branch discovers updates from main", async () => {
  const { seed, local } = repoFixture();
  git(seed, "branch", "feat/legacy");
  git(seed, "push", "origin", "feat/legacy");
  git(local, "fetch", "origin", "feat/legacy");
  git(local, "switch", "-c", "feat/legacy", "FETCH_HEAD");

  writeFileSync(
    join(seed, "package.json"),
    '{"name":"iva","version":"1.3.0"}\n',
  );
  git(seed, "add", "package.json");
  git(seed, "commit", "-m", "release");
  git(seed, "push", "origin", "main");

  const info = await inspectUpstream({ root: local });
  assert.equal(info.currentBranch, "feat/legacy");
  assert.equal(info.branch, "main");
  assert.equal(info.legacyMigration, true);
  assert.equal(info.remote, git(seed, "rev-parse", "HEAD"));
  assert.equal(info.hasVersionUpdate, true);
});

test("an explicitly configured feature channel does not drift to main", async () => {
  const { seed, local } = repoFixture();
  git(seed, "switch", "-c", "feat/beta");
  writeFileSync(join(seed, "beta.txt"), "beta\n");
  git(seed, "add", "beta.txt");
  git(seed, "commit", "-m", "beta");
  git(seed, "push", "-u", "origin", "feat/beta");
  git(local, "fetch", "origin", "feat/beta");
  git(local, "switch", "-c", "feat/beta", "FETCH_HEAD");
  git(local, "config", "iva.updateBranch", "feat/beta");

  git(seed, "switch", "main");
  writeFileSync(
    join(seed, "package.json"),
    '{"name":"iva","version":"2.0.0"}\n',
  );
  git(seed, "add", "package.json");
  git(seed, "commit", "-m", "main release");
  git(seed, "push", "origin", "main");

  const info = await inspectUpstream({ root: local });
  assert.equal(info.branch, "feat/beta");
  assert.equal(info.legacyMigration, false);
  assert.equal(info.hasCommitUpdate, false);
  assert.equal(info.remoteVersion, "1.2.3");
});

test("notification target prefers digest chat and falls back to the first trusted user", () => {
  assert.equal(
    notificationChat({
      TELEGRAM_DIGEST_CHAT_ID: "99",
      TELEGRAM_ALLOWED_USER_IDS: "1,2",
    }),
    "99",
  );
  assert.equal(notificationChat({ TELEGRAM_ALLOWED_USER_IDS: " 1, 2" }), "1");
  assert.equal(notificationChat({}), "");
});

test("installer persists the selected update channel and integrates the fetched oid", () => {
  const installer = readFileSync(
    new URL("../../install.sh", import.meta.url),
    "utf8",
  );
  assert.match(
    installer,
    /config --local iva\.updateBranch "\$UPDATE_CHANNEL"/,
  );
  assert.match(
    installer,
    /UPDATE_CHANNEL="\$\(git -C "\$PROJECT_DIR" branch --show-current/,
  );
  assert.match(
    installer,
    /remote_ref="\$\(git -C "\$PROJECT_DIR" rev-parse FETCH_HEAD\)"/,
  );
  assert.doesNotMatch(installer, /remote_ref="origin\/\$BRANCH"/);
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
  const info = {
    hasVersionUpdate: true,
    localVersion: "1.2.3",
    remoteVersion: "1.2.4",
  };
  const sent: UpdateOfferRequest[] = [];
  const options = {
    root,
    env,
    inspectImpl: async () => info,
    sendImpl: async (request: UpdateOfferRequest) => sent.push(request),
  };
  assert.equal((await runDailyUpdateCheck(options)).status, "notified");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].offer.replyMarkup.inline_keyboard[0].length, 2);
  assert.match(sent[0].offer.text, /Доступна новая версия Ивы/);
  assert.equal((await runDailyUpdateCheck(options)).status, "already-notified");
  assert.equal(sent.length, 1);

  info.remoteVersion = "1.2.5";
  assert.equal((await runDailyUpdateCheck(options)).status, "notified");
  assert.equal(sent.length, 2);

  info.remoteVersion = "1.2.6";
  await assert.rejects(
    () =>
      runDailyUpdateCheck({
        ...options,
        sendImpl: async () => {
          throw new Error("offline");
        },
      }),
    /offline/,
  );
  assert.equal(await readNotifiedVersion(join(root, "data")), "1.2.5");
});

test("daily check is silent without config, without a release, or during an update", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-daily-silent-"));
  assert.equal(
    (await runDailyUpdateCheck({ root, env: {} })).status,
    "not-configured",
  );

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
  assert.match(ru.text, /новая версия Ивы/);
  assert.deepEqual(
    en.replyMarkup.inline_keyboard[0].map((button) => button.callback_data),
    ["iva_update:do", "iva_update:skip"],
  );
});

test("systemd templates schedule a persistent 10:00 local check and lifecycle commands include it", () => {
  const root = join(import.meta.dirname, "..", "..");
  const timer = readFileSync(
    join(root, "deploy", "iva-update-check.timer"),
    "utf8",
  );
  const service = readFileSync(
    join(root, "deploy", "iva-update-check.service"),
    "utf8",
  );
  const pollService = readFileSync(
    join(root, "deploy", "iva-telegram-poll.service"),
    "utf8",
  );
  const cliRuntime = readFileSync(
    join(root, "scripts", "cli", "runtime.ts"),
    "utf8",
  );
  const cliSystemd = readFileSync(
    join(root, "scripts", "cli", "systemd.ts"),
    "utf8",
  );
  const cliUpdate = readFileSync(
    join(root, "scripts", "cli", "update.ts"),
    "utf8",
  );
  const installer = readFileSync(join(root, "install.sh"), "utf8");
  assert.match(timer, /OnCalendar=\*-\*-\* 10:00:00 __TIMEZONE__/);
  assert.match(timer, /Persistent=true/);
  assert.match(service, /scripts\/check-update\.mjs/);
  assert.match(service, /EnvironmentFile=__PROJECT_DIR__\/\.env/);
  assert.match(cliRuntime, /const TIMERS = \[BRAIN_TIMER, UPDATE_TIMER\]/);
  assert.match(cliSystemd, /replaceAll\("__TIMEZONE__", timezone\)/);
  assert.match(cliUpdate, /systemd\.activate\(\[UPDATE_TIMER\]\)/);
  assert.match(installer, /bin\/iva\.mjs" _activate-units/);
  assert.match(
    pollService,
    /ExecStartPost=-\/usr\/bin\/systemctl --user enable --now iva-update-check\.timer/,
  );
});

test("a post-commit timer failure exits without rollback or a false update claim", () => {
  const cliUpdate = readFileSync(
    new URL("../cli/update.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    cliUpdate,
    /Iva is ready, but the automatic update timer could not be activated/,
  );
  assert.doesNotMatch(cliUpdate, /timerFailure: "Iva updated/);
  assert.match(
    cliUpdate,
    /const finalizeUpdate = async \(\): Promise<boolean> => \{[\s\S]*?commitThenRunPostCommit[\s\S]*?terminal\.fail\(text\.timerFailure\)[\s\S]*?process\.exitCode = 1;[\s\S]*?return false;/,
  );
  assert.equal(
    cliUpdate.match(/if \(!\(await finalizeUpdate\(\)\)\) return;/g)?.length,
    2,
  );
});

test("on the versioned layout the daily check reads the mirror and names the installed commit", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iva-daily-layout-")));
  const sha = "a".repeat(40);
  const name = `0.3.15-${sha.slice(0, 12)}`;
  mkdirSync(join(home, "versions", name), { recursive: true });
  mkdirSync(join(home, "repo"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  symlinkSync(join(home, "versions", name), join(home, "current"));

  const asked: { root?: string; head?: string }[] = [];
  const result = await runDailyUpdateCheck({
    // The units run from `current`, which is where the check starts too.
    root: join(home, "current"),
    env: { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOWED_USER_IDS: "1" },
    inspectImpl: async (options) => {
      asked.push(options);
      return { hasVersionUpdate: false };
    },
  });
  assert.equal(result.status, "current");
  // The mirror's own HEAD follows the remote, so the active version has to be named.
  assert.deepEqual(asked, [
    { root: join(home, "repo"), head: sha.slice(0, 12) },
  ]);
});

// Предложение обновиться — алерт (ADR-0007), и говорит он на языке, выбранном в /menu, а не на
// том, что остался в .env. Резолвер кэширует язык на ~2с и читает settings.json от cwd,
// поэтому каждый сценарий — свежий процесс (тот же приём, что в agent/lib/i18n.test.ts).
const OFFER_PROBE = `
const { runDailyUpdateCheck } = await import(process.env.__CHECK_UPDATE_URL);
const texts = [];
const result = await runDailyUpdateCheck({
  root: process.env.__ROOT,
  env: {
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_DIGEST_CHAT_ID: "42",
    ASSISTANT_DATA_DIR: process.env.ASSISTANT_DATA_DIR,
    AGENT_LANGUAGE: process.env.AGENT_LANGUAGE,
  },
  inspectImpl: async () => ({ hasVersionUpdate: true, localVersion: "1.2.3", remoteVersion: "1.2.4" }),
  sendImpl: async (request) => texts.push(request.offer.text),
});
process.stdout.write(JSON.stringify({ status: result.status, texts }));
`;

function offerProbe(settingsLanguage: string, agentLanguage: string): string[] {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iva-offer-lang-")));
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({ language: settingsLanguage }),
  );
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", OFFER_PROBE],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        __CHECK_UPDATE_URL: new URL("../check-update.mjs", import.meta.url)
          .href,
        __ROOT: root,
        ASSISTANT_DATA_DIR: data,
        AGENT_LANGUAGE: agentLanguage,
      },
    },
  );
  const parsed = JSON.parse(output) as { status: string; texts: string[] };
  assert.equal(parsed.status, "notified");
  return parsed.texts;
}

test("the update offer speaks the language picked in /menu, not the one left in .env", () => {
  const english = offerProbe("en", "ru");
  assert.equal(english.length, 1);
  assert.match(english[0], /A new Iva version is available/);
  assert.doesNotMatch(english[0], /Доступна новая версия/);

  const russian = offerProbe("ru", "en");
  assert.equal(russian.length, 1);
  assert.match(russian[0], /Доступна новая версия Ивы/);
  assert.doesNotMatch(russian[0], /A new Iva version/);
});
