// OAuth-ядро для входа по подписке OpenAI (ChatGPT Plus/Pro/Team) — как в официальном codex CLI.
// ЕДИНЫЙ источник правды: импортируется и из bare-node (bin/iva.mjs, scripts/setup.mjs),
// и из бандла eve (agent/provider.ts, agent/vision.ts) — как scripts/lib/usage.mjs.
// Чистый ESM, только node-builtins (crypto/fs/http/child_process). Типы — в codex-oauth.d.mts.
//
// Протокол (reverse-engineered из openai/codex, публичный client_id):
//   auth-домен  https://auth.openai.com     device-code + browser-PKCE + refresh
//   API-домен   https://chatgpt.com/backend-api/codex   Responses API (/responses, /models)
// Токен (access_token — JWT, живёт ~1 ч) кладём в data/codex-auth.json (0600, gitignored).
// Перед каждым запросом getAccessToken() рефрешит токен при подходе к exp (refresh_token одноразовый).
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

export const ISSUER = "https://auth.openai.com";
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // публичный client_id Codex CLI
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const TOKEN_URL = `${ISSUER}/oauth/token`;
const SCOPE = "openid profile email offline_access";
const ORIGINATOR = "codex_cli_rs";
const CLIENT_VERSION = "0.20.0"; // для ?client_version= у /models и User-Agent (мимикрия под codex CLI)
const REFRESH_SKEW_S = 300; // рефрешим за 5 мин до exp (как окно codex CLI)
const DEVICE_PORT = 1455; // codex-совместимый redirect-порт (fallback 1457)
const FALLBACK_PORT = 1457;

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const defaultDir = () => process.env.ASSISTANT_DATA_DIR || "data";
// Язык подсказок входа (en по умолчанию — как у codex CLI). Мастер/CLI прокидывают lang.
const tr = (lang, en, ru) => (lang === "ru" ? ru : en);

// ── хранилище токенов ─────────────────────────────────────────────────────
export function authFilePath(dataDir = defaultDir()) {
  return join(dataDir, "codex-auth.json");
}

export function readAuth(dataDir = defaultDir()) {
  try {
    return JSON.parse(readFileSync(authFilePath(dataDir), "utf8"));
  } catch {
    return null;
  }
}

// Атомарная запись 0600 (temp + rename) — секрет не должен мелькнуть с широкими правами,
// а конкурентный read не должен поймать полу-записанный файл.
export function writeAuth(auth, dataDir = defaultDir()) {
  const file = authFilePath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// ── JWT / PKCE (без внешних зависимостей) ──────────────────────────────────
export function parseJwt(jwt) {
  const payload = String(jwt).split(".")[1];
  if (!payload) throw new Error("malformed JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

// exp (unix-секунды) из access_token; 0 если нет клейма.
export function jwtExp(jwt) {
  try {
    return Number(parseJwt(jwt).exp) || 0;
  } catch {
    return 0;
  }
}

// Из id_token достаём account_id и план подписки (клейм https://api.openai.com/auth).
export function accountFromIdToken(idToken) {
  let auth = {};
  try {
    auth = parseJwt(idToken)["https://api.openai.com/auth"] || {};
  } catch {
    /* нет клейма — вернём пустое */
  }
  return { accountId: auth.chatgpt_account_id || null, planType: auth.chatgpt_plan_type || null };
}

function pkce() {
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// ── обмен кода и refresh (общий /oauth/token) ──────────────────────────────
async function exchangeCode({ code, verifier, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json(); // { id_token, access_token, refresh_token }
}

async function refresh(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json(); // { id_token?, access_token, refresh_token? }
}

// Собирает объект хранилища из ответа токен-эндпоинта.
function toAuth(tokens, prev = {}) {
  const idToken = tokens.id_token || prev.id_token;
  const { accountId, planType } = idToken ? accountFromIdToken(idToken) : { accountId: prev.accountId, planType: prev.planType };
  return {
    id_token: idToken,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || prev.refresh_token,
    accountId,
    planType,
  };
}

// ── getAccessToken: свежий токен для каждого запроса ────────────────────────
// Дедуп рефреша в пределах процесса (модель зовётся конкурентно). Кросс-процессный
// рейс (CLI login + сервер) маловероятен и самолечится: при провале рефреша
// перечитываем файл — вдруг другой процесс уже обновил.
let refreshInFlight = null;
export async function getAccessToken(dataDir = defaultDir()) {
  let auth = readAuth(dataDir);
  if (!auth?.access_token) throw new Error("not logged in — run `iva login`");
  const fresh = jwtExp(auth.access_token) - REFRESH_SKEW_S > Math.floor(Date.now() / 1000);
  if (fresh) return { accessToken: auth.access_token, accountId: auth.accountId };

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const next = toAuth(await refresh(auth.refresh_token), auth);
        writeAuth(next, dataDir);
        return next;
      } catch (err) {
        const reread = readAuth(dataDir); // мог обновить другой процесс
        if (reread?.access_token && jwtExp(reread.access_token) - REFRESH_SKEW_S > Math.floor(Date.now() / 1000)) return reread;
        throw err;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  auth = await refreshInFlight;
  return { accessToken: auth.access_token, accountId: auth.accountId };
}

// Заголовки авторизации для вызова Codex-бэкенда (/responses, /models).
export async function codexAuthHeaders(dataDir = defaultDir()) {
  const { accessToken, accountId } = await getAccessToken(dataDir);
  const h = {
    Authorization: `Bearer ${accessToken}`,
    originator: ORIGINATOR,
    "User-Agent": `${ORIGINATOR}/${CLIENT_VERSION}`,
  };
  if (accountId) h["ChatGPT-Account-ID"] = accountId;
  return h;
}

// ── device-code flow (headless-friendly, по ссылке) ────────────────────────
export async function runDeviceCodeLogin({ dataDir = defaultDir(), log = console.log, lang = "en" } = {}) {
  const api = `${ISSUER}/api/accounts`;
  const uc = await fetch(`${api}/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!uc.ok) throw new Error(`device usercode failed: ${uc.status} ${(await uc.text()).slice(0, 200)}`);
  const { device_auth_id, user_code, interval } = await uc.json();

  log(`\n  1. ${tr(lang, "Open this link in a browser (any device):", "Открой в браузере (на любом устройстве):")}  ${ISSUER}/codex/device`);
  log(`  2. ${tr(lang, "Enter this one-time code (expires in 15 min):", "Введи одноразовый код (живёт 15 минут):")}   ${user_code}\n`);
  log(`  ${tr(lang, "Waiting for confirmation…", "Жду подтверждения…")}`);

  const pollMs = Math.max(Number(interval) || 5, 1) * 1000;
  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("device auth timed out (15 min)");
    const r = await fetch(`${api}/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id, user_code }),
    });
    if (r.ok) {
      const { authorization_code, code_verifier } = await r.json();
      const tokens = await exchangeCode({
        code: authorization_code,
        verifier: code_verifier,
        redirectUri: `${ISSUER}/deviceauth/callback`,
      });
      const auth = toAuth(tokens);
      writeAuth(auth, dataDir);
      return auth;
    }
    if (r.status !== 403 && r.status !== 404) throw new Error(`device auth failed: ${r.status}`);
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

// ── browser-PKCE flow (локальный сервер + авто-открытие браузера) ───────────
function openBrowser(url) {
  const win = process.platform === "win32";
  const cmd = process.platform === "darwin" ? "open" : win ? "start" : "xdg-open";
  // win32: `start` берёт первый аргумент как заголовок окна, а в authorize-URL есть `&` →
  // передаём пустой заголовок "" перед URL, иначе cmd.exe не откроет ссылку.
  const args = win ? ["", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, shell: win }).unref();
  } catch {
    /* нет графики (headless) — пользователь откроет ссылку сам */
  }
}

export async function runBrowserLogin({ dataDir = defaultDir(), log = console.log, open = true, lang = "en" } = {}) {
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(32));
  const port = await listenFirstFree([DEVICE_PORT, FALLBACK_PORT]);
  const redirectUri = `http://localhost:${port.port}/auth/callback`;
  const authorizeUrl =
    `${ISSUER}/oauth/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: ORIGINATOR,
    }).toString();

  log(`\n  ${tr(lang, "Open this in a browser and sign in to OpenAI:", "Открой в браузере и войди в OpenAI:")}\n  ${authorizeUrl}\n`);
  if (open) openBrowser(authorizeUrl);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      port.server.close();
      reject(new Error("browser login timed out (10 min)"));
    }, 10 * 60 * 1000);

    port.server.on("request", async (req, res) => {
      const url = new URL(req.url, `http://localhost:${port.port}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      const done = (code, msg) => {
        res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" }).end(`<h3>${msg}</h3>`);
      };
      try {
        if (url.searchParams.get("state") !== state) throw new Error("state mismatch");
        const err = url.searchParams.get("error");
        if (err) throw new Error(`OAuth error: ${err}`);
        const code = url.searchParams.get("code");
        if (!code) throw new Error("missing authorization code");
        const auth = toAuth(await exchangeCode({ code, verifier, redirectUri }));
        writeAuth(auth, dataDir);
        done(200, tr(lang, "Signed in — you can close this tab and return to the terminal.", "Готово — вход выполнен. Можно закрыть вкладку и вернуться в терминал."));
        clearTimeout(timer);
        port.server.close();
        resolve(auth);
      } catch (e) {
        done(400, `${tr(lang, "Sign-in error", "Ошибка входа")}: ${e.message}`);
        clearTimeout(timer);
        port.server.close();
        reject(e);
      }
    });
  });
}

// Пытается слушать порты по списку, возвращает первый свободный { server, port }.
function listenFirstFree(ports) {
  return new Promise((resolve, reject) => {
    const tryPort = (i) => {
      if (i >= ports.length) return reject(new Error("no free login port (1455/1457 busy)"));
      const server = createServer();
      server.once("error", () => tryPort(i + 1));
      server.listen(ports[i], "127.0.0.1", () => resolve({ server, port: ports[i] }));
    };
    tryPort(0);
  });
}

export async function login(mode = "device", opts = {}) {
  return mode === "browser" ? runBrowserLogin(opts) : runDeviceCodeLogin(opts);
}

// ── список моделей подписки (для мастера) ──────────────────────────────────
// Форма ответа (codex protocol): { models: [ { model: "gpt-5.1", id, display_name, ... } ] }.
// Идентификатор для запроса — поле `model` (slug), НЕ `id` (id пресета). Берём его, с фолбэками.
// Сортируем «новые сверху» (gpt-5.5 > gpt-5.1 > gpt-5). При 0 распознанных — бросаем ошибку
// с сырым телом, чтобы мастер показал реальную форму ответа (а не молча свалился в ручной ввод).
export async function listCodexModels({ dataDir = defaultDir() } = {}) {
  const headers = await codexAuthHeaders(dataDir);
  const res = await fetch(`${CODEX_BASE_URL}/models?client_version=${CLIENT_VERSION}`, { headers });
  if (!res.ok) throw new Error(`list models failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const arr = Array.isArray(json) ? json : json.models || json.data || json.model_presets || [];
  let slugs = arr.map((m) => (typeof m === "string" ? m : m?.model || m?.slug || m?.id || m?.name)).filter(Boolean);
  // Форма ответа могла измениться — рекурсивно ищем любой вложенный массив моделей.
  if (!slugs.length) slugs = deepFindModels(json);
  const uniq = [...new Set(slugs)];
  if (!uniq.length) throw new Error(`models endpoint returned no usable models — raw: ${JSON.stringify(json).slice(0, 500)}`);
  return uniq.sort(compareModelDesc);
}

// Рекурсивно собирает slug'и из любого вложенного массива объектов с полем model/slug
// (устойчиво к смене ключа-обёртки в ответе бэкенда).
function deepFindModels(node, out = []) {
  if (Array.isArray(node)) {
    for (const it of node) {
      if (it && typeof it === "object" && (it.model || it.slug)) out.push(it.model || it.slug);
      else deepFindModels(it, out);
    }
  } else if (node && typeof node === "object") {
    for (const k of Object.keys(node)) deepFindModels(node[k], out);
  }
  return out;
}

// «Новые сверху»: сравниваем числовую версию в slug (gpt-5.1 → 5.1), при равенстве — по имени.
function compareModelDesc(a, b) {
  const ver = (s) => parseFloat((String(s).match(/(\d+(?:\.\d+)?)/) || [])[1] || "0");
  return ver(b) - ver(a) || String(a).localeCompare(String(b));
}

// ── self-check (node scripts/lib/codex-oauth.mjs) — без сети ────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (c, m) => {
    if (!c) throw new Error(`self-check FAIL: ${m}`);
  };
  // PKCE: challenge = base64url(sha256(verifier))
  const { verifier, challenge } = pkce();
  assert(challenge === b64url(createHash("sha256").update(verifier).digest()), "pkce S256");
  assert(!/[+/=]/.test(challenge), "challenge is base64url");
  // JWT parse: собираем фейковый id_token с клеймом auth
  const header = b64url(JSON.stringify({ alg: "none" }));
  const payload = b64url(JSON.stringify({ exp: 9999999999, "https://api.openai.com/auth": { chatgpt_account_id: "acc_1", chatgpt_plan_type: "pro" } }));
  const jwt = `${header}.${payload}.sig`;
  assert(jwtExp(jwt) === 9999999999, "jwtExp");
  assert(accountFromIdToken(jwt).accountId === "acc_1", "accountId");
  assert(accountFromIdToken(jwt).planType === "pro", "planType");
  assert(accountFromIdToken("garbage").accountId === null, "bad id_token → null");
  // Разбор списка моделей: slug из поля `model`, сортировка «новые сверху».
  const models = [{ model: "gpt-5" }, { model: "gpt-5.1" }, { id: "preset-x", model: "gpt-5.1-codex" }];
  const parsed = [...new Set(models.map((m) => m.model || m.slug || m.id || m.name).filter(Boolean))].sort(compareModelDesc);
  assert(parsed[0].startsWith("gpt-5.1"), `newest first, got ${parsed[0]}`);
  assert(parsed.includes("gpt-5"), "keeps gpt-5");
  // deepFindModels: устойчивость к смене ключа-обёртки.
  assert(deepFindModels({ result: { items: [{ model: "gpt-5.1" }, { slug: "gpt-6" }] } }).length === 2, "deepFindModels nested");
  assert(deepFindModels({ tiers: [{ id: "flex" }] }).length === 0, "deepFind ignores non-model arrays");
  assert(tr("ru", "en", "ру") === "ру" && tr("en", "en", "ру") === "en", "tr lang");
  console.log("codex-oauth self-check ok");
}
