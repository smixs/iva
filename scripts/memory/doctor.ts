// Memory doctor: mechanical vault maintenance (no LLM) + git commit&push.
// Runs nightly via systemd timer (deploy/iva-memory-doctor.{service,timer}).
//
//   node --env-file=.env scripts/memory/doctor.ts
//
// Runs the autograph scripts (graph.health / engine.decay / moc.generate /
// dedup / link_cleanup) on the vault via `uv run`, then commits and pushes the vault repo.
// Guards: no git-remote/credentials → alert admin on Telegram (gh auth login + git remote),
// push is skipped. Health score drop → alert on Telegram. Plain Node orchestration.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_CAP } from "../lib/core-cap.mjs";
import {
  classifyGitPushError,
  formatMegabytes,
  recordSkippedOversize,
  scanOversizeWorkingTreeFiles,
} from "../lib/memory-maintenance.mjs";
import { notificationChat } from "../lib/notification-chat.mjs";
import { clampCore } from "./core-clamp.mjs";

const VAULT = resolve(process.env.ASSISTANT_VAULT_DIR ?? "vault");
// The autograph code lives in THIS repo, not in the vault: the vault is user data only.
// Absolute paths, because every script is spawned with cwd = VAULT (they take "." as the vault).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPTS = resolve(ROOT, "scripts/autograph");
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = notificationChat(); // admin chat
const TZ = process.env.ASSISTANT_TIMEZONE ?? process.env.TZ ?? "UTC";

if (!existsSync(VAULT)) {
  console.error(`doctor: vault not found: ${VAULT}`);
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

// Run a command in the vault directory. Does not throw — returns status/output.
function run(cmd: string, args: string[], cwd = VAULT) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (out) console.log(`$ ${cmd} ${args.join(" ")}\n${out}`);
  return { status: r.status ?? (r.error ? 1 : 0), stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function telegram(text: string): Promise<void> {
  if (!BOT || !CHAT) {
    console.error("doctor: no TELEGRAM_BOT_TOKEN/TELEGRAM_DIGEST_CHAT_ID — alert not sent:", text);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text }),
  });
  if (!res.ok) console.error("doctor: Telegram sendMessage failed:", res.status, await res.text());
}

// Health score is read from the history that graph.py health appends after each run.
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
console.log(`=== doctor memory for ${today} (vault: ${VAULT}) ===`);

// ── 0. Schema location: vault root, with a one-time migration off the legacy path ──
// Up to 0.3.2 the per-vault schema sat in vault/.claude/skills/autograph/schema.json (a
// leftover of the Claude-skill layout). It is user config, so it now lives at the vault
// root; the legacy copy is left in place (never delete user data), just no longer read.
const VAULT_SCHEMA = resolve(VAULT, "schema.json");
const LEGACY_SCHEMA = resolve(VAULT, ".claude/skills/autograph/schema.json");
if (!existsSync(VAULT_SCHEMA) && existsSync(LEGACY_SCHEMA)) {
  copyFileSync(LEGACY_SCHEMA, VAULT_SCHEMA);
  console.log(`doctor: schema migrated to the vault root: ${VAULT_SCHEMA}`);
}
// Fall back to the shipped example so a vault that never had a schema still gets enforced.
const SCHEMA = existsSync(VAULT_SCHEMA)
  ? VAULT_SCHEMA
  : existsSync(LEGACY_SCHEMA)
    ? LEGACY_SCHEMA
    : resolve(SCRIPTS, "schema.example.json");

// ── 1. Mechanical maintenance (autograph, no LLM) ──
// Do NOT ignore failures: otherwise doctor would commit/push and exit 0 even though health/
// decay/moc did not run (no uv/Python, vault not initialized, etc.).
const failures: string[] = [];
function maint(label: string, args: string[]): void {
  const r = run("uv", ["run", ...args]);
  if (r.status !== 0) failures.push(label);
}
// cleanup — streaming repair of bug-bloated cards. MUST run before everything else:
// enforce/graph read files whole and get OOM-killed on gigabyte cards; cleanup streams
// with bounded memory and shrinks them back to sane sizes first.
maint("cleanup", [`${SCRIPTS}/cleanup.py`, ".", "--apply"]);
// enforce — strict-typing backstop: coerce type aliases, fix invalid status, backfill
// system fields. Runs FIRST (before graph) so the graph is built on canonical frontmatter.
// This is the deterministic guarantee that cards written outside write_card stay in-schema.
maint("enforce", [`${SCRIPTS}/enforce.py`, ".", SCHEMA, "--apply"]);
// graph.health rebuilds the graph and writes health-history.json (for drop detection).
maint("graph.health", [`${SCRIPTS}/graph.py`, "health", "."]);
// engine.decay updates card relevance/tiers.
maint("engine.decay", [`${SCRIPTS}/engine.py`, "decay", "."]);
// moc.generate rebuilds the MOC indexes.
maint("moc.generate", [`${SCRIPTS}/moc.py`, "generate", "."]);
// supersede — deterministic contradiction scan (dry-run): reports same-entity cards with
// conflicting fields to .graph/supersede-candidates.json; the nightly LLM rollup resolves them.
maint("supersede", [`${SCRIPTS}/supersede.py`, "."]);
// dedup and link_cleanup — dry-run only (autograph policy: never apply automatically).
maint("dedup", [`${SCRIPTS}/dedup.py`, ".", "--dry-run"]);
maint("link_cleanup", [`${SCRIPTS}/link_cleanup.py`, "."]);

// Плагин: пересобрать сайдкар эмбеддингов для hybrid-поиска (только если включён). Запускаем
// из корня проекта (cwd), а не из VAULT — скрипт лежит в scripts/, ключ читается из .env.
if (process.env.MEMORY_SEARCH_MODE === "hybrid") {
  // Use process.execPath, not bare "node": the systemd unit's PATH does not include the
  // nvm node dir, so spawning "node" by name fails with ENOENT and falsely reports a failure.
  const r = run(process.execPath, ["--env-file=.env", "scripts/memory/embed-index.ts"], process.cwd());
  if (r.status !== 0) failures.push("embed-index");
}

if (failures.length) {
  await telegram(
    `doctor: vault maintenance partially failed (${failures.join(", ")}) for ${today}. ` +
      `Check that the server has uv/Python and the vault is initialized (schema.json + cards).`,
  );
}

// ── 1b. CORE guard: the memory core must stay small (always-on floor stays flat) ──
// This runs before git add/commit below, so a repaired CORE is included in the nightly backup.
const corePath = resolve(VAULT, "CORE.md");
if (existsSync(corePath)) {
  const oldCore = readFileSync(corePath, "utf8");
  if (oldCore.length > CORE_CAP) {
    const newCore = clampCore(oldCore);
    const tmp = `${corePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      writeFileSync(tmp, newCore, "utf8");
      renameSync(tmp, corePath);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* preserve the original write/rename failure */
      }
      throw error;
    }
    console.warn(`doctor: CORE.md clamped ${oldCore.length} → ${newCore.length} chars (cap ${CORE_CAP})`);
    const protectedOverflow =
      newCore.length > CORE_CAP
        ? " Protected headings, pointers or unknown sections still exceed the cap."
        : "";
    await telegram(
      `CORE.md exceeded its ${CORE_CAP}-char cap (${today}); doctor clamped it ` +
        `${oldCore.length} → ${newCore.length} chars. Pointers were preserved.${protectedOverflow}`,
    );
  }
}

// ── 2. Detect health score drop ──
const history = readHealthHistory();
if (history.length >= 2) {
  const cur = history[history.length - 1]?.health_score;
  const prev = history[history.length - 2]?.health_score;
  if (typeof cur === "number" && typeof prev === "number" && cur < prev) {
    await telegram(`Vault health dropped: ${prev} → ${cur}/100 (${today}). Check vault/.graph/report.md.`);
  }
}

// ── 3. Git commit & push ──
// Check the complete working-tree snapshot before staging anything. If even one file is
// unsafe, skip the whole commit: a partial commit would make the nightly backup look complete
// while silently omitting vault data.
let oversized: Array<{ path: string; size: number }>;
try {
  oversized = scanOversizeWorkingTreeFiles({
    vaultPath: VAULT,
    runGit: (args: string[]) => run("git", args),
  });
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const message =
    `vault: не удалось проверить размеры файлов перед git add (${detail}); ` +
    "ночной коммит отложен, чтобы не повредить историю.";
  console.warn(`doctor: ${message}`);
  await telegram(message);
  process.exit(1);
}

if (oversized.length) {
  recordSkippedOversize(resolve(VAULT, ".graph/enforce-report.json"), oversized.length);
  const lines = oversized.map(
    ({ path, size }) =>
      `файл ${path} (${formatMegabytes(size)}) превышает лимит GitHub; ` +
      "ночной cleanup должен его ужать, коммит отложен",
  );
  for (const line of lines) console.warn(`doctor: ${line}`);
  await telegram(`vault:\n${lines.join("\n")}`);
  process.exit(1);
}

// Auto-provision a private backup remote via the already-authorized gh CLI instead of
// nagging nightly: only alert when gh itself can't help (not installed / not logged in).
function ensureRemote(): string {
  const existing = run("git", ["remote", "get-url", "origin"]);
  if (existing.status === 0 && existing.stdout.trim()) return existing.stdout.trim();

  if (run("gh", ["auth", "status"]).status !== 0) return ""; // gh missing or not authed
  run("gh", ["auth", "setup-git"]); // make https push use gh credentials

  // Create the private repo and wire origin in one shot.
  const create = run("gh", ["repo", "create", "iva-vault", "--private", "--source", VAULT, "--remote", "origin", "--push"]);
  if (create.status === 0) {
    console.log("doctor: created private backup repo iva-vault and attached origin");
    return run("git", ["remote", "get-url", "origin"]).stdout.trim();
  }

  // Repo probably already exists — just point origin at <user>/iva-vault.
  const login = run("gh", ["api", "user", "--jq", ".login"]).stdout.trim();
  if (!login) return "";
  const url = `https://github.com/${login}/iva-vault.git`;
  run("git", ["remote", "add", "origin", url]);
  return run("git", ["remote", "get-url", "origin"]).stdout.trim();
}

const remoteUrl = ensureRemote();
if (!remoteUrl) {
  await telegram(
    "vault has no git remote and gh is not authenticated — memory is not being backed up. " +
      "On the server run `gh auth login` (with repo scope); the nightly doctor will then create " +
      "a private iva-vault repo and back up automatically.",
  );
  console.error("doctor: no remote and gh unavailable — push skipped");
  process.exit(failures.length ? 1 : 0);
}

run("git", ["add", "-A"]);
// commit may return non-zero if there is nothing to commit — that is normal.
run("git", ["commit", "-m", `chore: memory ${today}`]);
const push = run("git", ["push"]);
if (push.status !== 0) {
  const error = classifyGitPushError(push.stderr);
  const message =
    error.kind === "oversize"
      ? "vault: git push отклонён: история уже содержит слишком большой blob. " +
        "Нужна ручная очистка: `git checkout --orphan vault-clean` — сверни историю vault " +
        "в один чистый коммит и запушь с `--force`."
      : error.kind === "auth"
        ? "vault: git push failed (no credentials?). On the server run `gh auth login` " +
          `and verify remote access (cd ${VAULT} && git push).`
        : `vault: git push failed: ${error.firstLine}`;
  console.warn(`doctor: ${message}`);
  await telegram(message);
  process.exit(1);
}

console.log("=== doctor: done, vault committed and pushed ===");
process.exit(failures.length ? 1 : 0);
