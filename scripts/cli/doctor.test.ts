/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createSystemdControl } from "../lib/systemd-control.ts";
import { createDoctorCommand } from "./doctor.ts";
import { createCliRuntime } from "./runtime.ts";
import { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SystemdLifecycle = ReturnType<typeof createCliSystemd>;

const NO_COLOR = { g: "", y: "", r: "", c: "", b: "", d: "", x: "" };

async function sandbox(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iva-cli-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".output/server"), { recursive: true });
  writeFileSync(join(root, ".output/server/index.mjs"), "export {};\n");
  return root;
}

function completeEnv(): Record<string, string> {
  return {
    OLLAMA_API_KEY: "ollama-key",
    OLLAMA_MODEL: "model",
    DEEPGRAM_API_KEY: "deepgram-key",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    TELEGRAM_ALLOWED_USER_IDS: "1",
    ASSISTANT_BEARER: "b".repeat(43),
    TAVILY_API_KEY: "tavily-key",
  };
}

function lifecycle(
  overrides: Partial<SystemdLifecycle> = {},
): SystemdLifecycle {
  return {
    ensureAssistantBearer: () => false,
    writeUnits: () => [],
    activateUnits: () => undefined,
    removeUnits: () => [],
    migrateEnv: () => false,
    restartServices: () => undefined,
    ...overrides,
  };
}

test("non-systemd doctor preserves exact counter and exit semantics", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "present=true\n");
  const events: Array<[string, string]> = [];
  const summaryLogs: unknown[][] = [];
  const exitCodes: number[] = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: completeEnv,
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.19.0",
    log: (...args) => summaryLogs.push(args),
    exit: (code) => exitCodes.push(code),
  })();

  assert.deepEqual(events, [
    ["ok", "Node 24.19.0"],
    ["ok", ".env filled in (provider: ollama)"],
    ["ok", "web_search: tavily"],
    ["ok", "memory_search: grep"],
    ["ok", "Build in place (.output)"],
    [
      "warn",
      "systemd unavailable (not Linux) — skipping service and timer checks",
    ],
  ]);
  assert.deepEqual(summaryLogs, [
    [],
    ["Summary: 5 ok · 0 warn · 0 fixed · 0 fail"],
  ]);
  assert.deepEqual(exitCodes, [0]);
});

test("missing env remains a failure while the systemd warning stays uncounted", async (t) => {
  const root = await sandbox(t);
  const events: Array<[string, string]> = [];
  const summaryLogs: unknown[][] = [];
  const exitCodes: number[] = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    readEnv: () => ({}),
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.0.0",
    log: (...args) => summaryLogs.push(args),
    exit: (code) => exitCodes.push(code),
  })();

  assert.deepEqual(events, [
    ["ok", "Node 24.0.0"],
    ["bad", ".env missing — run: iva config"],
    ["ok", "Build in place (.output)"],
    [
      "warn",
      "systemd unavailable (not Linux) — skipping service and timer checks",
    ],
  ]);
  assert.deepEqual(summaryLogs, [
    [],
    ["Summary: 2 ok · 0 warn · 0 fixed · 1 fail"],
  ]);
  assert.deepEqual(exitCodes, [1]);
});

test("doctor keeps the initial env snapshot but reads the migrated listener port fresh", async (t) => {
  const root = await sandbox(t);
  const unitDir = join(root, "units");
  const vault = join(root, "vault-initial");
  mkdirSync(unitDir);
  mkdirSync(vault);
  writeFileSync(join(unitDir, "iva.service"), "[Service]\n");
  writeFileSync(join(root, ".env"), "present=true\n");

  const initialEnv = {
    ...completeEnv(),
    ASSISTANT_DATA_DIR: "data-initial",
    ASSISTANT_VAULT_DIR: "vault-initial",
  };
  const migratedEnv = { IVA_PORT: "9123" };
  const calls: string[] = [];
  const dataDirInputs: Array<Partial<Record<string, string>>> = [];
  const listenerArgs: Array<readonly string[]> = [];
  const exitCodes: number[] = [];
  let readCount = 0;
  const systemd = createSystemdControl({
    run: (args) => {
      if (args[0] === "is-enabled") return { code: 0, out: "enabled" };
      if (args[0] === "is-active") return { code: 0, out: "active" };
      return { code: 0, out: "" };
    },
  });
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    UNIT_DIR: unitDir,
    SERVICES: [],
    MEMORY_SERVICES: [],
    MEMORY_TIMERS: [],
    TIMERS: [],
    C: NO_COLOR,
    ok: () => undefined,
    warn: () => undefined,
    bad: () => undefined,
    hasSystemd: () => true,
    systemd,
    readEnv: () => {
      readCount++;
      calls.push(readCount === 1 ? "read-initial" : "read-fresh");
      return readCount === 1 ? initialEnv : migratedEnv;
    },
    dataDirAbs: (env = initialEnv) => {
      dataDirInputs.push(env);
      calls.push("data-dir");
      return join(root, "data-initial");
    },
    cap: (command, args) => {
      if (command === "ss") {
        calls.push("inspect-listener");
        listenerArgs.push(args);
        return {
          code: 0,
          out: "LISTEN 0 511 127.0.0.1:9123 0.0.0.0:*",
          err: "",
        };
      }
      assert.equal(command, "git");
      return { code: 0, out: "git@example.test:vault.git", err: "" };
    },
  };
  const systemdLifecycle = lifecycle({
    ensureAssistantBearer: () => {
      calls.push("ensure-bearer");
      return false;
    },
    migrateEnv: () => {
      calls.push("migrate-env");
      return true;
    },
    writeUnits: () => {
      calls.push("write-units");
      return [];
    },
  });

  await createDoctorCommand(runtime, systemdLifecycle, {
    nodeVersion: "24.19.0",
    log: () => undefined,
    exit: (code) => exitCodes.push(code),
  })();

  assert.equal(readCount, 2);
  assert.ok(calls.indexOf("read-initial") < calls.indexOf("migrate-env"));
  assert.ok(calls.indexOf("migrate-env") < calls.indexOf("read-fresh"));
  assert.ok(calls.indexOf("read-fresh") < calls.indexOf("inspect-listener"));
  assert.deepEqual(listenerArgs, [["-H", "-ltn", "sport", "=", ":9123"]]);
  assert.equal(dataDirInputs.length, 1);
  assert.strictEqual(dataDirInputs[0], initialEnv);
  assert.deepEqual(exitCodes, [0]);
});

test("opencode diagnostics preserve required-key order", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "MODEL_PROVIDER=opencode\n");
  const failures: string[] = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: () => undefined,
    warn: () => undefined,
    bad: (message) => failures.push(message),
    readEnv: () => ({ MODEL_PROVIDER: "opencode" }),
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.0.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  assert.equal(
    failures[0],
    ".env incomplete, missing: OPENCODE_API_KEY, OPENCODE_MODEL, DEEPGRAM_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, ASSISTANT_BEARER — run: iva config",
  );
});

test("doctor rejects an invalid model provider instead of diagnosing Ollama", async (t) => {
  const root = await sandbox(t);
  writeFileSync(join(root, ".env"), "MODEL_PROVIDER=ollmaa\n");
  const failures: string[] = [];
  const runtime: CliRuntime = {
    ...createCliRuntime(root),
    C: NO_COLOR,
    ok: () => undefined,
    warn: () => undefined,
    bad: (message) => failures.push(message),
    readEnv: () => ({ MODEL_PROVIDER: "ollmaa" }),
    hasSystemd: () => false,
  };

  await createDoctorCommand(runtime, lifecycle(), {
    nodeVersion: "24.0.0",
    log: () => undefined,
    exit: () => undefined,
  })();

  assert.equal(
    failures[0],
    'Invalid MODEL_PROVIDER "ollmaa"; expected one of: ollama, opencode, openrouter, codex — run: iva config',
  );
  assert.equal(
    failures.some((message) => message.includes("OLLAMA_")),
    false,
  );
});
