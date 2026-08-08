import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { writeEnvAtomicSync } from "../lib/env-file.ts";
import { createSystemdControl } from "../lib/systemd-control.ts";

type CaptureOptions = Omit<SpawnSyncOptions, "encoding"> & {
  readonly encoding?: BufferEncoding;
};

type CaptureResult = {
  readonly code: number;
  readonly out: string;
  readonly err: string;
};

type EnvValues = Record<string, string>;

type RuntimeColors = {
  readonly g: string;
  readonly y: string;
  readonly r: string;
  readonly c: string;
  readonly b: string;
  readonly d: string;
  readonly x: string;
};

/** Create the shared, side-effect-free-at-import runtime used by the Iva CLI. */
export function createCliRuntime(root: string) {
  const ROOT = root;
  const ENV_PATH = join(ROOT, ".env");
  const UNIT_DIR = join(homedir(), ".config/systemd/user");
  const NODE = process.execPath;
  const NODE_BIN_DIR = dirname(NODE);
  const NPM = existsSync(join(NODE_BIN_DIR, "npm"))
    ? join(NODE_BIN_DIR, "npm")
    : "npm";
  // Child processes need the same node/npm the CLI itself runs on, so NODE_BIN_DIR goes
  // in front — but only when PATH does not already contain it. Prepending it a second
  // time silently reorders PATH: with a system Node in /usr/bin, /usr/bin jumps ahead of
  // whatever the caller put first, so a stub placed earlier in PATH stops winning. That
  // is how `scripts/cli/services-entrypoints.test.ts` reached the real systemctl instead
  // of its own fake and drove live user units.
  const pathEntries = (process.env.PATH || "").split(":").filter(Boolean);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: (pathEntries.includes(NODE_BIN_DIR)
      ? pathEntries
      : [NODE_BIN_DIR, ...pathEntries]
    ).join(":"),
  };

  const SERVICES = ["iva.service", "iva-telegram-poll.service"];
  const MEMORY_PERIODS = ["doctor"];
  const MEMORY_SERVICES = MEMORY_PERIODS.map(
    (name) => `iva-memory-${name}.service`,
  );
  const MEMORY_TIMERS = MEMORY_PERIODS.map(
    (name) => `iva-memory-${name}.timer`,
  );
  const UPDATE_TIMER = "iva-update-check.timer";
  const TIMERS = [...MEMORY_TIMERS, UPDATE_TIMER];

  const SVC_USERBOT = "iva-telegram-userbot.service";
  const USERBOT_DIR = join(ROOT, "services/telegram-userbot");
  const VENV_PY = join(USERBOT_DIR, ".venv/bin/python");
  const TOKEN_FILE = join(ROOT, "data/telegram-userbot.token");

  const DEFAULT_PORT = "8723";
  const OLD_DEFAULT_HOST = "http://127.0.0.1:3000";

  const C: RuntimeColors =
    process.env.NO_COLOR || process.env.TERM === "dumb"
      ? { g: "", y: "", r: "", c: "", b: "", d: "", x: "" }
      : {
          g: "\x1b[32m",
          y: "\x1b[33m",
          r: "\x1b[31m",
          c: "\x1b[36m",
          b: "\x1b[1m",
          d: "\x1b[2m",
          x: "\x1b[0m",
        };
  const ok = (message: string): void => console.log(`${C.g}✓${C.x} ${message}`);
  const warn = (message: string): void =>
    console.log(`${C.y}!${C.x} ${message}`);
  const bad = (message: string): void =>
    console.log(`${C.r}✗${C.x} ${message}`);
  const step = (message: string): void =>
    console.log(`${C.b}${C.c}▸ ${message}${C.x}`);

  function run(
    command: string,
    args: readonly string[],
    options: SpawnSyncOptions = {},
  ) {
    return spawnSync(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: childEnv,
      ...options,
    });
  }

  function cap(
    command: string,
    args: readonly string[],
    options: CaptureOptions = {},
  ): CaptureResult {
    const result = spawnSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      env: childEnv,
      ...options,
    });
    return {
      code: result.status ?? 1,
      out: (result.stdout || "").trim(),
      err: (result.stderr || "").trim(),
    };
  }

  const hasSystemd = (): boolean =>
    !!cap("sh", ["-c", "command -v systemctl"]).out;
  const scQ = (...args: string[]): CaptureResult =>
    cap("systemctl", ["--user", ...args]);
  const systemd = createSystemdControl({ run: (args) => scQ(...args) });
  const gitHead = (): string =>
    cap("git", ["rev-parse", "--short", "HEAD"]).out;

  function readEnv(): EnvValues {
    const env: EnvValues = {};
    if (!existsSync(ENV_PATH)) return env;
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
    return env;
  }

  function dataDirAbs(env: Partial<EnvValues> = readEnv()): string {
    const dataDir = env.ASSISTANT_DATA_DIR || "data";
    return dataDir.startsWith("/") ? dataDir : join(ROOT, dataDir);
  }

  async function confirm(question: string, defaultValue = false) {
    if (!process.stdin.isTTY) return defaultValue;
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = (
      await readline.question(
        `${question} ${defaultValue ? "[Y/n]" : "[y/N]"} `,
      )
    )
      .trim()
      .toLowerCase();
    readline.close();
    return answer ? answer.startsWith("y") : defaultValue;
  }

  function requireSystemd(): void {
    if (!hasSystemd()) {
      bad("systemd unavailable — this command only works on a Linux server");
      process.exit(1);
    }
  }

  function writeEnvVars(vars: Readonly<Record<string, unknown>>): void {
    for (const [key, value] of Object.entries(vars)) {
      if (/[\r\n]/.test(String(value)))
        throw new Error(`env value for ${key} contains a newline`);
    }
    const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
    const pending = new Map(
      Object.entries(vars).map(([key, value]) => [key, String(value)]),
    );
    const out: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const key = line.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1];
      if (key && Object.hasOwn(vars, key)) {
        if (pending.has(key)) {
          out.push(`${key}=${pending.get(key)}`);
          pending.delete(key);
        }
        continue;
      }
      out.push(line);
    }
    while (out.length && out.at(-1) === "") out.pop();
    for (const [key, value] of pending) out.push(`${key}=${value}`);
    writeEnvAtomicSync(ENV_PATH, `${out.join("\n")}\n`);
  }

  return {
    ROOT,
    ENV_PATH,
    UNIT_DIR,
    NODE,
    NODE_BIN_DIR,
    NPM,
    childEnv,
    SERVICES,
    MEMORY_PERIODS,
    MEMORY_SERVICES,
    MEMORY_TIMERS,
    UPDATE_TIMER,
    TIMERS,
    SVC_USERBOT,
    USERBOT_DIR,
    VENV_PY,
    TOKEN_FILE,
    DEFAULT_PORT,
    OLD_DEFAULT_HOST,
    C,
    ok,
    warn,
    bad,
    step,
    run,
    cap,
    hasSystemd,
    scQ,
    systemd,
    gitHead,
    readEnv,
    dataDirAbs,
    confirm,
    requireSystemd,
    writeEnvVars,
  };
}
