import { defineTool } from "eve/tools";
import { z } from "zod";
import { exec } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Host-native bash. Переопределяет встроенный sandbox-bash eve: команда выполняется
// напрямую на реальной файловой системе VPS через node:child_process (без sandbox).
// Самодостаточно: импортирует только eve/tools, zod и node-builtins.

const MAX_OUTPUT = 30_000; // оставляем последние ~30k символов каждого потока

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_OUTPUT) return { text: s, truncated: false };
  return { text: s.slice(s.length - MAX_OUTPUT), truncated: true };
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
    "Используй для запуска любых команд: git, ls, uv, systemctl --user и т.д.",
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
      .positive()
      .optional()
      .describe("Таймаут в миллисекундах (по умолчанию 120000)"),
  }),
  async execute({ command, cwd, timeoutMs }) {
    const timeout = timeoutMs ?? 120_000;
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
      exec(
        command,
        { cwd: runCwd, timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
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
            cwd: runCwd, // фактическая директория запуска — модель видит, где реально выполнилось
            truncated: out.truncated || err.truncated || undefined,
            timedOut: e?.killed || undefined,
          });
        },
      );
    });
  },
});
