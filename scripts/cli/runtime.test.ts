/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createCliRuntime } from "./runtime.ts";

const RUNTIME_MODULE = new URL("./runtime.ts", import.meta.url);

async function sandbox(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "iva-cli-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("runtime exposes the CLI primitives and shared unit constants", async (t) => {
  const root = await sandbox(t);
  const runtime = createCliRuntime(root);

  assert.deepEqual(Object.keys(runtime).sort(), [
    "C",
    "DEFAULT_PORT",
    "ENV_PATH",
    "MEMORY_PERIODS",
    "MEMORY_SERVICES",
    "MEMORY_TIMERS",
    "NODE",
    "NODE_BIN_DIR",
    "NPM",
    "OLD_DEFAULT_HOST",
    "ROOT",
    "SERVICES",
    "SVC_USERBOT",
    "TIMERS",
    "TOKEN_FILE",
    "UNIT_DIR",
    "UPDATE_TIMER",
    "USERBOT_DIR",
    "VENV_PY",
    "bad",
    "cap",
    "childEnv",
    "confirm",
    "dataDirAbs",
    "gitHead",
    "hasSystemd",
    "ok",
    "readEnv",
    "requireSystemd",
    "run",
    "scQ",
    "step",
    "systemd",
    "warn",
    "writeEnvVars",
  ]);
  assert.equal(runtime.ROOT, root);
  assert.equal(runtime.ENV_PATH, join(root, ".env"));
  assert.equal(runtime.UNIT_DIR, join(homedir(), ".config/systemd/user"));
  assert.equal(runtime.NODE, process.execPath);
  assert.equal(runtime.NODE_BIN_DIR, dirname(process.execPath));
  assert.equal(
    runtime.NPM,
    existsSync(join(dirname(process.execPath), "npm"))
      ? join(dirname(process.execPath), "npm")
      : "npm",
  );
  assert.deepEqual(runtime.SERVICES, [
    "iva.service",
    "iva-telegram-poll.service",
  ]);
  assert.deepEqual(runtime.MEMORY_PERIODS, ["doctor"]);
  assert.deepEqual(runtime.MEMORY_SERVICES, ["iva-memory-doctor.service"]);
  assert.deepEqual(runtime.MEMORY_TIMERS, ["iva-memory-doctor.timer"]);
  assert.equal(runtime.UPDATE_TIMER, "iva-update-check.timer");
  assert.deepEqual(runtime.TIMERS, [
    "iva-memory-doctor.timer",
    "iva-update-check.timer",
  ]);
  assert.equal(runtime.SVC_USERBOT, "iva-telegram-userbot.service");
  assert.equal(runtime.USERBOT_DIR, join(root, "services/telegram-userbot"));
  assert.equal(
    runtime.VENV_PY,
    join(root, "services/telegram-userbot/.venv/bin/python"),
  );
  assert.equal(runtime.TOKEN_FILE, join(root, "data/telegram-userbot.token"));
  assert.equal(runtime.DEFAULT_PORT, "8723");
  assert.equal(runtime.OLD_DEFAULT_HOST, "http://127.0.0.1:3000");
});

test("import is side-effect free and factory evaluation snapshots env and color", async (t) => {
  const root = await sandbox(t);
  const snapshotKey = "IVA_RUNTIME_SNAPSHOT_TEST";
  const savedSnapshot = process.env[snapshotKey];
  const savedNoColor = process.env.NO_COLOR;
  const savedTerm = process.env.TERM;
  t.after(() => {
    if (savedSnapshot === undefined) delete process.env[snapshotKey];
    else process.env[snapshotKey] = savedSnapshot;
    if (savedNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
    if (savedTerm === undefined) delete process.env.TERM;
    else process.env.TERM = savedTerm;
  });

  process.env.NO_COLOR = "1";
  process.env.TERM = "xterm-256color";
  process.env[snapshotKey] = "at-import";
  const imported = (await import(
    `${RUNTIME_MODULE.href}?side-effect=${Date.now()}`
  )) as typeof import("./runtime.ts");

  delete process.env.NO_COLOR;
  process.env[snapshotKey] = "at-factory";
  const colored = imported.createCliRuntime(root);
  assert.equal(colored.C.g, "\x1b[32m");
  assert.equal(colored.childEnv[snapshotKey], "at-factory");

  process.env.NO_COLOR = "1";
  process.env[snapshotKey] = "after-factory";
  assert.equal(colored.C.g, "\x1b[32m");
  assert.equal(colored.childEnv[snapshotKey], "at-factory");

  const plain = imported.createCliRuntime(root);
  assert.deepEqual(plain.C, {
    g: "",
    y: "",
    r: "",
    c: "",
    b: "",
    d: "",
    x: "",
  });
  assert.equal(plain.childEnv[snapshotKey], "after-factory");
});

test("run and cap preserve caller option precedence", async (t) => {
  const root = await sandbox(t);
  const overrideCwd = join(root, "override-cwd");
  mkdirSync(overrideCwd);
  const evaluatedCwd = realpathSync(overrideCwd);
  const runtime = createCliRuntime(root);
  const childScript =
    "process.stdout.write(`${process.cwd()}|${process.env.IVA_RUNTIME_OPTION_TEST || ''}`)";
  const overrideEnv = { IVA_RUNTIME_OPTION_TEST: "caller" };

  const runResult = runtime.run(process.execPath, ["-e", childScript], {
    cwd: overrideCwd,
    encoding: "utf8",
    env: overrideEnv,
    stdio: "pipe",
  });
  assert.equal(runResult.status, 0);
  assert.equal(runResult.stdout, `${evaluatedCwd}|caller`);

  const capResult = runtime.cap(process.execPath, ["-e", childScript], {
    cwd: overrideCwd,
    env: overrideEnv,
  });
  assert.deepEqual(capResult, {
    code: 0,
    out: `${evaluatedCwd}|caller`,
    err: "",
  });
});

test("cap trims output and normalizes a missing status to one", async (t) => {
  const root = await sandbox(t);
  const runtime = createCliRuntime(root);

  assert.deepEqual(
    runtime.cap(process.execPath, [
      "-e",
      "process.stdout.write('  output \\n'); process.stderr.write('  warning \\n'); process.exit(7)",
    ]),
    { code: 7, out: "output", err: "warning" },
  );
  assert.deepEqual(runtime.cap("iva-command-that-does-not-exist", []), {
    code: 1,
    out: "",
    err: "",
  });
});

test("readEnv and dataDirAbs retain the CLI path rules", async (t) => {
  const root = await sandbox(t);
  const runtime = createCliRuntime(root);

  assert.deepEqual(runtime.readEnv(), {});
  writeFileSync(
    runtime.ENV_PATH,
    [
      "# comment",
      " MODEL_PROVIDER = 'codex' ",
      'ASSISTANT_DATA_DIR="runtime-data"',
      "lowercase=ignored",
      "MODEL_PROVIDER=ollama",
      "",
    ].join("\n"),
  );
  assert.deepEqual(runtime.readEnv(), {
    MODEL_PROVIDER: "ollama",
    ASSISTANT_DATA_DIR: "runtime-data",
  });
  assert.equal(runtime.dataDirAbs(), join(root, "runtime-data"));
  assert.equal(runtime.dataDirAbs({}), join(root, "data"));
  assert.equal(
    runtime.dataDirAbs({ ASSISTANT_DATA_DIR: "nested/data" }),
    join(root, "nested/data"),
  );
  assert.equal(
    runtime.dataDirAbs({ ASSISTANT_DATA_DIR: "/srv/iva-data" }),
    "/srv/iva-data",
  );
  assert.equal(
    runtime.dataDirAbs({ ASSISTANT_DATA_DIR: "" }),
    join(root, "data"),
  );
});

test("writeEnvVars rejects CRLF values before writing", async (t) => {
  const root = await sandbox(t);
  const runtime = createCliRuntime(root);
  writeFileSync(runtime.ENV_PATH, "KEEP=original\n");

  assert.throws(
    () => runtime.writeEnvVars({ TELEGRAM_API_HASH: "first\rsecond" }),
    /env value for TELEGRAM_API_HASH contains a newline/u,
  );
  assert.throws(
    () => runtime.writeEnvVars({ TELEGRAM_API_HASH: "first\nsecond" }),
    /env value for TELEGRAM_API_HASH contains a newline/u,
  );
  assert.equal(readFileSync(runtime.ENV_PATH, "utf8"), "KEEP=original\n");
});

test("writeEnvVars deduplicates CRLF input and writes one atomic LF record", async (t) => {
  const root = await sandbox(t);
  const runtime = createCliRuntime(root);
  writeFileSync(
    runtime.ENV_PATH,
    "# keep\r\nTELEGRAM_API_ID=old\r\nOTHER=value\r\nTELEGRAM_API_ID=duplicate\r\n\r\n",
  );

  runtime.writeEnvVars({ TELEGRAM_API_ID: 42, NEW_FLAG: false });

  assert.equal(
    readFileSync(runtime.ENV_PATH, "utf8"),
    "# keep\nTELEGRAM_API_ID=42\nOTHER=value\nNEW_FLAG=false\n",
  );
  assert.equal(statSync(runtime.ENV_PATH).mode & 0o777, 0o600);
});

test("childEnv keeps the caller's PATH order when NODE_BIN_DIR is already on it", async (t) => {
  const root = await sandbox(t);
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const nodeBinDir = dirname(process.execPath);
  // Both fixture entries live under the sandbox, so neither can accidentally
  // equal nodeBinDir on a machine that keeps node somewhere unusual.
  const stubBin = join(root, "stub-bin");
  const tailBin = join(root, "tail-bin");
  process.env.PATH = `${stubBin}:${nodeBinDir}:${tailBin}`;

  const entries = (createCliRuntime(root).childEnv.PATH ?? "").split(":");

  // The whole array, not just the head: a dropped or reordered tail entry is
  // the same defect as a stub that stops winning.
  assert.deepEqual(entries, [stubBin, nodeBinDir, tailBin]);
});

test("childEnv prepends NODE_BIN_DIR when PATH does not carry it", async (t) => {
  const root = await sandbox(t);
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const nodeBinDir = dirname(process.execPath);
  process.env.PATH = "/nonexistent-a:/nonexistent-b";

  assert.equal(
    createCliRuntime(root).childEnv.PATH,
    `${nodeBinDir}:/nonexistent-a:/nonexistent-b`,
  );
});
