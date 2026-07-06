#!/usr/bin/env node
// Iva CLI — manage the self-host installation: update / config / doctor / uninstall + wrappers.
// Self-contained, no external dependencies. Node 24+ (global fetch, spawnSync).
//
// SINGLE source of truth for systemd units (writeUnits): install.sh delegates here
// (`iva _install-units`), and update/doctor reuse the same write.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const UNIT_DIR = join(homedir(), ".config/systemd/user");
const NODE = process.execPath;
const NODE_BIN_DIR = dirname(NODE);
const NPM = existsSync(join(NODE_BIN_DIR, "npm")) ? join(NODE_BIN_DIR, "npm") : "npm";
// Children inherit PATH with the node directory — otherwise npm/eve won't be found when called via wrapper.
const childEnv = { ...process.env, PATH: `${NODE_BIN_DIR}:${process.env.PATH || ""}` };

const SERVICES = ["iva.service", "iva-telegram-poll.service"];
const TIMERS = ["daily", "weekly", "monthly", "yearly", "doctor"].map((n) => `iva-memory-${n}.timer`);

// Uncommon default port: 3000/8000/8080 are typically taken on a VPS (docker, etc.).
// Overridden by the IVA_PORT variable in .env; the default ASSISTANT_HOST depends on it too.
const DEFAULT_PORT = "8723";
// Former (hardcoded) default before the switch to IVA_PORT — needed to migrate old .env files.
const OLD_DEFAULT_HOST = "http://127.0.0.1:3000";

const C = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", c: "\x1b[36m", b: "\x1b[1m", d: "\x1b[2m", x: "\x1b[0m" };
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
const sc = (...args) => run("systemctl", ["--user", ...args]);
const scQ = (...args) => cap("systemctl", ["--user", ...args]);
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

async function notifyTelegram(text) {
  const env = readEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_DIGEST_CHAT_ID || (env.TELEGRAM_ALLOWED_USER_IDS || "").split(",")[0];
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
  } catch {}
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
    `WorkingDirectory=${ROOT}`,
    `EnvironmentFile=${ROOT}/.env`,
    // Стартуем через `eve start`, а НЕ напрямую `node .output/server/index.mjs`: eve start
    // вызывает prewarmBuiltAppSandboxes() и собирает шаблон песочницы ДО приёма трафика. Сырой
    // index.mjs prewarm не делает → первое же вложение падает SandboxTemplateNotProvisionedError
    // (шаблона нет в .eve/sandbox-cache). Ключ шаблона — контент-хеш, после iva update он меняется,
    // поэтому provision обязан идти на каждом старте, а не разово. eve start остаётся foreground.
    `ExecStart=${NODE} ${ROOT}/node_modules/eve/bin/eve.js start`,
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

// Writes iva.service + all deploy/iva-*.{service,timer} with placeholder substitution. daemon-reload.
function writeUnits() {
  mkdirSync(UNIT_DIR, { recursive: true });
  writeFileSync(join(UNIT_DIR, "iva.service"), ivaServiceBody());
  const written = ["iva.service"];
  const deploy = join(ROOT, "deploy");
  for (const f of readdirSync(deploy)) {
    if (!/^iva-.*\.(service|timer)$/.test(f)) continue;
    const tpl = readFileSync(join(deploy, f), "utf8")
      .replaceAll("__PROJECT_DIR__", ROOT)
      .replaceAll("__NODE_BIN__", NODE);
    writeFileSync(join(UNIT_DIR, f), tpl);
    written.push(f);
  }
  if (hasSystemd()) scQ("daemon-reload");
  return written;
}

function enableUnits() {
  sc("enable", "--now", ...SERVICES);
  for (const t of TIMERS) sc("enable", "--now", t);
}

function removeUnits() {
  if (!existsSync(UNIT_DIR)) return [];
  const units = readdirSync(UNIT_DIR).filter((f) => /^iva.*\.(service|timer)$/.test(f));
  for (const u of units) scQ("disable", "--now", u);
  for (const u of units) {
    try {
      rmSync(join(UNIT_DIR, u));
    } catch {}
  }
  scQ("daemon-reload");
  scQ("reset-failed");
  return units;
}

// Migrate old installs to IVA_PORT. Idempotent: on the first `iva update`
// after switching to the new scheme it guarantees the variable and keeps the server
// (Environment=PORT=$IVA_PORT) from drifting away from clients (whose default is ASSISTANT_HOST).
function migrateEnv() {
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
  writeFileSync(ENV_PATH, raw);
  ok(`.env migrated → IVA_PORT=${port}${isOldDefault ? ", ASSISTANT_HOST moved off :3000" : ""}`);
  return true;
}

// Any restart via `iva` first regenerates the unit → Environment=PORT always equals
// the current IVA_PORT from .env. Without this, editing IVA_PORT + restart would leave the server
// on the old port (the unit was already baked) while clients read the new one — the same desync.
function restartServices() {
  writeUnits();
  sc("restart", ...SERVICES);
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
  if (!process.stdout.isTTY) return;
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
    const FRAMES = 36, DELAY = 70;
    for (let f = 0; f < FRAMES; f++) {
      if (f > 0) process.stdout.write(`\x1b[${rows}A`);
      process.stdout.write(renderTreeFrame(grid, f * 0.7, true));
      await new Promise((r) => setTimeout(r, DELAY));
    }
    process.stdout.write(`\x1b[${rows}A` + renderTreeFrame(grid, 0, false) + "\x1b[?25h\n");
  } catch {
    process.stdout.write("\x1b[?25h"); // just in case — restore the cursor
  }
}

// ── commands ───────────────────────────────────────────────────────────────
async function cmdUpdate(args) {
  const force = args.includes("--force");
  await showTree();
  step("Updating Iva…");
  const before = gitHead();
  const branch = cap("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out || "main";
  const fetchRes = cap("git", ["fetch", "--prune", "origin", branch]);
  console.log([fetchRes.out, fetchRes.err].filter(Boolean).join("\n"));
  if (fetchRes.code !== 0) {
    bad("git fetch failed — check the network/remote, then retry");
    process.exit(1);
  }
  // Fast-forward when possible; on a rewritten upstream (force-push) the branches
  // diverge and ff is impossible — hard-reset to the remote instead of failing.
  // Untracked files (.env, vault, …) are preserved by reset --hard.
  let upd = cap("git", ["merge", "--ff-only", `origin/${branch}`]);
  if (upd.code !== 0) {
    warn("Upstream history was rewritten — resetting to origin/" + branch);
    upd = cap("git", ["reset", "--hard", `origin/${branch}`]);
  }
  console.log([upd.out, upd.err].filter(Boolean).join("\n"));
  if (upd.code !== 0) {
    bad("git update failed — resolve manually (git status), then retry");
    process.exit(1);
  }
  const after = gitHead();
  const changed = before !== after;
  if (!changed && !force) {
    ok(`Already up to date (${after}). Nothing to rebuild (--force to force it).`);
    return;
  }
  if (changed) {
    const files = cap("git", ["diff", "--name-only", `${before}..${after}`]).out.split("\n");
    if (files.includes("package-lock.json") || files.includes("package.json")) {
      const hasLock = existsSync(join(ROOT, "package-lock.json"));
      step(`Dependencies changed — npm ${hasLock ? "ci" : "install"}…`);
      run(NPM, [hasLock ? "ci" : "install"]);
    }
  }
  migrateEnv(); // old .env: add IVA_PORT and move off the taken :3000 (before build/restart)
  step("Building (eve build)…");
  if (run(NPM, ["run", "build"]).status !== 0) {
    bad("Build failed — NOT restarting the service (the old build stays working)");
    process.exit(1);
  }
  if (hasSystemd()) {
    step("Refreshing systemd units and restarting…");
    restartServices();
    ok("Restarted: iva + telegram-poll");
  } else {
    warn("systemd unavailable — restart the process manually");
  }
  ok(`Done: ${before} → ${after}`);
  await notifyTelegram(`✅ Iva updated: ${before} → ${after}`);
}

async function cmdConfig() {
  const r = run(NODE, ["scripts/setup.mjs"]);
  if (r.status !== 0) process.exit(r.status ?? 1);
  if (hasSystemd() && (await confirm("Restart services to apply the settings?", true))) {
    restartServices(); // setup may have changed IVA_PORT → regenerate the unit, otherwise the server stays on the old port
    ok("Services restarted");
  }
}

function cmdDoctor() {
  let okN = 0,
    warnN = 0,
    fixN = 0,
    badN = 0;
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
      codex: ["CODEX_MODEL"],
    };
    const REQUIRED = [...(PROV_KEYS[prov] || PROV_KEYS.ollama), "DEEPGRAM_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS"];
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
    writeUnits();
    enableUnits();
    (ok("Units installed and enabled"), fixN++);
  } else {
    writeUnits(); // refresh: Environment=PORT syncs with the current IVA_PORT (eliminates drift)
    (ok("systemd units installed (refreshed)"), okN++);
  }

  // 5. Services active
  for (const svc of SERVICES) {
    if (scQ("is-active", svc).out === "active") (ok(`${svc} active`), okN++);
    else {
      warn(`${svc} inactive — restarting…`);
      scQ("reset-failed", svc);
      sc("restart", svc);
      if (scQ("is-active", svc).out === "active") (ok(`${svc} brought up`), fixN++);
      else (bad(`${svc} won't start — journalctl --user -u ${svc} -e`), badN++);
    }
  }
  // Memory timers enabled
  for (const t of TIMERS) {
    if (scQ("is-enabled", t).out === "enabled") okN++;
    else {
      warn(`${t} disabled — enabling…`);
      sc("enable", "--now", t);
      fixN++;
    }
  }
  ok(`Memory timers checked (${TIMERS.length})`);

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
  run("systemctl", ["--user", "list-timers", "--no-pager", "iva-memory-*"]);
}
function cmdRestart() {
  requireSystemd();
  restartServices(); // regenerate the unit before restart → PORT stays in sync with IVA_PORT in .env
  ok("Restarted: iva + telegram-poll");
}
// Full reset: stop services, wipe .workflow-data, bring it back up. A plain restart
// does NOT cure a stuck/bloated run — on startup eve re-enqueues all pending/running
// runs from .workflow-data ("Re-enqueued N active run(s) on startup"). We clean while the server
// is stopped (otherwise we'd delete files out from under a live process). Wipes ALL parked dialogs.
function cmdReset() {
  requireSystemd();
  step("Full reset: stopping services…");
  sc("stop", ...SERVICES);
  const wf = join(ROOT, ".workflow-data");
  if (existsSync(wf)) {
    try {
      rmSync(wf, { recursive: true, force: true });
      ok(".workflow-data cleared — stuck/accumulated workflow runs reset");
    } catch (e) {
      warn(`failed to delete .workflow-data: ${e.message}`);
    }
  } else ok(".workflow-data already empty");
  restartServices();
  ok("Restarted: iva + telegram-poll");
}
function cmdStart() {
  requireSystemd();
  enableUnits();
  ok("Started and enabled at boot");
}
function cmdStop() {
  requireSystemd();
  sc("stop", ...SERVICES);
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
  const dataDir = join(ROOT, env.ASSISTANT_DATA_DIR || "data");
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
  ${C.c}iva logs${C.x} [poll]     agent logs (or the Telegram bridge) -f
  ${C.c}iva uninstall${C.x}       remove units and the command (--purge — delete code+vault)
  ${C.c}iva version${C.x}         version and git commit

  ${C.d}flags: update --force — rebuild with no changes${C.x}
`);
}

// ── router ──────────────────────────────────────────────────────────────────
const [, , cmd, ...rest] = process.argv;
const cmds = {
  update: cmdUpdate,
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
  // internal subcommand — install.sh delegates unit writing here (DRY)
  "_install-units": () => ok(`systemd units written: ${writeUnits().length}`),
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
