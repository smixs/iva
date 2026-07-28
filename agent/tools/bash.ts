import { defineTool } from "eve/tools";
import { z } from "zod";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { selfRestartViolation } from "../lib/self-restart-guard.ts";

// Host-native bash. Переопределяет встроенный sandbox-bash eve: команда выполняется
// напрямую на реальной файловой системе VPS через node:child_process (без sandbox).
// Самодостаточно: импортирует только eve/tools, zod и node-builtins.

const MAX_OUTPUT = 30_000; // оставляем последние ~30k символов каждого потока
const TERM_GRACE_MS = 400;
const KILL_GRACE_MS = 400;
const REAP_POLL_MS = 20;
const PIPE_DRAIN_GRACE_MS = 100;
// A per-call Worker must have enough time to start and observe the root process.
// Shorter deadlines are rejected instead of pretending they can be enforced reliably.
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 2_147_483_647;
const DEADLINE_ARMED = 0;
const DEADLINE_CANCELLED = 1;
const DEADLINE_EXPIRED = 2;
const DEADLINE_PROBE_FAILED = 3;

// setTimeout shares the agent's event loop. A synchronous tool or native call can
// block that loop past the deadline, so a small worker owns the deadline signal.
// The worker only observes the root PID and signals the process group created by
// this invocation; manager-owned jobs in another group remain outside its scope.
const DEADLINE_WATCHDOG_SOURCE = String.raw`
  const { execFileSync } = require("node:child_process");
  const { readFileSync } = require("node:fs");
  const { workerData } = require("node:worker_threads");
  const state = new Int32Array(workerData.state);
  const pid = workerData.pid;
  const deadlineNs = workerData.deadlineNs;
  const termGraceNs = BigInt(workerData.termGraceMs) * 1000000n;
  const killGraceNs = BigInt(workerData.killGraceMs) * 1000000n;
  const pollMs = workerData.pollMs;

  function signalGroup(signal) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      return error && error.code !== "ESRCH";
    }
  }

  function signalRoot(signal) {
    try {
      process.kill(pid, signal);
      return true;
    } catch (error) {
      return !error || error.code !== "ESRCH";
    }
  }

  function portableRootState() {
    try {
      const stat = execFileSync(
        "/bin/ps",
        ["-o", "stat=", "-p", String(pid)],
        {
          encoding: "utf8",
          maxBuffer: 1024,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 100,
        },
      ).trim();
      if (!stat || stat.startsWith("Z")) return 0;
      return 1;
    } catch {
      return signalRoot(0) ? -1 : 0;
    }
  }

  function rootState() {
    if (process.platform === "linux" && !workerData.forcePortableProbe) {
      try {
        const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
        const stateOffset = stat.lastIndexOf(") ") + 2;
        if (stateOffset >= 2) {
          const processState = stat[stateOffset];
          return processState === "Z" || processState === "X" || processState === "x"
            ? 0
            : 1;
        }
      } catch (error) {
        if (error && error.code === "ENOENT") return 0;
      }
    }
    return portableRootState();
  }

  function waitUntilDeadline(deadline) {
    while (Atomics.load(state, 0) === 0) {
      const remainingNs = deadline - process.hrtime.bigint();
      if (remainingNs <= 0n) return true;
      const remainingMs = Number((remainingNs + 999999n) / 1000000n);
      Atomics.wait(state, 0, 0, Math.min(pollMs, remainingMs));
    }
    return false;
  }

  function waitForGroupExit(deadline) {
    while (process.hrtime.bigint() < deadline) {
      if (!signalGroup(0)) return true;
      Atomics.wait(state, 1, 0, pollMs);
    }
    return !signalGroup(0);
  }

  const reachedDeadline = waitUntilDeadline(deadlineNs);
  if (reachedDeadline && Atomics.load(state, 0) === 0) {
    const observedRootState = rootState();
    const deadlineResult =
      observedRootState === 1 ? 2 : observedRootState === 0 ? 1 : 3;
    Atomics.compareExchange(state, 0, 0, deadlineResult);
  }
  const deadlineResult = Atomics.load(state, 0);
  if (deadlineResult === 2 || deadlineResult === 3) {
    if (signalGroup("SIGTERM")) {
      const termDeadline = process.hrtime.bigint() + termGraceNs;
      if (!waitForGroupExit(termDeadline)) {
        signalGroup("SIGKILL");
        waitForGroupExit(process.hrtime.bigint() + killGraceNs);
      }
    }
  } else {
    Atomics.compareExchange(state, 0, 0, 1);
  }
`;

export const deadlineWorkerRuntime = {
  create(options: ConstructorParameters<typeof Worker>[1]): Worker {
    return new Worker(DEADLINE_WATCHDOG_SOURCE, options);
  },
};

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_OUTPUT) return { text: s, truncated: false };
  return { text: s.slice(s.length - MAX_OUTPUT), truncated: true };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    // detached:true makes the shell the leader of a fresh POSIX process group.
    // A negative pid addresses that whole group, including grandchildren.
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return false;
    return false;
  }
}

function processGroupExists(pid: number): boolean {
  return signalProcessGroup(pid, 0);
}

type RootProcessState = "live" | "exited" | "unknown";

function signalRootExists(pid: number): RootProcessState {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH" ? "exited" : "unknown";
  }
}

function portableRootProcessState(pid: number): RootProcessState {
  try {
    const stat = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 100,
    }).trim();
    if (!stat || stat.startsWith("Z")) return "exited";
    return "live";
  } catch {
    return signalRootExists(pid) === "exited" ? "exited" : "unknown";
  }
}

function rootProcessState(pid: number): RootProcessState {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const stateOffset = stat.lastIndexOf(") ") + 2;
      if (stateOffset >= 2) {
        const state = stat[stateOffset];
        return state === "Z" || state === "X" || state === "x" ? "exited" : "live";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "exited";
    }
  }
  return portableRootProcessState(pid);
}

async function waitForGroupExit(groupPid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(groupPid)) return true;
    await delay(REAP_POLL_MS);
  }
  return !processGroupExists(groupPid);
}

async function reapProcessGroup(groupPid: number): Promise<void> {
  if (!signalProcessGroup(groupPid, "SIGTERM")) return;
  if (await waitForGroupExit(groupPid, TERM_GRACE_MS)) return;
  signalProcessGroup(groupPid, "SIGKILL");
  await waitForGroupExit(groupPid, KILL_GRACE_MS);
}

// Модель иногда угадывает cwd (например /root/... вместо реального HOME или несуществующий
// /workspace) — exec тогда падает сырым EACCES/ENOENT ещё до запуска команды, и агент строит
// неверные выводы (см. issue #17). Разворачиваем ~ и проверяем директорию ДО exec, чтобы вернуть
// понятную диагностику вместо низкоуровневого сбоя Node.
// ponytail: /workspace намеренно НЕ маппим на корень проекта — молчаливая догадка хуже ясной ошибки.
export function normalizeCwd(cwd?: string): { cwd?: string; error?: string } {
  if (!cwd || !cwd.trim()) return {}; // exec возьмёт process.cwd()
  let resolved = cwd;
  if (cwd === "~") resolved = homedir();
  else if (cwd.startsWith("~/")) resolved = join(homedir(), cwd.slice(2));
  try {
    if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
  } catch {
    return {
      error:
        `cwd "${cwd}"${resolved !== cwd ? ` → "${resolved}"` : ""}: не существует, не директория ` +
        `или нет доступа. Сервис работает в ${process.cwd()}, HOME=${homedir()}. ` +
        `Повтори без cwd или укажи существующий абсолютный host-путь (не /workspace).`,
    };
  }
  return { cwd: resolved };
}

export default defineTool({
  description:
    "Выполнить shell-команду НАПРЯМУЮ на хосте VPS (без sandbox, полный доступ к реальной " +
    "файловой системе и окружению). Возвращает { stdout, stderr, exitCode }. " +
    "Очень большой вывод обрезается до последних ~30000 символов каждого потока " +
    "(в этом случае добавляется пометка об усечении). " +
    "Используй для запуска любых команд: git, ls, uv, systemctl --user и т.д. " +
    "Команды, останавливающие сервис самой Ивы (iva restart/stop/update, " +
    "systemctl … restart iva, pkill node), заблокированы — перезапуск инициирует " +
    "только пользователь: /restart или /update в чате, iva restart в терминале.",
  inputSchema: z.object({
    command: z.string().min(1).describe("Shell-команда для выполнения на хосте"),
    cwd: z
      .string()
      .optional()
      .describe(
        "Рабочая директория: абсолютный host-путь; ~ разворачивается в HOME. " +
          "/workspace на хосте не существует — не используй. Не уверен в пути — не указывай cwd.",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(MIN_TIMEOUT_MS, `timeoutMs должен быть не меньше ${MIN_TIMEOUT_MS} ms`)
      .max(MAX_TIMEOUT_MS, `timeoutMs должен быть не больше ${MAX_TIMEOUT_MS} ms`)
      .optional()
      .describe(
        `Таймаут в миллисекундах, от ${MIN_TIMEOUT_MS} до ${MAX_TIMEOUT_MS} ms ` +
          "(по умолчанию 120000)",
      ),
  }),
  async execute({ command, cwd, timeoutMs }) {
    // Самоубийственные команды режем ДО запуска: рестарт собственного сервиса посреди
    // хода оставляет ход в running навсегда, сервис уходит в цикл переигрываний, а бот
    // немеет с HookConflictError (issue #68). Промпт-запрета мало — модели его игнорируют.
    const lethal = selfRestartViolation(command);
    if (lethal) return { stdout: "", stderr: lethal, exitCode: 1 };
    const timeout = timeoutMs ?? 120_000;
    if (
      !Number.isSafeInteger(timeout) ||
      timeout < MIN_TIMEOUT_MS ||
      timeout > MAX_TIMEOUT_MS
    ) {
      return {
        stdout: "",
        stderr:
          `timeoutMs должен быть целым числом от ${MIN_TIMEOUT_MS} до ` +
          `${MAX_TIMEOUT_MS} ms.`,
        exitCode: 1,
      };
    }
    const norm = normalizeCwd(cwd);
    if (norm.error) return { stdout: "", stderr: norm.error, exitCode: 1 };
    const runCwd = norm.cwd ?? process.cwd();
    return await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      cwd: string;
      truncated?: boolean;
      timedOut?: boolean;
    }>((resolve) => {
      const resolveSpawnFailure = (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        const failure = truncate(`Не удалось запустить shell: ${detail}`);
        resolve({
          stdout: "",
          stderr: failure.text,
          exitCode: 1,
          cwd: runCwd,
          truncated: failure.truncated || undefined,
        });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, {
          cwd: runCwd,
          shell: true,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolveSpawnFailure(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      let outputTruncated = false;
      let exitCode = 1;
      let timedOut = false;
      let commandExited = false;
      let pipesDone = false;
      let cleanupDone = false;
      let settled = false;
      let cleanup: Promise<void> | null = null;
      let pipeDrainTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let initialized = false;

      child.once("error", (error) => {
        if (!initialized) {
          resolveSpawnFailure(error);
          return;
        }
        stderr = append(stderr, error.message);
        commandExited = true;
        cleanupDone = true;
        pipesDone = true;
        cancelDeadline();
        finish();
      });

      const childPid = child.pid;
      const childStdout = child.stdout;
      const childStderr = child.stderr;
      if (childPid === undefined || !childStdout || !childStderr) return;

      const deadlineNs = process.hrtime.bigint() + BigInt(timeout) * 1_000_000n;
      const deadlineState = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));

      const append = (current: string, chunk: string): string => {
        const next = truncate(current + chunk);
        if (next.truncated) outputTruncated = true;
        return next.text;
      };
      childStdout.setEncoding("utf8");
      childStderr.setEncoding("utf8");
      childStdout.on("data", (chunk: string) => {
        stdout = append(stdout, chunk);
      });
      childStderr.on("data", (chunk: string) => {
        stderr = append(stderr, chunk);
      });

      const finish = () => {
        if (settled || !commandExited || !pipesDone || !cleanupDone) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (pipeDrainTimer) clearTimeout(pipeDrainTimer);
        const deadlineResult = Atomics.load(deadlineState, 0);
        timedOut ||= deadlineResult === DEADLINE_EXPIRED;
        if (deadlineResult === DEADLINE_PROBE_FAILED) {
          stderr = append(
            stderr,
            `${stderr ? "\n" : ""}Не удалось проверить состояние shell на дедлайне; ` +
              "группа процессов остановлена.",
          );
          exitCode = 1;
        }
        resolve({
          stdout,
          stderr,
          exitCode,
          cwd: runCwd,
          truncated: outputTruncated || undefined,
          timedOut: timedOut || undefined,
        });
      };
      const startCleanup = () => {
        if (cleanup) return cleanup;
        cleanup = reapProcessGroup(childPid)
          .catch(() => {})
          .finally(() => {
            cleanupDone = true;
            if (!pipesDone) {
              pipeDrainTimer = setTimeout(() => {
                childStdout.destroy();
                childStderr.destroy();
                pipesDone = true;
                finish();
              }, PIPE_DRAIN_GRACE_MS);
            }
            finish();
        });
        return cleanup;
      };
      const cancelDeadline = () => {
        if (
          Atomics.compareExchange(
            deadlineState,
            0,
            DEADLINE_ARMED,
            DEADLINE_CANCELLED,
          ) === DEADLINE_ARMED
        ) {
          Atomics.notify(deadlineState, 0);
        }
      };

      child.once("exit", (code) => {
        commandExited = true;
        exitCode = typeof code === "number" ? code : 1;
        cancelDeadline();
        timedOut ||= Atomics.load(deadlineState, 0) === DEADLINE_EXPIRED;
        void startCleanup().then(finish);
      });
      child.once("close", () => {
        pipesDone = true;
        if (pipeDrainTimer) clearTimeout(pipeDrainTimer);
        cancelDeadline();
        timedOut ||= Atomics.load(deadlineState, 0) === DEADLINE_EXPIRED;
        startCleanup();
        finish();
      });

      const enforceDeadline = () => {
        const remainingNs = deadlineNs - process.hrtime.bigint();
        if (remainingNs > 0n) {
          timeoutTimer = setTimeout(
            enforceDeadline,
            Number((remainingNs + 999_999n) / 1_000_000n),
          );
          return;
        }
        if (commandExited) return;
        const deadlineResult = Atomics.load(deadlineState, 0);
        if (deadlineResult === DEADLINE_EXPIRED) {
          timedOut = true;
          startCleanup();
          return;
        }
        if (deadlineResult === DEADLINE_PROBE_FAILED) {
          startCleanup();
          return;
        }
        const observedRootState = rootProcessState(childPid);
        if (observedRootState === "exited") {
          cancelDeadline();
          startCleanup();
          return;
        }
        if (observedRootState === "unknown") {
          if (
            Atomics.compareExchange(
              deadlineState,
              0,
              DEADLINE_ARMED,
              DEADLINE_PROBE_FAILED,
            ) === DEADLINE_ARMED
          ) {
            Atomics.notify(deadlineState, 0);
          }
          startCleanup();
          return;
        }
        if (
          Atomics.compareExchange(
            deadlineState,
            0,
            DEADLINE_ARMED,
            DEADLINE_EXPIRED,
          ) === DEADLINE_ARMED
        ) {
          Atomics.notify(deadlineState, 0);
          timedOut = true;
          startCleanup();
        }
      };
      initialized = true;
      timeoutTimer = setTimeout(enforceDeadline, timeout);
      try {
        const deadlineWorker = deadlineWorkerRuntime.create({
          eval: true,
          workerData: {
            state: deadlineState.buffer,
            pid: childPid,
            deadlineNs,
            termGraceMs: TERM_GRACE_MS,
            killGraceMs: KILL_GRACE_MS,
            pollMs: REAP_POLL_MS,
          },
        });
        // An asynchronous Worker failure leaves the already-armed main-thread
        // deadline and process lifecycle handlers in charge.
        deadlineWorker.on("error", () => {});
        deadlineWorker.unref();
      } catch {
        // Resource exhaustion can make Worker construction throw synchronously.
        // The main-thread timer remains a bounded fallback while its loop is responsive.
      }
    });
  },
});
