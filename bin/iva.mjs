#!/usr/bin/env node
// Iva CLI — управление self-host инсталляцией: update / config / doctor / uninstall + обёртки.
// Самодостаточный, без внешних зависимостей. Node 24+ (global fetch, spawnSync).
//
// ЕДИНЫЙ источник правды для systemd-юнитов (writeUnits): install.sh делегирует сюда
// (`iva _install-units`), а update/doctor переиспользуют ту же запись.
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
// Дети наследуют PATH с каталогом node — иначе npm/eve не найдутся при вызове через wrapper.
const childEnv = { ...process.env, PATH: `${NODE_BIN_DIR}:${process.env.PATH || ""}` };

const SERVICES = ["iva.service", "iva-telegram-poll.service"];
const TIMERS = ["daily", "weekly", "monthly", "yearly", "doctor"].map((n) => `iva-memory-${n}.timer`);

// Непопсовый порт по умолчанию: 3000/8000/8080 на типовом VPS заняты (docker и т.п.).
// Переопределяется переменной IVA_PORT в .env; от него же зависит дефолтный ASSISTANT_HOST.
const DEFAULT_PORT = "8723";
// Прежний (зашитый) дефолт до перехода на IVA_PORT — нужен для миграции старых .env.
const OLD_DEFAULT_HOST = "http://127.0.0.1:3000";

const C = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", c: "\x1b[36m", b: "\x1b[1m", d: "\x1b[2m", x: "\x1b[0m" };
const ok = (m) => console.log(`${C.g}✓${C.x} ${m}`);
const warn = (m) => console.log(`${C.y}!${C.x} ${m}`);
const bad = (m) => console.log(`${C.r}✗${C.x} ${m}`);
const step = (m) => console.log(`${C.b}${C.c}▸ ${m}${C.x}`);

// ── мелкие хелперы ────────────────────────────────────────────────────────
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

async function confirm(question, def = false) {
  if (!process.stdin.isTTY) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  rl.close();
  return a ? a.startsWith("y") : def;
}

function requireSystemd() {
  if (!hasSystemd()) {
    bad("systemd недоступен — эта команда работает только на Linux-сервере");
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

// ── systemd-юниты: единый источник правды ─────────────────────────────────
function ivaServiceBody() {
  // Идентично install.sh §9: PATH с каталогом node (= npm global bin при nvm), Restart=always.
  const port = (readEnv().IVA_PORT || DEFAULT_PORT).trim();
  return [
    "[Unit]",
    "Description=Iva",
    "After=network-online.target",
    "",
    "[Service]",
    `WorkingDirectory=${ROOT}`,
    `EnvironmentFile=${ROOT}/.env`,
    `ExecStart=${NODE} ${ROOT}/.output/server/index.mjs`,
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

// Пишет iva.service + все deploy/iva-*.{service,timer} с подстановкой плейсхолдеров. daemon-reload.
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

// Миграция старых установок на IVA_PORT. Идемпотентна: при первом `iva update`
// после перехода на новую схему гарантирует переменную и не даёт серверу
// (Environment=PORT=$IVA_PORT) разъехаться с клиентами (их дефолт — ASSISTANT_HOST).
function migrateEnv() {
  if (!existsSync(ENV_PATH)) return false;
  const env = readEnv();
  if (env.IVA_PORT) return false; // уже на новой схеме — ничего не трогаем
  const host = env.ASSISTANT_HOST || "";
  const local = host.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/i);
  const isOldDefault = host === OLD_DEFAULT_HOST;
  // старый дефолт :3000 → новый дефолт 8723; кастомный локальный host → его порт; иначе дефолт
  const port = isOldDefault ? DEFAULT_PORT : local ? local[1] : DEFAULT_PORT;
  let raw = readFileSync(ENV_PATH, "utf8").replace(/\n*$/, "\n") + `IVA_PORT=${port}\n`;
  // не оставляем устаревший :3000 в ASSISTANT_HOST — иначе клиенты застрянут на занятом порту
  if (isOldDefault) raw = raw.replace(/^(\s*ASSISTANT_HOST\s*=).*$/m, `$1http://127.0.0.1:${port}`);
  writeFileSync(ENV_PATH, raw);
  ok(`.env мигрирован → IVA_PORT=${port}${isOldDefault ? ", ASSISTANT_HOST уведён с :3000" : ""}`);
  return true;
}

// Любой рестарт через `iva` сперва регенерит юнит → Environment=PORT всегда равен
// текущему IVA_PORT из .env. Без этого правка IVA_PORT + restart оставляла бы сервер
// на старом порту (юнит уже запечён), а клиенты читали бы новый — тот же рассинхрон.
function restartServices() {
  writeUnits();
  sc("restart", ...SERVICES);
}

// ── команды ───────────────────────────────────────────────────────────────
async function cmdUpdate(args) {
  const force = args.includes("--force");
  step("Обновляю Iva…");
  const before = gitHead();
  const pull = cap("git", ["pull", "--ff-only"]);
  console.log([pull.out, pull.err].filter(Boolean).join("\n"));
  if (pull.code !== 0) {
    bad("git pull не удался — разрули вручную (git status), затем повтори");
    process.exit(1);
  }
  const after = gitHead();
  const changed = before !== after;
  if (!changed && !force) {
    ok(`Уже актуально (${after}). Нечего пересобирать (--force чтобы форсить).`);
    return;
  }
  if (changed) {
    const files = cap("git", ["diff", "--name-only", `${before}..${after}`]).out.split("\n");
    if (files.includes("package-lock.json") || files.includes("package.json")) {
      const hasLock = existsSync(join(ROOT, "package-lock.json"));
      step(`Зависимости изменились — npm ${hasLock ? "ci" : "install"}…`);
      run(NPM, [hasLock ? "ci" : "install"]);
    }
  }
  migrateEnv(); // старые .env: добавить IVA_PORT и увести с занятого :3000 (до сборки/рестарта)
  step("Сборка (eve build)…");
  if (run(NPM, ["run", "build"]).status !== 0) {
    bad("Сборка упала — сервис НЕ перезапускаю (старая сборка осталась рабочей)");
    process.exit(1);
  }
  if (hasSystemd()) {
    step("Рефреш systemd-юнитов и перезапуск…");
    restartServices();
    ok("Перезапущено: iva + telegram-poll");
  } else {
    warn("systemd недоступен — перезапустите процесс вручную");
  }
  ok(`Готово: ${before} → ${after}`);
  await notifyTelegram(`✅ Iva обновлена: ${before} → ${after}`);
}

async function cmdConfig() {
  const r = run(NODE, ["scripts/setup.mjs"]);
  if (r.status !== 0) process.exit(r.status ?? 1);
  if (hasSystemd() && (await confirm("Перезапустить сервисы, чтобы применить настройки?", true))) {
    restartServices(); // setup мог сменить IVA_PORT → регенерим юнит, иначе сервер останется на старом порту
    ok("Сервисы перезапущены");
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
  else (bad(`Node ${process.versions.node} < 24 — обнови: nvm install 24`), badN++);

  // 2. .env + обязательные ключи (та же логика REQUIRED, что в scripts/setup.mjs)
  if (!existsSync(ENV_PATH)) (bad(".env отсутствует — запустите: iva config"), badN++);
  else {
    const prov = env.MODEL_PROVIDER || "ollama";
    const REQUIRED = [
      prov === "opencode" ? "OPENCODE_API_KEY" : "OLLAMA_API_KEY",
      prov === "opencode" ? "OPENCODE_MODEL" : "OLLAMA_MODEL",
      "DEEPGRAM_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ALLOWED_USER_IDS",
    ];
    const missing = REQUIRED.filter((k) => !(env[k] || "").trim());
    if (!missing.length) (ok(`.env заполнен (провайдер: ${prov})`), okN++);
    else (bad(`.env неполный, нет: ${missing.join(", ")} — запустите: iva config`), badN++);
    // старые .env без IVA_PORT (или с :3000) — мигрируем здесь же
    if (migrateEnv()) fixN++;
  }

  // 3. Сборка
  if (existsSync(join(ROOT, ".output/server/index.mjs"))) (ok("Сборка на месте (.output)"), okN++);
  else {
    warn(".output отсутствует — собираю…");
    if (run(NPM, ["run", "build"]).status === 0) (ok("Собрано"), fixN++);
    else (bad("Сборка не удалась"), badN++);
  }

  if (!hasSystemd()) {
    warn("systemd недоступен (не Linux) — пропускаю проверки сервисов и таймеров");
    return summary();
  }

  // 4. Юниты установлены
  const present = existsSync(UNIT_DIR) && readdirSync(UNIT_DIR).some((f) => /^iva.*\.(service|timer)$/.test(f));
  if (!present) {
    warn("systemd-юниты не установлены — ставлю…");
    writeUnits();
    enableUnits();
    (ok("Юниты установлены и включены"), fixN++);
  } else {
    writeUnits(); // рефреш: Environment=PORT синхронизируется с актуальным IVA_PORT (устраняет дрейф)
    (ok("systemd-юниты установлены (рефреш)"), okN++);
  }

  // 5. Сервисы активны
  for (const svc of SERVICES) {
    if (scQ("is-active", svc).out === "active") (ok(`${svc} активен`), okN++);
    else {
      warn(`${svc} неактивен — перезапускаю…`);
      scQ("reset-failed", svc);
      sc("restart", svc);
      if (scQ("is-active", svc).out === "active") (ok(`${svc} поднят`), fixN++);
      else (bad(`${svc} не стартует — journalctl --user -u ${svc} -e`), badN++);
    }
  }
  // Таймеры памяти включены
  for (const t of TIMERS) {
    if (scQ("is-enabled", t).out === "enabled") okN++;
    else {
      warn(`${t} выключен — включаю…`);
      sc("enable", "--now", t);
      fixN++;
    }
  }
  ok(`Таймеры памяти проверены (${TIMERS.length})`);

  // 6. Vault + git origin (только репорт — git-операции не инициируем)
  const vaultRel = env.ASSISTANT_VAULT_DIR || "vault";
  const vaultPath = vaultRel.startsWith("/") ? vaultRel : join(ROOT, vaultRel);
  if (!existsSync(vaultPath)) (warn(`vault не найден (${vaultPath}) — создастся при памяти или: npm run init-vault`), warnN++);
  else if (cap("git", ["-C", vaultPath, "remote", "get-url", "origin"]).out) (ok(`vault + git origin`), okN++);
  else
    (warn(
      `vault без git origin — бэкап памяти не настроен:\n    gh repo create <user>/iva-vault --private --source="${vaultPath}" --remote=origin --push`,
    ),
    warnN++);

  return summary();

  function summary() {
    console.log();
    console.log(
      `${C.b}Итог:${C.x} ${C.g}${okN} ok${C.x} · ${C.y}${warnN} warn${C.x} · ${C.c}${fixN} fixed${C.x} · ${C.r}${badN} fail${C.x}`,
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
  restartServices(); // регенерим юнит перед рестартом → PORT синхронен с IVA_PORT в .env
  ok("Перезапущено: iva + telegram-poll");
}
function cmdStart() {
  requireSystemd();
  enableUnits();
  ok("Запущено и включено в автозапуск");
}
function cmdStop() {
  requireSystemd();
  sc("stop", ...SERVICES);
  ok("Остановлено");
}
function cmdLogs(args) {
  requireSystemd();
  const unit = args.includes("poll") ? "iva-telegram-poll.service" : "iva.service";
  run("journalctl", ["--user", "-u", unit, "-f", "-n", "50"]);
}

async function cmdUninstall(args) {
  const purge = args.includes("--purge");
  warn("Удаление Iva: systemd-юниты и команда `iva` будут сняты.");
  if (purge) bad("--purge также УДАЛИТ код проекта и vault (отдельный git-репо с памятью!).");
  if (!(await confirm("Продолжить?", false))) return console.log("Отменено.");

  if (hasSystemd()) ok(`Сняты systemd-юниты: ${removeUnits().length}`);
  try {
    rmSync(join(homedir(), ".local/bin/iva"));
    ok("Команда iva удалена из ~/.local/bin");
  } catch {}

  if (!purge) {
    console.log(`${C.d}Код и vault оставлены: ${ROOT}${C.x}`);
    return ok("Готово.");
  }
  if (!(await confirm(`Удалить каталог ${ROOT} И vault БЕЗВОЗВРАТНО?`, false)))
    return console.log("Код и vault оставлены.");
  const vaultRel = readEnv().ASSISTANT_VAULT_DIR || "vault";
  const vaultPath = vaultRel.startsWith("/") ? vaultRel : join(ROOT, vaultRel);
  for (const [p, label] of [
    [vaultPath, "vault"],
    [ROOT, "код"],
  ]) {
    try {
      rmSync(p, { recursive: true, force: true });
      ok(`${label} удалён`);
    } catch (e) {
      warn(`не удалил ${label}: ${e.message}`);
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

function cmdHelp() {
  console.log(`
${C.b}Iva CLI${C.x} — управление личным агентом

${C.b}Команды:${C.x}
  ${C.c}iva update${C.x}         обновить: git pull + сборка + перезапуск
  ${C.c}iva config${C.x}         настройка: модель, Telegram, Deepgram, TZ, vault
  ${C.c}iva doctor${C.x}         диагностика и безопасная авто-починка установки
  ${C.c}iva status${C.x}         статус сервисов и таймеров памяти
  ${C.c}iva restart${C.x}        перезапустить агента и Telegram-мост
  ${C.c}iva start${C.x} / ${C.c}stop${C.x}    запустить / остановить
  ${C.c}iva logs${C.x} [poll]     логи агента (или Telegram-моста) -f
  ${C.c}iva uninstall${C.x}       снять юниты и команду (--purge — удалить код+vault)
  ${C.c}iva version${C.x}         версия и git-commit

  ${C.d}флаги: update --force — пересобрать без изменений${C.x}
`);
}

// ── роутер ──────────────────────────────────────────────────────────────────
const [, , cmd, ...rest] = process.argv;
const cmds = {
  update: cmdUpdate,
  config: cmdConfig,
  doctor: cmdDoctor,
  status: cmdStatus,
  restart: cmdRestart,
  start: cmdStart,
  stop: cmdStop,
  logs: cmdLogs,
  uninstall: cmdUninstall,
  version: cmdVersion,
  help: cmdHelp,
  "--help": cmdHelp,
  "-h": cmdHelp,
  // внутренняя подкоманда — install.sh делегирует сюда запись юнитов (DRY)
  "_install-units": () => ok(`systemd-юниты записаны: ${writeUnits().length}`),
};

const fn = cmds[cmd];
if (!fn) {
  if (cmd) bad(`Неизвестная команда: ${cmd}`);
  cmdHelp();
  process.exit(cmd ? 1 : 0);
}
Promise.resolve(fn(rest)).catch((e) => {
  bad(e?.message || String(e));
  process.exit(1);
});
