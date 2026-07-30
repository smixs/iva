#!/usr/bin/env node
// Iva CLI — manage the self-host installation: update / config / doctor / uninstall + wrappers.
// Self-contained, no external dependencies. Node 24+ (global fetch, spawnSync).
//
// SINGLE source of truth for systemd units and activation: install.sh delegates here
// (`iva _install-units` + `_activate-units`), and CLI/doctor reuse the same paths.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, chmodSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { modelSummary } from "../scripts/lib/model-summary.mjs";
import { createTerminalProgress } from "../scripts/lib/progress.mjs";
import { quarantinePath, resetStateTargets } from "../scripts/lib/wf-store.mjs";
import { createTelegramUpdateReporter, loadTelegramJob, removeTelegramJob } from "../scripts/lib/telegram-status.mjs";
import { generateAssistantBearer, isAssistantBearer } from "../scripts/lib/assistant-auth.mjs";
import { parseEnvText, writeEnvAtomicSync } from "../scripts/lib/env-file.mjs";
import { classifyAgentListeners } from "../scripts/lib/listener-security.mjs";
import { readMemoryMaintenanceReport } from "../scripts/lib/memory-maintenance.mjs";
import { cleanupSystemdUnits, createSystemdControl } from "../scripts/lib/systemd-control.mjs";
import {
  applyConfigTransaction,
  probeEveHealth,
  recoverConfigTransaction,
} from "../scripts/lib/config-transaction.mjs";
import { userbotSyncArgs } from "../scripts/lib/userbot-deps.mjs";
import { probeUserbotHealth } from "../scripts/lib/userbot-health.mjs";
import {
  acquireUpdateLock,
  commitThenRunPostCommit,
  createUpdateLog,
  createUpdateTransaction,
  releaseUpdateLock,
} from "../scripts/lib/update-safety.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const UNIT_DIR = join(homedir(), ".config/systemd/user");
const NODE = process.execPath;
const NODE_BIN_DIR = dirname(NODE);
const NPM = existsSync(join(NODE_BIN_DIR, "npm")) ? join(NODE_BIN_DIR, "npm") : "npm";
// Children inherit PATH with the node directory — otherwise npm/eve won't be found when called via wrapper.
const childEnv = { ...process.env, PATH: `${NODE_BIN_DIR}:${process.env.PATH || ""}` };

const SERVICES = ["iva.service", "iva-telegram-poll.service"];
const MEMORY_PERIODS = ["daily", "weekly", "monthly", "yearly", "doctor"];
const MEMORY_SERVICES = MEMORY_PERIODS.map((n) => `iva-memory-${n}.service`);
const MEMORY_TIMERS = MEMORY_PERIODS.map((n) => `iva-memory-${n}.timer`);
const UPDATE_TIMER = "iva-update-check.timer";
const TIMERS = [...MEMORY_TIMERS, UPDATE_TIMER];

// Telegram userbot proxy — OPT-IN (not in SERVICES, so `iva update` never tries to start
// it without API creds). Enabled explicitly via `iva userbot setup`.
const SVC_USERBOT = "iva-telegram-userbot.service";
const USERBOT_DIR = join(ROOT, "services/telegram-userbot");
const VENV_PY = join(USERBOT_DIR, ".venv/bin/python");
// Proxy bearer secret. A FILE (not .env) read at runtime by both the proxy and iva's
// connection, so iva needn't restart after the agent sets the proxy up mid-chat.
const TOKEN_FILE = join(ROOT, "data/telegram-userbot.token");

// Uncommon default port: 3000/8000/8080 are typically taken on a VPS (docker, etc.).
// Overridden by the IVA_PORT variable in .env; the default ASSISTANT_HOST depends on it too.
const DEFAULT_PORT = "8723";
// Former (hardcoded) default before the switch to IVA_PORT — needed to migrate old .env files.
const OLD_DEFAULT_HOST = "http://127.0.0.1:3000";

const C = process.env.NO_COLOR || process.env.TERM === "dumb"
  ? { g: "", y: "", r: "", c: "", b: "", d: "", x: "" }
  : { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", c: "\x1b[36m", b: "\x1b[1m", d: "\x1b[2m", x: "\x1b[0m" };
const ok = (m) => console.log(`${C.g}✓${C.x} ${m}`);
const warn = (m) => console.log(`${C.y}!${C.x} ${m}`);
const bad = (m) => console.log(`${C.r}✗${C.x} ${m}`);
const step = (m) => console.log(`${C.b}${C.c}▸ ${m}${C.x}`);

// ── small helpers ────────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: childEnv, ...opts });
}
function cap(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", env: childEnv, ...opts });
  return { code: r.status ?? 1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const hasSystemd = () => !!cap("sh", ["-c", "command -v systemctl"]).out;
const scQ = (...args) => cap("systemctl", ["--user", ...args]);
const systemd = createSystemdControl({ run: (args) => scQ(...args) });
const gitHead = () => cap("git", ["rev-parse", "--short", "HEAD"]).out;

function readEnv() {
  const env = {};
  if (!existsSync(ENV_PATH)) return env;
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

// Абсолютный путь к каталогу data (тот же, что видит агент из cwd=ROOT). Абсолютный
// ASSISTANT_DATA_DIR берём как есть, относительный — от ROOT (как vault-путь ниже).
function dataDirAbs(env = readEnv()) {
  const d = env.ASSISTANT_DATA_DIR || "data";
  return d.startsWith("/") ? d : join(ROOT, d);
}

async function confirm(question, def = false) {
  if (!process.stdin.isTTY) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  rl.close();
  return a ? a.startsWith("y") : def;
}

function requireSystemd() {
  if (!hasSystemd()) {
    bad("systemd unavailable — this command only works on a Linux server");
    process.exit(1);
  }
}

// Existing installs gain the server-side bearer on their next unit refresh/update.
// The same migration also repairs .env permissions because it contains every runtime secret.
function ensureAssistantBearer({ quiet = false } = {}) {
  if (!existsSync(ENV_PATH)) return false;
  let changed = false;
  const bearer = (readEnv().ASSISTANT_BEARER || "").trim();
  const bearerLines = readFileSync(ENV_PATH, "utf8").match(/^\s*ASSISTANT_BEARER\s*=/gm)?.length || 0;
  if (!isAssistantBearer(bearer)) {
    writeEnvVars({ ASSISTANT_BEARER: generateAssistantBearer() });
    changed = true;
  } else if (bearerLines !== 1) {
    writeEnvVars({ ASSISTANT_BEARER: bearer });
    changed = true;
  }
  if ((statSync(ENV_PATH).mode & 0o777) !== 0o600) {
    chmodSync(ENV_PATH, 0o600);
    changed = true;
  }
  if (changed && !quiet) ok(".env protected and internal bearer configured");
  return changed;
}

// ── systemd units: single source of truth ─────────────────────────────────
function ivaServiceBody() {
  // PATH with the node directory (= npm global bin under nvm), Restart=always.
  const port = (readEnv().IVA_PORT || DEFAULT_PORT).trim();
  return [
    "[Unit]",
    "Description=Iva",
    "After=network-online.target",
    "",
    "[Service]",
    // Everything eve creates (vault, transcripts, data/) must not be world-readable:
    // the system umask (022 on Ubuntu) would expose it to every user on the box.
    "UMask=0077",
    `WorkingDirectory=${ROOT}`,
    `EnvironmentFile=${ROOT}/.env`,
    // Стартуем через `eve start`, а НЕ напрямую `node .output/server/index.mjs`: eve start
    // вызывает prewarmBuiltAppSandboxes() и собирает шаблон песочницы ДО приёма трафика. Сырой
    // index.mjs prewarm не делает → первое же вложение падает SandboxTemplateNotProvisionedError
    // (шаблона нет в .eve/sandbox-cache). Ключ шаблона — контент-хеш, после iva update он меняется,
    // поэтому provision обязан идти на каждом старте, а не разово. eve start остаётся foreground.
    // --host: bind to loopback only. eve's auth strategy localDev() treats a request as local
    // by the hostname of request.url — i.e. by the client's own Host header — so a server bound
    // to 0.0.0.0 hands local-dev rights (and with them a sandbox-free `bash` on the host) to
    // anyone who can reach the port and sends `Host: 127.0.0.1`. The port is only ever consumed
    // locally: telegram-poll, the sweep and the memory scripts all talk to 127.0.0.1.
    // Env is not enough here — `eve start` takes options.host ?? "0.0.0.0" and overwrites
    // HOST/NITRO_HOST for the spawned .output/server/index.mjs, so the flag is what binds.
    `ExecStart=${NODE} ${ROOT}/node_modules/eve/bin/eve.js start --host 127.0.0.1`,
    `Environment=PORT=${port}`,
    `Environment=PATH=${NODE_BIN_DIR}:%h/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    "Environment=AGENT_BROWSER_MAX_OUTPUT=24000",
    "Restart=always",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

// One-time (idempotent) perms migration for installs created before UMask=0077: the
// secrets file and the data dir were world-readable under the default umask 022.
// Runs from writeUnits — i.e. on every install/update — so old installs self-heal.
function hardenPerms() {
  // Каждая цель — независимо: сбой на .env не должен отменять миграцию data/ (и наоборот).
  // Предупреждаем, но установку юнитов не срываем: юниты сами несут UMask=0077, а сорванный
  // writeUnits оставил бы систему вовсе без юнитов — хуже, чем старые права.
  try {
    if (existsSync(ENV_PATH)) chmodSync(ENV_PATH, 0o600);
  } catch (e) {
    warn(`perms migration (.env) failed: ${e.message}`);
  }
  try {
    const data = dataDirAbs();
    if (existsSync(data)) chmodSync(data, 0o700);
  } catch (e) {
    warn(`perms migration (data/) failed: ${e.message}`);
  }
  // Стор воркфлоу несёт транскрипты диалогов, vault — саму память; оба старше UMask-фикса
  // могли быть созданы world-readable. chmod только верхнего уровня (закрывает traversal).
  const vaultRel = readEnv().ASSISTANT_VAULT_DIR || "vault";
  const vaultDir = vaultRel.startsWith("/") ? vaultRel : join(ROOT, vaultRel);
  for (const p of [join(ROOT, ".eve"), join(ROOT, ".workflow-data"), vaultDir]) {
    try {
      if (existsSync(p)) chmodSync(p, 0o700);
    } catch (e) {
      warn(`perms migration (${relative(ROOT, p)}) failed: ${e.message}`);
    }
  }
}

// Writes iva.service + all deploy/iva-*.{service,timer} with placeholder substitution. daemon-reload.
function writeUnits({ ensureBearer = true } = {}) {
  hardenPerms();
  if (ensureBearer) ensureAssistantBearer({ quiet: true });
  mkdirSync(UNIT_DIR, { recursive: true });
  writeFileSync(join(UNIT_DIR, "iva.service"), ivaServiceBody());
  const written = ["iva.service"];
  const deploy = join(ROOT, "deploy");
  const configuredTimezone = (readEnv().ASSISTANT_TIMEZONE || "UTC").trim();
  const timezone = /^[A-Za-z0-9_+\/-]+$/.test(configuredTimezone) ? configuredTimezone : "UTC";
  for (const f of readdirSync(deploy)) {
    if (!/^iva-.*\.(service|timer)$/.test(f)) continue;
    const tpl = readFileSync(join(deploy, f), "utf8")
      .replaceAll("__PROJECT_DIR__", ROOT)
      .replaceAll("__NODE_BIN__", NODE)
      .replaceAll("__PYTHON_BIN__", VENV_PY)
      .replaceAll("__TIMEZONE__", timezone);
    writeFileSync(join(UNIT_DIR, f), tpl);
    written.push(f);
  }
  if (hasSystemd()) systemd.daemonReload();
  return written;
}

function activateUnits() {
  systemd.activate([...SERVICES, ...TIMERS]);
}

function removeUnits() {
  if (!existsSync(UNIT_DIR)) return [];
  const units = readdirSync(UNIT_DIR).filter((f) => /^iva.*\.(service|timer)$/.test(f));
  return cleanupSystemdUnits({
    units,
    disable: (unit) => systemd.disableNow([unit]),
    remove: (unit) => rmSync(join(UNIT_DIR, unit)),
    reload: () => systemd.daemonReload(),
    reset: () => systemd.resetFailed(),
  });
}

// Migrate old installs to IVA_PORT. Idempotent: on the first `iva update`
// after switching to the new scheme it guarantees the variable and keeps the server
// (Environment=PORT=$IVA_PORT) from drifting away from clients (whose default is ASSISTANT_HOST).
function migrateEnv({ quiet = false } = {}) {
  if (!existsSync(ENV_PATH)) return false;
  const env = readEnv();
  if (env.IVA_PORT) return false; // already on the new scheme — leave it alone
  const host = env.ASSISTANT_HOST || "";
  const local = host.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/i);
  const isOldDefault = host === OLD_DEFAULT_HOST;
  // old default :3000 → new default 8723; custom local host → its port; otherwise the default
  const port = isOldDefault ? DEFAULT_PORT : local ? local[1] : DEFAULT_PORT;
  let raw = readFileSync(ENV_PATH, "utf8").replace(/\n*$/, "\n") + `IVA_PORT=${port}\n`;
  // don't leave a stale :3000 in ASSISTANT_HOST — otherwise clients get stuck on the taken port
  if (isOldDefault) raw = raw.replace(/^(\s*ASSISTANT_HOST\s*=).*$/m, `$1http://127.0.0.1:${port}`);
  writeEnvAtomicSync(ENV_PATH, raw);
  if (!quiet) ok(`.env migrated → IVA_PORT=${port}${isOldDefault ? ", ASSISTANT_HOST moved off :3000" : ""}`);
  return true;
}

// Any restart via `iva` first regenerates the unit → Environment=PORT always equals
// the current IVA_PORT from .env. Without this, editing IVA_PORT + restart would leave the server
// on the old port (the unit was already baked) while clients read the new one — the same desync.
function restartServices() {
  writeUnits();
  systemd.restart(SERVICES);
}

// ANSI tree like during install. The only source of the art is install.sh (heredoc
// IVA_TREE); we read it from there so as not to spawn a copy. In a real terminal we add
// a little "life": the crown sways in the wind, colors shimmer, glyphs breathe slightly.
// Non-TTY / narrow window / IVA_NO_ANIM / any failure — a static frame (or nothing).
const TREE_RAMP = " .:;!icoa*xw#%$&@"; // the same set as the art generator

// Parse the heredoc into a grid of cells: {ch,r,g,b} for a colored glyph, {ch:" ",bg} for background.
function loadTreeGrid() {
  const sh = readFileSync(join(ROOT, "install.sh"), "utf8");
  const body = sh.split("<<'IVA_TREE'\n")[1]?.split("\nIVA_TREE")[0];
  if (!body) return null;
  const re = /\x1b\[38;2;(\d+);(\d+);(\d+)m([\s\S])|\x1b\[0m|([\s\S])/g;
  return body.replace(/\\033/g, "\x1b").split("\n").map((line) => {
    const cells = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      if (m[4] !== undefined) cells.push({ ch: m[4], r: +m[1], g: +m[2], b: +m[3] });
      else if (m[5] !== undefined) cells.push({ ch: m[5], bg: true });
    }
    return cells;
  });
}

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// One frame. live=false → reference (no sway/shimmer) for the final resting state.
function renderTreeFrame(grid, t, live) {
  const rows = grid.length;
  let out = "";
  for (let y = 0; y < rows; y++) {
    const cells = grid[y];
    let lead = 0;
    while (lead < cells.length && cells[lead].bg) lead++;
    let last = cells.length - 1;
    while (last >= 0 && cells[last].bg) last--;
    // the tree stays still — only the glyphs and their colors come alive
    let line = " ".repeat(lead);
    for (let x = lead; x <= last; x++) {
      const c = cells[x];
      if (c.bg) { line += " "; continue; }
      let { r, g, b, ch } = c;
      if (live) {
        const shim = 1 + 0.16 * Math.sin(t * 0.6 + x * 0.45 + y * 0.3); // brightness shimmer
        r = clampByte(Math.round(r * shim));
        g = clampByte(Math.round(g * shim));
        b = clampByte(Math.round(b * shim));
        const idx = TREE_RAMP.indexOf(ch); // glyph breathes ±1 along the ramp (not into background)
        if (idx > 0) ch = TREE_RAMP[clamp(idx + Math.round(0.9 * Math.sin(t * 0.5 + x * 0.7 + y * 1.1)), 1, TREE_RAMP.length - 1)];
      }
      line += `\x1b[38;2;${r};${g};${b}m${ch}`;
    }
    out += line + "\x1b[0m\x1b[K\n";
  }
  return out;
}

async function showTree() {
  if (!process.stdout.isTTY || process.env.NO_COLOR || process.env.TERM === "dumb") return;
  let cursorHidden = false;
  const restoreCursor = () => {
    if (cursorHidden) process.stdout.write("\x1b[?25h");
    cursorHidden = false;
  };
  const signals = ["SIGINT", "SIGTERM"];
  const handlers = Object.fromEntries(signals.map((signal) => [signal, () => {
    restoreCursor();
    for (const name of signals) process.removeListener(name, handlers[name]);
    process.kill(process.pid, signal);
  }]));
  try {
    const grid = loadTreeGrid();
    if (!grid) return;
    const rows = grid.length;
    const width = Math.max(...grid.map((r) => r.length)) + 3;
    process.stdout.write("\n");
    // a narrow window breaks cursor-based redraw — show it statically
    if ((process.stdout.columns || 80) < width || process.env.IVA_NO_ANIM) {
      process.stdout.write(renderTreeFrame(grid, 0, false) + "\n");
      return;
    }
    process.stdout.write("\x1b[?25l"); // hide the cursor
    cursorHidden = true;
    for (const signal of signals) process.once(signal, handlers[signal]);
    const FRAMES = 36, DELAY = 70;
    for (let f = 0; f < FRAMES; f++) {
      if (f > 0) process.stdout.write(`\x1b[${rows}A`);
      process.stdout.write(renderTreeFrame(grid, f * 0.7, true));
      await new Promise((r) => setTimeout(r, DELAY));
    }
    process.stdout.write(`\x1b[${rows}A` + renderTreeFrame(grid, 0, false));
    restoreCursor();
    process.stdout.write("\n");
  } catch {
    restoreCursor();
  } finally {
    for (const signal of signals) process.removeListener(signal, handlers[signal]);
  }
}

// ── commands ───────────────────────────────────────────────────────────────
async function cmdUpdate(args) {
  const force = args.includes("--force");
  const verbose = args.includes("--verbose");
  const telegramJobAt = args.indexOf("--telegram-job");
  const telegramJobId = telegramJobAt >= 0 ? args[telegramJobAt + 1] || "" : "";
  const locale = (readEnv().AGENT_LANGUAGE || process.env.AGENT_LANGUAGE) === "ru" ? "ru" : "en";
  const text = locale === "ru"
    ? {
        protect: ["Сохраняю ваши изменения", "Изменения сохранены", "Не удалось сохранить изменения"],
        fetch: ["Получаю обновление", "Обновление получено", "Не удалось получить обновление"],
        build: ["Собираю Iva", "Iva собрана", "Не удалось собрать Iva"],
        timerFailure: "Iva готова, но таймер автоматических обновлений не удалось активировать",
        current: "Iva уже обновлена",
      }
    : {
        protect: ["Saving your changes", "Changes saved", "Couldn't save your changes"],
        fetch: ["Getting the update", "Update received", "Couldn't get the update"],
        build: ["Building Iva", "Iva built", "Couldn't build Iva"],
        timerFailure: "Iva is ready, but the automatic update timer could not be activated",
        current: "Iva is already up to date",
      };

  await showTree();
  const env = readEnv();
  const dataDir = dataDirAbs(env);
  const loadedJob = await loadTelegramJob(dataDir, telegramJobId);
  const reporter = loadedJob
    ? createTelegramUpdateReporter({ token: env.TELEGRAM_BOT_TOKEN, job: loadedJob.job, env })
    : null;
  const terminal = createTerminalProgress({ verbose });
  const owner = telegramJobId || `cli-${process.pid}-${Date.now()}`;
  const lock = acquireUpdateLock(dataDir, owner);
  if (!lock.ok) {
    terminal.fail(locale === "ru" ? "Обновление уже идёт" : "An update is already running");
    reporter?.dispose();
    await removeTelegramJob(loadedJob?.path);
    process.exitCode = 1;
    return;
  }

  const logFile = createUpdateLog(dataDir);
  const tx = createUpdateTransaction({ root: ROOT, dataDir, envPath: ENV_PATH, verbose, logFile, env: childEnv });
  let phase = "protect";
  let userbotUpdateAttempted = false;
  let userbotRollbackSnapshot = null;
  let versions = { beforeVersion: "the previous version", afterVersion: "the new version" };
  const phaseStart = async (name) => {
    phase = name;
    terminal.start(text[name][0]);
    await reporter?.start(name);
  };
  const phaseDone = async (name) => {
    terminal.done(text[name][1]);
    await reporter?.done(name);
  };
  const ensureUpdateTimer = async () => {
    if (!hasSystemd()) return;
    writeUnits();
    systemd.activate([UPDATE_TIMER]);
  };
  const finalizeUpdate = async () => {
    const finalized = await commitThenRunPostCommit({
      commit: () => tx.commit(),
      postCommit: ensureUpdateTimer,
    });
    if (finalized.ok) return true;

    const detail = finalized.error?.message || String(finalized.error);
    terminal.fail(text.timerFailure);
    terminal.info(detail);
    await reporter?.postCommitFailure(detail);
    process.exitCode = 1;
    return false;
  };

  try {
    await phaseStart("protect");
    await tx.protect();
    await phaseDone("protect");

    await phaseStart("fetch");
    const update = await tx.fetchAndIntegrate();
    await tx.restoreLocalChanges();
    versions = await tx.versions();
    await phaseDone("fetch");

    if (!update.changed && !force) {
      if (!(await finalizeUpdate())) return;
      terminal.info(`✅ ${text.current} (${versions.afterVersion})`);
      await reporter?.complete({ ...versions, changedLocal: tx.hadLocalChanges });
      return;
    }

    await phaseStart("build");
    if (update.changed) {
      const diff = await tx.git("diff", "--name-only", `${versions.beforeHead}..${versions.afterHead}`);
      const files = diff.stdout.split("\n");
      if (files.includes("package.json") || files.includes("package-lock.json")) {
        const install = await tx.run(NPM, [existsSync(join(ROOT, "package-lock.json")) ? "ci" : "install"]);
        if (install.code !== 0) throw new Error("dependency installation failed");
      }
    }
    migrateEnv({ quiet: true });
    // The streaming cleaner repairs cards the old frontmatter writer bloated to GBs (those
    // OOM-kill the agent and the nightly doctor, so waiting for the doctor is not an option).
    // The script comes from the freshly updated repo, so it is always the current version —
    // best-effort: it never fails an update.
    try {
      const vaultRel = readEnv().ASSISTANT_VAULT_DIR || "vault";
      const vaultDir = vaultRel.startsWith("/") ? vaultRel : join(ROOT, vaultRel);
      const cleanupScript = join(ROOT, "scripts/autograph/cleanup.py");
      const cleaned = spawnSync("uv", ["run", cleanupScript, ".", "--apply"], { cwd: vaultDir, encoding: "utf8", env: childEnv });
      if (cleaned.status === 0 && !cleaned.stdout.includes(" 0 file(s)"))
        terminal.info(`🧹 ${cleaned.stdout.trim().split("\n").pop()}`);
    } catch {}
    tx.backupOutput();
    const build = await tx.run(NPM, ["run", "build"]);
    if (build.code !== 0) throw new Error("build failed");

    // Best-effort helper for an integration that has no active local service.
    await tx.run(NPM, ["i", "-g", "@googleworkspace/cli@latest"]);

    if (hasSystemd()) {
      writeUnits();
      systemd.restart(SERVICES);
      let healthy = false;
      const port = (readEnv().IVA_PORT || DEFAULT_PORT).trim();
      for (let attempt = 0; attempt < 30; attempt++) {
        const active = SERVICES.every((service) => systemd.isActive(service));
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
          if (active && response.ok) { healthy = true; break; }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!healthy) throw new Error("health check failed");
      if (systemd.isActive(SVC_USERBOT)) {
        const frozen = cap("uv", ["pip", "freeze", "--python", VENV_PY], { cwd: USERBOT_DIR });
        if (frozen.code !== 0 || !frozen.out)
          throw new Error("userbot: не удалось сохранить dependency snapshot перед обновлением");
        userbotRollbackSnapshot = join(tmpdir(), `iva-userbot-before-update-${process.pid}-${Date.now()}.txt`);
        writeFileSync(userbotRollbackSnapshot, `${frozen.out}\n`, { mode: 0o600 });
        userbotUpdateAttempted = true;
        restartUserbotIfActive({ quiet: true, knownActive: true });
      }
    }

    await phaseDone("build");
    if (!(await finalizeUpdate())) return;
    const model = modelSummary(readEnv());
    terminal.info(`✅ Iva ${locale === "ru" ? "обновлена" : "updated"}`);
    terminal.info(`${versions.beforeVersion} → ${versions.afterVersion} · ${model.provider}/${model.model}`);
    await reporter?.complete({ ...versions, changedLocal: tx.hadLocalChanges });
  } catch (error) {
    terminal.fail(text[phase][2]);
    let rollbackOk = true;
    let codeRollbackOk = true;
    try {
      await tx.rollback();
    } catch {
      rollbackOk = false;
      codeRollbackOk = false;
    }
    if (phase === "build" && hasSystemd()) {
      try {
        writeUnits();
        systemd.restart(SERVICES);
      } catch {
        rollbackOk = false;
      }
      if (userbotUpdateAttempted && codeRollbackOk) {
        try {
          restartUserbotIfActive({
            quiet: true,
            knownActive: true,
            requirementsPath: userbotRollbackSnapshot,
            requireHashes: false,
          });
        } catch {
          rollbackOk = false;
        }
      }
    }
    await reporter?.fail(phase, versions.beforeVersion);
    terminal.info(`${error.message}. ${locale === "ru" ? "Откат" : "Rollback"}: ${rollbackOk ? "OK" : "FAILED"}. ${locale === "ru" ? "Лог" : "Log"}: ${logFile}`);
    process.exitCode = 1;
  } finally {
    terminal.dispose();
    reporter?.dispose();
    releaseUpdateLock(lock);
    if (userbotRollbackSnapshot) rmSync(userbotRollbackSnapshot, { force: true });
    await removeTelegramJob(loadedJob?.path);
  }
}

async function cmdConfig(args = []) {
  requireSystemd();
  const restartConfiguredServices = () => {
    // Units embed IVA_PORT, so both apply and rollback must regenerate them from
    // whichever .env is currently live before the checked restart. The candidate
    // already carries a valid bearer; skipping its migration here also keeps a
    // rollback snapshot byte-exact for older installations.
    writeUnits({ ensureBearer: false });
    systemd.restart(SERVICES);
  };

  const recovered = await recoverConfigTransaction(
    { envPath: ENV_PATH, services: SERVICES },
    { restart: restartConfiguredServices },
  );
  if (recovered) ok("Recovered the previous configuration and restarted services");
  if (args.includes("--recover")) {
    if (!recovered) ok("No pending configuration recovery");
    return;
  }

  const candidateDir = mkdtempSync(join(tmpdir(), "iva-config-"));
  const candidatePath = join(candidateDir, ".env");
  try {
    const r = run(NODE, ["scripts/setup.mjs"], {
      env: { ...childEnv, IVA_CONFIG_OUTPUT: candidatePath },
    });
    if (r.status !== 0) {
      process.exitCode = r.status ?? 1;
      return;
    }
    if (!(await confirm("Apply settings and restart services now?", true))) {
      warn("Configuration unchanged");
      return;
    }

    const nextText = readFileSync(candidatePath, "utf8");
    const nextEnv = parseEnvText(nextText);
    const provider = nextEnv.MODEL_PROVIDER;
    const selected = {
      ollama: ["OLLAMA_MODEL", "OLLAMA_API_KEY"],
      opencode: ["OPENCODE_MODEL", "OPENCODE_API_KEY"],
      openrouter: ["OPENROUTER_MODEL", "OPENROUTER_API_KEY"],
      codex: ["CODEX_MODEL", null],
    }[provider];
    if (!selected) throw new Error("candidate configuration has an invalid model provider");
    const port = Number(nextEnv.IVA_PORT || DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("candidate configuration has an invalid IVA_PORT");
    }

    await applyConfigTransaction({
      envPath: ENV_PATH,
      nextText,
      selection: {
        provider,
        model: nextEnv[selected[0]],
        key: selected[1] ? nextEnv[selected[1]] : undefined,
        dataDir: dataDirAbs(nextEnv),
      },
      services: SERVICES,
      healthUrl: `http://127.0.0.1:${port}/eve/v1/health`,
    }, {
      restart: restartConfiguredServices,
      health: (url) => probeEveHealth(url),
    });
    ok("Configuration applied; agent and Telegram bridge are active");
  } finally {
    rmSync(candidateDir, { recursive: true, force: true });
  }
}

async function cmdDoctor() {
  let okN = 0,
    warnN = 0,
    fixN = 0,
    badN = 0;
  const bearerChanged = ensureAssistantBearer();
  if (bearerChanged) fixN++;
  const env = readEnv();

  // 1. Node ≥24
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major >= 24) (ok(`Node ${process.versions.node}`), okN++);
  else (bad(`Node ${process.versions.node} < 24 — upgrade: nvm install 24`), badN++);

  // 2. .env + required keys (the same REQUIRED logic as in scripts/setup.mjs)
  if (!existsSync(ENV_PATH)) (bad(".env missing — run: iva config"), badN++);
  else {
    const prov = env.MODEL_PROVIDER || "ollama";
    // codex — доступ по OAuth-токену (data/codex-auth.json), у ollama/opencode — API-ключ в .env.
    const PROV_KEYS = {
      ollama: ["OLLAMA_API_KEY", "OLLAMA_MODEL"],
      opencode: ["OPENCODE_API_KEY", "OPENCODE_MODEL"],
      openrouter: ["OPENROUTER_API_KEY", "OPENROUTER_MODEL"],
      codex: ["CODEX_MODEL"],
    };
    const REQUIRED = [
      ...(PROV_KEYS[prov] || PROV_KEYS.ollama),
      "DEEPGRAM_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ALLOWED_USER_IDS",
      "ASSISTANT_BEARER",
    ];
    const missing = REQUIRED.filter((k) => !(env[k] || "").trim());
    if (prov === "codex" && !existsSync(join(dataDirAbs(env), "codex-auth.json"))) missing.push("OpenAI sign-in (iva login)");
    if (!missing.length) (ok(`.env filled in (provider: ${prov})`), okN++);
    else (bad(`.env incomplete, missing: ${missing.join(", ")} — run: iva config`), badN++);
    // old .env without IVA_PORT (or with :3000) — migrate right here
    if (migrateEnv()) fixN++;
    // web search is optional; check the key of the SELECTED provider (SEARCH_PROVIDER)
    const SEARCH_KEY = { tavily: "TAVILY_API_KEY", brave: "BRAVE_API_KEY", exa: "EXA_API_KEY", parallel: "PARALLEL_API_KEY" };
    const sp = (env.SEARCH_PROVIDER || "tavily").trim().toLowerCase();
    const skey = SEARCH_KEY[sp] || SEARCH_KEY.tavily;
    if (!(env[skey] || "").trim())
      (warn(`web_search: SEARCH_PROVIDER=${sp}, but ${skey} is not set — search won't work (iva config)`), warnN++);
    else (ok(`web_search: ${sp}`), okN++);
    // memory_search: hybrid mode needs one embedding key; base (grep) needs nothing.
    const mmode = (env.MEMORY_SEARCH_MODE || "grep").trim().toLowerCase();
    if (mmode === "hybrid" && !(env.JINA_API_KEY || env.DEEPINFRA_API_KEY || "").trim())
      (warn("memory_search: MEMORY_SEARCH_MODE=hybrid but no JINA_API_KEY/DEEPINFRA_API_KEY — falls back to BM25"), warnN++);
    else (ok(`memory_search: ${mmode}`), okN++);
  }

  // 3. Build
  if (existsSync(join(ROOT, ".output/server/index.mjs"))) (ok("Build in place (.output)"), okN++);
  else {
    warn(".output missing — building…");
    if (run(NPM, ["run", "build"]).status === 0) (ok("Built"), fixN++);
    else (bad("Build failed"), badN++);
  }

  if (!hasSystemd()) {
    warn("systemd unavailable (not Linux) — skipping service and timer checks");
    return summary();
  }

  // 4. Units installed
  const present = existsSync(UNIT_DIR) && readdirSync(UNIT_DIR).some((f) => /^iva.*\.(service|timer)$/.test(f));
  if (!present) {
    warn("systemd units not installed — installing…");
    try {
      writeUnits();
      activateUnits();
      (ok("Units installed, enabled and active"), fixN++);
    } catch (e) {
      (bad(e.message), badN++);
    }
  } else {
    try {
      writeUnits(); // refresh: Environment=PORT syncs with the current IVA_PORT (eliminates drift)
      (ok("systemd units installed (refreshed)"), okN++);
    } catch (e) {
      (bad(e.message), badN++);
    }
  }

  // 5. Services active
  for (const svc of SERVICES) {
    if (systemd.isEnabled(svc) && systemd.isActive(svc)) (ok(`${svc} enabled and active`), okN++);
    else {
      warn(`${svc} disabled or inactive — activating…`);
      try {
        systemd.resetFailed([svc]);
        systemd.activate([svc]);
        (ok(`${svc} enabled and active`), fixN++);
      } catch (e) {
        (bad(e.message), badN++);
      }
    }
  }
  // A newly generated bearer is read only at process start. Without this restart,
  // doctor would fix the file while leaving the live Eve process unable to accept it.
  if (bearerChanged) {
    warn("iva.service needs one restart to load the new internal bearer");
    try {
      systemd.restart(["iva.service"]);
      (ok("iva.service loaded the internal bearer"), fixN++);
    } catch (e) {
      (bad(e.message), badN++);
    }
  }
  // A refreshed unit does not move an already-running old process off 0.0.0.0.
  // Detect the actual socket and restart once so doctor repairs that upgrade state too.
  const port = Number((readEnv().IVA_PORT || DEFAULT_PORT).trim());
  const inspectListener = () => {
    const r = cap("ss", ["-H", "-ltn", "sport", "=", `:${port}`]);
    return r.code === 0 ? classifyAgentListeners(r.out, port) : "unknown";
  };
  let listener = inspectListener();
  if (listener === "exposed") {
    warn(`iva.service is exposed beyond loopback on port ${port} - restarting securely`);
    try {
      systemd.restart(["iva.service"]);
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        listener = inspectListener();
        if (listener === "loopback") break;
      }
      if (listener === "loopback") (ok(`iva.service bound to loopback:${port}`), fixN++);
      else (bad(`iva.service still exposed on port ${port}`), badN++);
    } catch (e) {
      (bad(e.message), badN++);
    }
  } else if (listener === "loopback") (ok(`iva.service bound to loopback:${port}`), okN++);
  else if (listener === "absent") (warn(`no listener found on port ${port}`), warnN++);
  else (warn("could not inspect listener addresses (ss unavailable)"), warnN++);

  // Background timers enabled
  let timerFailed = false;
  for (const t of TIMERS) {
    if (systemd.isEnabled(t) && systemd.isActive(t)) okN++;
    else {
      warn(`${t} disabled or inactive — enabling…`);
      try {
        systemd.activate([t]);
        fixN++;
      } catch (e) {
        timerFailed = true;
        (bad(e.message), badN++);
      }
    }
  }
  if (!timerFailed)
    ok(`Background timers enabled and active (${TIMERS.length}: ${MEMORY_TIMERS.length} memory + update check)`);

  // A oneshot service can be inactive and still healthy; its persistent failed state is the
  // signal that the last nightly run broke. Query only units actually installed on this host.
  const installedMemoryServices = MEMORY_SERVICES.filter((unit) => existsSync(join(UNIT_DIR, unit)));
  let failedMemoryServices = 0;
  for (const unit of installedMemoryServices) {
    const state = systemd.query("is-failed", unit);
    if (state.code === 0 && state.out === "failed") {
      bad(`${unit} failed — check: journalctl --user -u ${unit} -n 100 --no-pager`);
      badN++;
      failedMemoryServices++;
    }
  }
  if (installedMemoryServices.length && failedMemoryServices === 0) {
    ok(`Memory units have no failed state (${installedMemoryServices.length})`);
    okN++;
  }

  // 6. Vault + git origin (report only — we don't initiate git operations)
  const vaultRel = env.ASSISTANT_VAULT_DIR || "vault";
  const vaultPath = vaultRel.startsWith("/") ? vaultRel : join(ROOT, vaultRel);
  if (!existsSync(vaultPath)) (warn(`vault not found (${vaultPath}) — created on first memory or: npm run init-vault`), warnN++);
  else if (cap("git", ["-C", vaultPath, "remote", "get-url", "origin"]).out) (ok(`vault + git origin`), okN++);
  else
    (warn(
      `vault without git origin — memory backup not configured:\n    gh repo create <user>/iva-vault --private --source="${vaultPath}" --remote=origin --push`,
    ),
    warnN++);

  // enforce-report.json is produced by iva-memory-doctor.service, so only complain about
  // missing/stale output when that timer is enabled. A fresh report is still useful either way.
  const maintenanceTimerEnabled = systemd.isEnabled("iva-memory-doctor.timer");
  const maintenanceReport = readMemoryMaintenanceReport(join(vaultPath, ".graph/enforce-report.json"));
  if (maintenanceReport.status === "fresh") {
    if (maintenanceReport.problems.length) {
      warn(
        `ночной maintenance сообщает о проблемах: ${maintenanceReport.problems
          .map(({ key, count }) => `${key}=${count}`)
          .join(", ")}`,
      );
      warnN++;
    } else {
      ok("Ночной maintenance-отчёт свежий, проблем нет");
      okN++;
    }
  } else if (maintenanceTimerEnabled) {
    if (maintenanceReport.status === "invalid")
      warn("ночной maintenance оставил нечитаемый отчёт");
    else warn("ночной maintenance давно не отчитывался");
    warnN++;
  }

  return summary();

  function summary() {
    console.log();
    console.log(
      `${C.b}Summary:${C.x} ${C.g}${okN} ok${C.x} · ${C.y}${warnN} warn${C.x} · ${C.c}${fixN} fixed${C.x} · ${C.r}${badN} fail${C.x}`,
    );
    process.exit(badN > 0 ? 1 : 0);
  }
}

function cmdStatus() {
  requireSystemd();
  run("systemctl", ["--user", "status", "--no-pager", "-n", "5", ...SERVICES]);
  run("systemctl", ["--user", "list-timers", "--no-pager", "iva-memory-*", UPDATE_TIMER]);
}
function cmdRestart() {
  requireSystemd();
  restartServices(); // regenerate the unit before restart → PORT stays in sync with IVA_PORT in .env
  ok("Restarted: iva + telegram-poll");
}
// Full reset: stop services, quarantine workflow + Telegram control state, bring it back up.
// A plain restart
// does NOT cure a stuck/bloated run — on startup eve re-enqueues all pending/running
// runs ("Re-enqueued N active run(s) on startup"). We clean while the server is stopped
// (otherwise we'd delete files out from under a live process). Wipes ALL parked dialogs.
// Current eve keeps the store in .eve/.workflow-data; the bare .workflow-data is where
// older versions kept it — clear both so reset works across eve upgrades. Busy markers and
// the bridge queue are part of the same transaction: neither may leak into a fresh workflow.
function cmdReset() {
  requireSystemd();
  step("Full reset: stopping services…");
  // Fail closed: quarantining the store under a live eve corrupts state and resurrects
  // the very runs we're clearing — if stop failed, don't touch anything.
  try {
    systemd.stop(SERVICES);
  } catch (e) {
    bad(`${e.message} Workflow and Telegram control state left untouched`);
    process.exit(1);
  }
  let found = false;
  let failed = false;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const target of resetStateTargets(ROOT, dataDirAbs())) {
    try {
      // Quarantine (rename → *.trash-<stamp>) instead of rm: undo-able until rotated out.
      const dest = quarantinePath(target, stamp);
      if (!dest) continue;
      found = true;
      ok(`${relative(ROOT, target)} → ${relative(ROOT, dest)} — reset state quarantined`);
    } catch (e) {
      failed = true;
      warn(`failed to quarantine ${relative(ROOT, target)}: ${e.message}`);
    }
  }
  if (!found && !failed) ok("workflow and Telegram control state already empty");
  let restartError = null;
  try {
    restartServices();
  } catch (e) {
    restartError = e;
  }
  if (restartError) {
    bad(restartError.message);
  }
  if (failed) bad("Reset INCOMPLETE — old workflow or Telegram control state may still be active");
  if (failed || restartError) process.exit(1);
  ok("Restarted: iva + telegram-poll");
}
function cmdStart() {
  requireSystemd();
  activateUnits();
  ok("Started and enabled at boot");
}
function cmdStop() {
  requireSystemd();
  systemd.stop(SERVICES);
  ok("Stopped");
}
function cmdLogs(args) {
  requireSystemd();
  const unit = args.includes("poll") ? "iva-telegram-poll.service" : "iva.service";
  run("journalctl", ["--user", "-u", unit, "-f", "-n", "50"]);
}

async function cmdUninstall(args) {
  const purge = args.includes("--purge");
  warn("Uninstalling Iva: systemd units and the `iva` command will be removed.");
  if (purge) bad("--purge will ALSO DELETE the project code and vault (a separate git repo with your memory!).");
  if (!(await confirm("Continue?", false))) return console.log("Cancelled.");

  if (hasSystemd()) ok(`Removed systemd units: ${removeUnits().length}`);
  try {
    rmSync(join(homedir(), ".local/bin/iva"));
    ok("iva command removed from ~/.local/bin");
  } catch {}

  if (!purge) {
    console.log(`${C.d}Code and vault kept: ${ROOT}${C.x}`);
    return ok("Done.");
  }
  if (!(await confirm(`Delete the ${ROOT} directory AND vault IRREVERSIBLY?`, false)))
    return console.log("Code and vault kept.");
  const vaultRel = readEnv().ASSISTANT_VAULT_DIR || "vault";
  const vaultPath = vaultRel.startsWith("/") ? vaultRel : join(ROOT, vaultRel);
  for (const [p, label] of [
    [vaultPath, "vault"],
    [ROOT, "code"],
  ]) {
    try {
      rmSync(p, { recursive: true, force: true });
      ok(`${label} deleted`);
    } catch (e) {
      warn(`did not delete ${label}: ${e.message}`);
    }
  }
}

function cmdVersion() {
  let v = "?";
  try {
    v = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  } catch {}
  console.log(`iva ${v} · commit ${gitHead() || "?"}`);
}

// Token usage from data/usage.jsonl — the same log that Telegram /usage reads. A terminal
// view (issue #7, the comment about a CLI monitor). `tail [N]` — the last raw lines.
async function cmdUsage(args) {
  const { readEntries, summarize, formatUsageReport, parseWindow } = await import("../scripts/lib/usage.mjs");
  const env = readEnv();
  const dataDir = dataDirAbs(env);
  if (args[0] === "tail") {
    const n = Number(args[1]) || 10;
    for (const e of readEntries(dataDir).slice(-n)) console.log(JSON.stringify(e));
    return;
  }
  const agg = summarize(readEntries(dataDir), { window: parseWindow(args[0]), now: Date.now(), tz: env.ASSISTANT_TIMEZONE });
  console.log(formatUsageReport(agg));
}

// OpenAI subscription (ChatGPT) login — device code by default, --browser for the PKCE flow.
// Writes an OAuth token to data/codex-auth.json (0600); used when MODEL_PROVIDER=codex.
async function cmdLogin(args) {
  const { runDeviceCodeLogin, runBrowserLogin } = await import("../scripts/lib/codex-oauth.mjs");
  const dataDir = dataDirAbs();
  const lang = (readEnv().AGENT_LANGUAGE || "en").toLowerCase();
  const browser = args.includes("--browser");
  step(browser ? "OpenAI sign-in (browser)…" : "OpenAI sign-in (device code)…");
  try {
    const auth = browser
      ? await runBrowserLogin({ dataDir, lang, log: (m) => console.log(m) })
      : await runDeviceCodeLogin({ dataDir, lang, log: (m) => console.log(m) });
    ok(`Signed in${auth.planType ? ` — plan: ${auth.planType}` : ""}${auth.accountId ? ` · account ${auth.accountId}` : ""}`);
    console.log(`${C.d}Token stored: ${join(dataDir, "codex-auth.json")} (chmod 600)${C.x}`);
    if (readEnv().MODEL_PROVIDER !== "codex") warn("Set MODEL_PROVIDER=codex to use it: iva config (then iva restart)");
  } catch (e) {
    bad(`Sign-in failed: ${e.message}`);
    process.exit(1);
  }
}

function cmdHelp() {
  console.log(`
${C.b}Iva CLI${C.x} — manage your personal agent

${C.b}Commands:${C.x}
  ${C.c}iva update${C.x}         update: git pull + build + restart
  ${C.c}iva config${C.x}         configure: model, Telegram, Deepgram, TZ, vault
  ${C.c}iva login${C.x} [--browser]  sign in to an OpenAI subscription (ChatGPT) for MODEL_PROVIDER=codex
  ${C.c}iva doctor${C.x}         diagnose and safely auto-repair the install
  ${C.c}iva status${C.x}         status of services and memory timers
  ${C.c}iva restart${C.x}        restart the agent and Telegram bridge
  ${C.c}iva reset${C.x}          full reset: clear stuck workflows and restart
  ${C.c}iva start${C.x} / ${C.c}stop${C.x}    start / stop
  ${C.c}iva usage${C.x} [win]      token usage (last|today|week|month|by-model|by-source|tail)
  ${C.c}iva userbot${C.x} [creds|setup|status|diagnose --json|off]  personal-account userbot proxy
  ${C.c}iva logs${C.x} [poll]     agent logs (or the Telegram bridge) -f
  ${C.c}iva uninstall${C.x}       remove units and the command (--purge — delete code+vault)
  ${C.c}iva version${C.x}         version and git commit

  ${C.d}flags: update --force — rebuild with no changes; update --verbose — show technical output${C.x}
`);
}

// ── router ──────────────────────────────────────────────────────────────────
// ── Telegram userbot (opt-in) ────────────────────────────────────────────
// Build the venv if missing and ALWAYS sync deps (idempotent), then verify the
// critical imports actually resolve. Throws on any failure so the caller aborts
// BEFORE enabling a service that would restart-loop on a partial install.
function ensureUserbotVenv({
  quiet = false,
  requirementsPath = join(USERBOT_DIR, "requirements.lock"),
  requireHashes = true,
} = {}) {
  const hasUv = !!cap("sh", ["-c", "command -v uv"]).out;
  if (!hasUv) throw new Error("userbot: uv не найден — повторно запусти install.sh");
  const opts = { cwd: USERBOT_DIR, ...(quiet ? { stdio: "ignore" } : {}) };
  const must = (r, what) => {
    if ((r?.status ?? 1) !== 0) throw new Error(`userbot: ${what} не удалось`);
  };
  if (!existsSync(VENV_PY)) {
    if (!quiet) step("Создаю venv для userbot-прокси…");
    must(run("uv", ["venv", "--python", "3.12", ".venv"], opts), "создание venv");
    if (!existsSync(VENV_PY)) throw new Error("userbot: venv не создан — проверь python3/uv");
  }
  if (!quiet) step("Синхронизирую зависимости userbot-прокси…");
  const requirements = readFileSync(requirementsPath, "utf8");
  must(
    run(
      "uv",
      userbotSyncArgs({
        pythonPath: VENV_PY,
        requirementsFile: requirementsPath,
        requirementsText: requirements,
        requireHashes,
      }),
      opts,
    ),
    "установка зависимостей",
  );
  // A partial install imports-fails at runtime → the service restart-loops silently.
  const check = cap(VENV_PY, ["-c", "import telethon, telegram_mcp, qrcode, mcp"], opts);
  if (check.code !== 0)
    throw new Error(`userbot: зависимости не импортируются — ${check.err.split("\n").pop() || "проверь requirements"}`);
}

// Update-or-append keys in .env (dedup). Used to write Telegram api_id/api_hash
// without the agent hand-editing .env or leaking secrets through argv.
function writeEnvVars(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (/[\r\n]/.test(String(value))) throw new Error(`env value for ${key} contains a newline`);
  }
  const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const pending = new Map(Object.entries(vars).map(([key, value]) => [key, String(value)]));
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const key = line.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1];
    if (key && Object.hasOwn(vars, key)) {
      if (pending.has(key)) {
        out.push(`${key}=${pending.get(key)}`);
        pending.delete(key);
      }
      continue; // drop duplicate occurrences
    }
    out.push(line);
  }
  while (out.length && out.at(-1) === "") out.pop();
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  writeEnvAtomicSync(ENV_PATH, `${out.join("\n")}\n`);
}

// Generate the proxy bearer once, into a 0600 file both sides read at runtime.
function ensureUserbotToken() {
  if (existsSync(TOKEN_FILE)) return;
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, randomBytes(24).toString("hex"), { mode: 0o600 });
  try {
    chmodSync(TOKEN_FILE, 0o600);
  } catch {}
  ok("Сгенерировал токен прокси (data/telegram-userbot.token).");
}

// Restart the opt-in proxy onto fresh code/deps, but ONLY if it's already active
// (never auto-start it for users who didn't opt in). Called from `iva update`.
function restartUserbotIfActive({
  quiet = false,
  knownActive = false,
  requirementsPath = join(USERBOT_DIR, "requirements.lock"),
  requireHashes = true,
} = {}) {
  if (!knownActive && !systemd.isActive(SVC_USERBOT)) return;
  if (!quiet) step("Обновляю userbot-прокси…");
  ensureUserbotVenv({ quiet, requirementsPath, requireHashes });
  systemd.restart([SVC_USERBOT]);
  if (!quiet) ok("userbot-прокси перезапущен на новом коде");
}

async function cmdUserbot(args) {
  const sub = args[0] || "status";
  if (sub === "creds") {
    // Read api_id + api_hash from STDIN (two lines) — keeps secrets out of argv/ps.
    // Usage (agent): `iva userbot creds <<'CREDS'\n<api_id>\n<api_hash>\nCREDS`
    let data = "";
    try {
      data = readFileSync(0, "utf8");
    } catch {}
    const [apiId, apiHash] = data
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!apiId || !apiHash) {
      bad("stdin: жду две строки — api_id и api_hash (создай приложение на my.telegram.org)");
      process.exit(1);
    }
    if (!/^\d+$/.test(apiId)) {
      bad("api_id должен быть числом");
      process.exit(1);
    }
    writeEnvVars({ TELEGRAM_API_ID: apiId, TELEGRAM_API_HASH: apiHash });
    ok("Ключи Telegram записаны в .env. Теперь: iva userbot setup");
    return;
  }
  if (sub === "setup") {
    const env = readEnv();
    if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
      bad("Нет TELEGRAM_API_ID/TELEGRAM_API_HASH в .env. Создай приложение на my.telegram.org,");
      bad("впиши оба ключа в .env и запусти снова: iva userbot setup");
      process.exit(1);
    }
    ensureUserbotToken(); // 0600 token file both the proxy and iva's connection read at runtime
    ensureUserbotVenv(); // throws → dispatch catches → exit 1, service NOT enabled
    writeUnits();
    systemd.activate([SVC_USERBOT]);
    // enable --now is idempotent and does not reload an already-active proxy.
    // Restart after syncing deps/writing the unit so fresh credentials and code are live.
    systemd.restart([SVC_USERBOT]);
    // NOTE: do NOT restart iva here — the agent runs this mid-chat, and iva reads the token
    // from the file at call time, so no restart is needed (Eve retries the MCP connection).
    ok("Userbot-прокси включён. Подключи аккаунт по QR через бота: напиши боту «подключи мой телеграм».");
    ok("Статус: iva userbot status · выключить: iva userbot off");
    return;
  }
  if (sub === "off") {
    systemd.disableNow([SVC_USERBOT]);
    ok("Userbot-прокси остановлен и выключен.");
    return;
  }
  if (sub === "diagnose") {
    if (args[1] !== "--json") {
      bad("Использование: iva userbot diagnose --json");
      process.exit(1);
    }
    const env = readEnv();
    const health = await probeUserbotHealth({
      root: ROOT,
      port: env.TELEGRAM_MCP_PORT || "8724",
    });
    console.log(JSON.stringify(health));
    return;
  }
  if (sub !== "status") {
    bad(`Неизвестная команда userbot: ${sub}`);
    process.exit(1);
  }
  const env = readEnv();
  const health = await probeUserbotHealth({
    root: ROOT,
    port: env.TELEGRAM_MCP_PORT || "8724",
  });
  console.log(`${SVC_USERBOT}: ${health.state}`);
  console.log(`venv: ${existsSync(VENV_PY) ? "собран" : "нет — будет собран при setup"}`);
  console.log(`токен: ${existsSync(TOKEN_FILE) ? "есть" : "нет — создастся при setup"}`);
}

const [, , cmd, ...rest] = process.argv;
const cmds = {
  update: cmdUpdate,
  userbot: cmdUserbot,
  config: cmdConfig,
  login: cmdLogin,
  doctor: cmdDoctor,
  status: cmdStatus,
  restart: cmdRestart,
  reset: cmdReset,
  usage: cmdUsage,
  start: cmdStart,
  stop: cmdStop,
  logs: cmdLogs,
  uninstall: cmdUninstall,
  version: cmdVersion,
  tree: showTree, // play the ANSI tree (wind animation)
  help: cmdHelp,
  "--help": cmdHelp,
  "-h": cmdHelp,
  // Internal installer seams: one writer and the same checked activator used by
  // `iva start` and doctor. Success is printed only after every unit is enabled and active.
  "_install-units": () => ok(`systemd units written: ${writeUnits().length}`),
  "_activate-units": () => {
    activateUnits();
    ok(`systemd units enabled and active: ${SERVICES.length + TIMERS.length}`);
  },
};

const fn = cmds[cmd];
if (!fn) {
  if (cmd) bad(`Unknown command: ${cmd}`);
  cmdHelp();
  process.exit(cmd ? 1 : 0);
}
Promise.resolve(fn(rest)).catch((e) => {
  bad(e?.message || String(e));
  process.exit(1);
});
