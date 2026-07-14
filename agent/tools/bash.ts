import { defineTool } from "eve/tools";
import { z } from "zod";
import { exec } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Host-native bash. Переопределяет встроенный sandbox-bash eve: команда выполняется
// напрямую на реальной файловой системе хоста через node:child_process (без sandbox).
// Самодостаточно: импортирует только eve/tools, zod и node-builtins.

const MAX_OUTPUT = 30_000; // оставляем последние ~30k символов каждого потока

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_OUTPUT) return { text: s, truncated: false };
  return { text: s.slice(s.length - MAX_OUTPUT), truncated: true };
}

export function normalizeCwd(cwd?: string):
  | { ok: true; cwd: string; note?: string }
  | { ok: false; error: string } {
  const raw = cwd?.trim();
  if (!raw) {
    return {
      ok: true,
      cwd: process.cwd(),
      note: "cwd omitted; using the host process working directory",
    };
  }

  if (raw === "/workspace" || raw.startsWith("/workspace/")) {
    return {
      ok: false,
      error:
        `cwd "${raw}" is an Eve sandbox path, but this tool runs on the host filesystem. ` +
        `Use a real host path or omit cwd; current host cwd is "${process.cwd()}".`,
    };
  }

  const home = process.env.HOME || homedir();
  let resolved = raw;
  let note: string | undefined;

  if (raw === "~") {
    resolved = home;
    note = `expanded "~" to "${resolved}"`;
  } else if (raw.startsWith("~/")) {
    resolved = join(home, raw.slice(2));
    note = `expanded "~/" using HOME to "${resolved}"`;
  }

  try {
    const st = statSync(resolved);
    if (!st.isDirectory()) {
      return { ok: false, error: `cwd "${resolved}" exists but is not a directory` };
    }
    accessSync(resolved, constants.R_OK | constants.X_OK);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "UNKNOWN")
        : "UNKNOWN";
    return { ok: false, error: `cwd "${resolved}" is unavailable (${code})` };
  }

  return { ok: true, cwd: resolved, note };
}

export default defineTool({
  description:
    "Выполнить shell-команду НАПРЯМУЮ на файловой системе хоста (без sandbox, с правами пользователя процесса). " +
    "Возвращает { stdout, stderr, exitCode, cwd }. Очень большой вывод обрезается до последних ~30000 символов " +
    "каждого потока. Не используй Eve-путь /workspace: укажи реальный host path или не передавай cwd.",
  inputSchema: z.object({
    command: z.string().min(1).describe("Shell-команда для выполнения на хосте"),
    cwd: z
      .string()
      .optional()
      .describe("Рабочая директория на хосте; поддерживаются абсолютный путь, ~ и ~/...; не используй /workspace"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Таймаут в миллисекундах (по умолчанию 120000)"),
  }),
  async execute({ command, cwd, timeoutMs }) {
    const normalized = normalizeCwd(cwd);
    if (!normalized.ok) {
      return {
        stdout: "",
        stderr: normalized.error,
        exitCode: 1,
        cwd: null,
        cwdError: true,
      };
    }

    const timeout = timeoutMs ?? 120_000;
    return await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      cwd: string;
      cwdNote?: string;
      truncated?: boolean;
      timedOut?: boolean;
    }>((resolve) => {
      exec(
        command,
        { cwd: normalized.cwd, timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          const out = truncate(stdout ?? "");
          const err = truncate(stderr ?? "");
          // error.code — числовой код выхода; для таймаута node ставит error.killed=true.
          const e = error as (Error & { code?: number; killed?: boolean }) | null;
          const exitCode = e?.code ?? (error ? 1 : 0);
          resolve({
            stdout: out.text,
            stderr: err.text,
            exitCode,
            cwd: normalized.cwd,
            cwdNote: normalized.note,
            truncated: out.truncated || err.truncated || undefined,
            timedOut: e?.killed || undefined,
          });
        },
      );
    });
  },
});
