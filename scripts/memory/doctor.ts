// Доктор памяти: механическое обслуживание vault (без LLM) + git commit&push.
// Запускается systemd-таймером (deploy/iva-memory-doctor.{service,timer}) ночью.
//
//   node --env-file=.env scripts/memory/doctor.ts
//
// Прогоняет вендоренные autograph-скрипты (graph.health / engine.decay / moc.generate /
// dedup / link_cleanup) на vault через `uv run`, затем коммитит и пушит репо vault.
// Гарды: нет git-remote/credentials → алерт админу в Telegram (gh auth login + git remote),
// push пропускается. Падение health score → алерт в Telegram. Чистая Node-оркестрация.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const VAULT = resolve(process.env.ASSISTANT_VAULT_DIR ?? "vault");
const SCRIPTS = ".claude/skills/autograph/scripts"; // относительно vault
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_DIGEST_CHAT_ID; // админ-чат
const TZ = process.env.ASSISTANT_TIMEZONE ?? process.env.TZ ?? "UTC";

if (!existsSync(VAULT)) {
  console.error(`doctor: vault не найден: ${VAULT}`);
  process.exit(1);
}

function localDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Запуск команды в каталоге vault. Не бросает — возвращает статус/вывод.
function run(cmd: string, args: string[], cwd = VAULT) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (out) console.log(`$ ${cmd} ${args.join(" ")}\n${out}`);
  return { status: r.status ?? (r.error ? 1 : 0), stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function telegram(text: string): Promise<void> {
  if (!BOT || !CHAT) {
    console.error("doctor: нет TELEGRAM_BOT_TOKEN/TELEGRAM_DIGEST_CHAT_ID — алерт не отправлен:", text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text }),
  });
  if (!res.ok) console.error("doctor: Telegram sendMessage failed:", res.status, await res.text());
}

// Health score берём из истории, которую graph.py health append-ит после прогона.
function readHealthHistory(): Array<{ date?: string; health_score?: number }> {
  const p = resolve(VAULT, ".graph/health-history.json");
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const today = localDate();
console.log(`=== doctor память для ${today} (vault: ${VAULT}) ===`);

// ── 1. Механическое обслуживание (autograph, без LLM) ──
// Падения НЕ игнорируем: иначе doctor закоммитит/запушит и выйдет 0, хотя health/
// decay/moc не отработали (нет uv/Python, vault не инициализирован и т.п.).
const failures: string[] = [];
function maint(label: string, args: string[]): void {
  const r = run("uv", ["run", ...args]);
  if (r.status !== 0) failures.push(label);
}
// graph.health перестраивает граф и пишет health-history.json (для детекта дропа).
maint("graph.health", [`${SCRIPTS}/graph.py`, "health", "."]);
// engine.decay обновляет relevance/tiers карточек.
maint("engine.decay", [`${SCRIPTS}/engine.py`, "decay", "."]);
// moc.generate перестраивает MOC-индексы.
maint("moc.generate", [`${SCRIPTS}/moc.py`, "generate", "."]);
// dedup и link_cleanup — только dry-run (политика autograph: апплай не делаем автоматически).
maint("dedup", [`${SCRIPTS}/dedup.py`, ".", "--dry-run"]);
maint("link_cleanup", [`${SCRIPTS}/link_cleanup.py`, "."]);

if (failures.length) {
  await telegram(
    `doctor: обслуживание vault частично упало (${failures.join(", ")}) за ${today}. ` +
      `Проверь, что на сервере есть uv/Python и vault инициализирован (schema.json + карточки).`,
  );
}

// ── 2. Детект падения health score ──
const history = readHealthHistory();
if (history.length >= 2) {
  const cur = history[history.length - 1]?.health_score;
  const prev = history[history.length - 2]?.health_score;
  if (typeof cur === "number" && typeof prev === "number" && cur < prev) {
    await telegram(`Health vault упал: ${prev} → ${cur}/100 (${today}). Проверь vault/.graph/report.md.`);
  }
}

// ── 3. Git commit & push (гард на remote/credentials) ──
const remote = run("git", ["remote", "get-url", "origin"]);
if (remote.status !== 0 || !remote.stdout.trim()) {
  await telegram(
    "vault не подключён к git-remote — память не бэкапится. На сервере выполни:\n" +
      "  gh auth login\n" +
      `  cd ${VAULT} && git remote add origin <repo-url> && git push -u origin HEAD`,
  );
  console.error("doctor: git remote не настроен — push пропущен");
  process.exit(failures.length ? 1 : 0);
}

run("git", ["add", "-A"]);
// commit может вернуть non-zero, если нечего коммитить — это норма.
run("git", ["commit", "-m", `chore: memory ${today}`]);
const push = run("git", ["push"]);
if (push.status !== 0) {
  await telegram(
    "vault: git push не прошёл (нет credentials?). На сервере выполни `gh auth login` " +
      `и проверь доступ к remote (cd ${VAULT} && git push).`,
  );
  console.error("doctor: git push не прошёл");
  process.exit(1);
}

console.log("=== doctor: готово, vault закоммичен и запушен ===");
process.exit(failures.length ? 1 : 0);
