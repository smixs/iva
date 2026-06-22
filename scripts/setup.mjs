#!/usr/bin/env node
// Iva interactive setup: writes .env.
// Step-by-step guide with per-key instructions, live validation, and a loop —
// the script will NOT exit until every required secret is entered.
// No external dependencies.
import { createInterface } from "node:readline/promises";
import { createReadStream } from "node:fs";
import { readFile, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defaultChecker, PortSelector } from "./lib/ports.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const OLLAMA_BASE = "https://ollama.com/v1";
const OPENCODE_BASE = "https://opencode.ai/zen/go/v1";
// OpenCode Go models (no /models endpoint — list is hardcoded; override in .env).
const OPENCODE_MODELS = [
  "opencode-go/deepseek-v4-pro",
  "opencode-go/deepseek-v4-flash",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/glm-5.2",
  "opencode-go/qwen3.7",
];

const C = { g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", b: "\x1b[1m", r: "\x1b[31m", x: "\x1b[0m" };
const TOTAL = 5;

// UI language (en|ru) — also becomes the agent's default reply language (AGENT_LANGUAGE).
// Set in main() once the choice is known; helpers below read it.
let LANG = "ru";
const t = (en, ru) => (LANG === "en" ? en : ru);
const KEEP = () => t("…(keep)", "…(оставить)");

// Read from tty even when launched via `curl | bash`.
const input = process.stdin.isTTY ? process.stdin : createReadStream("/dev/tty");
const rl = createInterface({ input, output: process.stdout });

const ask = async (q, def = "") => {
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def;
};
const askYesNo = async (q, def = false) => {
  const a = (await ask(`${q} (${def ? "Y/n" : "y/N"})`)).toLowerCase();
  return a ? a.startsWith("y") : def;
};

// Free-port selection: ask for the desired port, check availability with the same Probe as
// `check-port` (scripts/lib/ports.mjs); if taken, offer the nearest free one. Closes the root of a
// bug at setup time — the server won't start on an occupied port.
async function pickPort(def) {
  const checker = defaultChecker();
  for (;;) {
    const port = Number(await ask(`  ${t("Local eve-server port", "Порт локального eve-сервера")}`, String(def)));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.log(`  ${C.r}${t("Invalid port", "Некорректный порт")}${C.x} — ${t("must be a number 1..65535.", "нужно число 1..65535.")}`);
      continue;
    }
    const { occupied, holders } = await checker.check(port);
    if (!occupied) return String(port);
    const free = await new PortSelector(checker).firstFree(port + 1);
    const who = holders.length ? ` (${holders.join("; ")})` : "";
    console.log(`  ${C.y}${t(`Port ${port} is busy${who}.`, `Порт ${port} занят${who}.`)}${C.x}${free ? ` ${t("Nearest free", "Ближайший свободный")}: ${C.g}${free}${C.x}.` : ""}`);
    if (free && (await askYesNo(`  ${t(`Take ${free}?`, `Взять ${free}?`)}`, true))) return String(free);
    // otherwise loop — the user enters another port manually
  }
}
const mask = (s) => (s ? s.slice(0, 6) + KEEP() : "");
const hr = () => console.log(`${C.c}  ────────────────────────────────────────────${C.x}`);
const head = (n, title) => console.log(`\n${C.b}${C.c}  ${t("Step", "Шаг")} ${n}/${TOTAL}: ${title}${C.x}`);

// Repeats the question until it gets a non-empty and (if set) valid value.
async function askRequired(label, { help = "", existing = "", validate = null } = {}) {
  for (;;) {
    if (help) console.log(help);
    let a = await ask(label, existing ? mask(existing) : "");
    if (existing && (!a || a.endsWith(KEEP()))) a = existing;
    a = (a || "").trim();
    if (!a) {
      console.log(`${C.y}  ⚠ ${t("Required field — Iva won't run without it. Enter a value.", "Обязательное поле — без него Iva не заработает. Введите значение.")}${C.x}\n`);
      continue;
    }
    if (validate) {
      process.stdout.write(`  ${t("checking…", "проверяю…")} `);
      const err = await validate(a);
      if (err) {
        console.log(`${C.r}${t("not ok", "не ок")}${C.x}\n${C.y}  ⚠ ${err}${C.x}\n`);
        continue;
      }
      console.log(`${C.g}${t("ok", "ок")}${C.x}`);
    }
    return a;
  }
}

function parseEnv(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
async function loadExistingEnv() {
  try {
    await access(ENV_PATH);
    return parseEnv(await readFile(ENV_PATH, "utf8"));
  } catch {
    return {};
  }
}

// Writes .env in a stable key order.
async function writeEnv(out) {
  const order = [
    "AGENT_LANGUAGE",
    "MODEL_PROVIDER",
    "OLLAMA_API_KEY", "OLLAMA_MODEL", "OLLAMA_CONTEXT_WINDOW",
    "OPENCODE_API_KEY", "OPENCODE_MODEL", "OPENCODE_CONTEXT_WINDOW",
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS", "TELEGRAM_DIGEST_CHAT_ID",
    "DEEPGRAM_API_KEY", "DEEPGRAM_LANGUAGE",
    "SEARCH_PROVIDER",
    "TAVILY_API_KEY", "BRAVE_API_KEY", "EXA_API_KEY", "PARALLEL_API_KEY",
    "ASSISTANT_TIMEZONE", "ASSISTANT_VAULT_DIR",
    "ASSISTANT_DATA_DIR", "IVA_PORT", "ASSISTANT_HOST", "ASSISTANT_BEARER",
  ];
  const keys = [...order.filter((k) => out[k] != null), ...Object.keys(out).filter((k) => !order.includes(k))];
  await writeFile(ENV_PATH, keys.map((k) => `${k}=${out[k]}`).join("\n") + "\n", "utf8");
}

async function ollamaModels(key) {
  const res = await fetch(`${OLLAMA_BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("key rejected"), { auth: true });
  }
  if (!res.ok) throw new Error(`Ollama API returned ${res.status}`);
  return ((await res.json()).data || []).map((m) => m.id).sort();
}
async function opencodeCheck(key) {
  try {
    const res = await fetch(`${OPENCODE_BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (res.status === 401 || res.status === 403) {
      return t(
        "OpenCode rejected the key (401/403). Check your Go subscription and that the key was copied in full.",
        "OpenCode не принял ключ (401/403). Проверьте подписку Go и что ключ скопирован целиком.",
      );
    }
    return null; // 200/404 — key is at least well-formed
  } catch {
    return null; // network flaky — don't block
  }
}
async function deepgramCheck(key) {
  try {
    const res = await fetch("https://api.deepgram.com/v1/projects", {
      headers: { Authorization: `Token ${key}` },
    });
    if (res.status === 401 || res.status === 403) {
      return t(
        "Deepgram rejected the key (401/403). Copy the key in full from the API Keys page.",
        "Deepgram не принял ключ (401/403). Скопируйте ключ целиком со страницы API Keys.",
      );
    }
    return null;
  } catch {
    return null;
  }
}
async function telegramGetMe(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.description || "token rejected");
  return j.result;
}
async function fetchTelegramUserIds(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || "getUpdates failed");
  const seen = new Map();
  for (const u of json.result || []) {
    const m = u.message || u.edited_message;
    const f = m?.from;
    if (f && !seen.has(String(f.id))) {
      const name = [f.first_name, f.last_name, f.username ? `@${f.username}` : ""].filter(Boolean).join(" ");
      seen.set(String(f.id), { id: String(f.id), name: name || t("(no name)", "(без имени)") });
    }
  }
  return [...seen.values()];
}

// Pick from a list by number (with a default). Returns the chosen item.
async function pickFromList(items, current, recommended) {
  items.forEach((id, i) =>
    console.log(`   ${String(i + 1).padStart(2)}. ${id}${id === recommended ? `  ${C.g}★${C.x}` : ""}`),
  );
  const curIdx = items.indexOf(current);
  const recIdx = items.indexOf(recommended);
  const defNum = (curIdx >= 0 ? curIdx : Math.max(0, recIdx)) + 1;
  const ch = await ask(`\n  ${t("Model number", "Номер модели")}`, String(defNum || 1));
  let idx = parseInt(ch, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= items.length) idx = defNum - 1;
  return items[idx];
}

async function main() {
  const existing = await loadExistingEnv();
  const out = { ...existing };

  // ── Language: UI + agent's default reply language ─────────────────
  // install.sh спрашивает язык ПЕРВЫМ и прокидывает через окружение (AGENT_LANGUAGE) —
  // тогда не спрашиваем повторно. При самостоятельном `npm run setup` env пуст → спросим.
  const envLang = (process.env.AGENT_LANGUAGE || "").toLowerCase();
  if (envLang === "en" || envLang === "ru") {
    LANG = envLang;
  } else {
    console.log(`\n${C.b}${C.c}  🌐 Language / Язык${C.x}`);
    console.log("    1) English");
    console.log("    2) Русский");
    const langChoice = await ask("  Choose / Выбор (1/2)", existing.AGENT_LANGUAGE === "ru" ? "2" : "1");
    LANG = langChoice.trim() === "2" ? "ru" : "en";
  }
  out.AGENT_LANGUAGE = LANG;
  console.log(`  → ${t("Iva will reply in English by default.", "Iva будет отвечать по-русски по умолчанию.")}`);

  // Already configured? Don't walk every step — ask once.
  const prov0 = existing.MODEL_PROVIDER || "ollama";
  const provKey = prov0 === "opencode" ? "OPENCODE_API_KEY" : "OLLAMA_API_KEY";
  const provModel = prov0 === "opencode" ? "OPENCODE_MODEL" : "OLLAMA_MODEL";
  const REQUIRED = [provKey, provModel, "DEEPGRAM_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS"];
  const isComplete = REQUIRED.every((k) => (existing[k] || "").trim());
  if (isComplete) {
    console.log(`\n${C.b}${C.g}  ${t("Iva is already configured:", "Iva уже настроена:")}${C.x}`);
    console.log(`  • ${t("Provider", "Провайдер")}: ${prov0}`);
    console.log(`  • ${t("Model", "Модель")}:    ${existing[provModel]}`);
    console.log(`  • ${t("Bot", "Бот")}:       @${existing.TELEGRAM_BOT_USERNAME || "?"}`);
    console.log(`  • ${t("Access", "Доступ")}:    ${existing.TELEGRAM_ALLOWED_USER_IDS}`);
    console.log(`  • Deepgram:  ${existing.DEEPGRAM_LANGUAGE || "multi"}   ·   TZ: ${existing.ASSISTANT_TIMEZONE || "?"}`);
    if (!(await askYesNo(`\n  ${t("Reconfigure from scratch?", "Перенастроить заново?")}`, false))) {
      await writeEnv(out); // persist the language choice even when keeping everything else
      console.log(`${C.g}  ${t("Keeping current settings — nothing to enter.", "Оставляю текущие настройки как есть — ничего вводить не нужно.")}${C.x}`);
      rl.close();
      return;
    }
    console.log(`\n  ${t("Going step by step.", "Идём по шагам.")} ${C.y}${t("Enter at each step keeps the current value.", "Enter на каждом шаге оставит текущее значение.")}${C.x}`);
  } else {
    console.log(`\n${C.b}${C.g}  ${t("Iva setup — entering secrets step by step", "Настройка Iva — вводим секреты по шагам")}${C.x}`);
    console.log(`  ${t("Takes a couple of minutes. For each key I'll tell you where to get it and check it on the spot.", "Займёт пару минут. Для каждого ключа подскажу, где его взять, и проверю на месте.")}`);
    console.log(`  ${C.y}${t("The script won't exit until you've entered every required secret.", "Скрипт не завершится, пока вы не введёте все обязательные секреты.")}${C.x}`);
  }

  // ── Step 1: model provider + model ────────────────────────────────
  head(1, t("Provider and model — Iva's brain", "Провайдер и модель — мозг Iva"));
  console.log(`  ${t("Who to reach the model through:", "Через кого ходить к модели:")}`);
  console.log(`    1) Ollama Cloud — ${C.c}https://ollama.com${C.x} ${t("(~$20/mo, higher limits)", "(~$20/мес, лимиты побольше)")}`);
  console.log(`    2) OpenCode Zen — ${C.c}https://opencode.ai${C.x} ${t("(Go ~$5/mo, cheaper)", "(Go ~$5/мес, дешевле)")}`);
  const provChoice = await ask(`  ${t("Provider", "Провайдер")} (1/2)`, prov0 === "opencode" ? "2" : "1");
  const provider = provChoice.trim() === "2" ? "opencode" : "ollama";
  out.MODEL_PROVIDER = provider;

  if (provider === "ollama") {
    console.log(`\n  ${t("Ollama key", "Ключ Ollama")}: ${C.c}https://ollama.com/settings/keys${C.x} (Settings → Keys → Create key)`);
    let models = [];
    out.OLLAMA_API_KEY = await askRequired(`  ${t("Paste the Ollama key", "Вставьте ключ Ollama")}`, {
      existing: process.env.OLLAMA_API_KEY || existing.OLLAMA_API_KEY || "",
      validate: async (k) => {
        try {
          models = await ollamaModels(k);
          return null;
        } catch (e) {
          return e.auth
            ? t("Ollama rejected the key. Copy it again (no spaces).", "Ollama не принял ключ. Скопируйте заново (без пробелов).")
            : t(`couldn't verify: ${e.message}`, `не смог проверить: ${e.message}`);
        }
      },
    });
    console.log(`\n  ${t("Models available", "Доступно моделей")}: ${models.length}. ${t("I recommend", "Рекомендую")} ${C.g}deepseek-v4-pro${C.x}.`);
    out.OLLAMA_MODEL = await pickFromList(models, out.OLLAMA_MODEL, "deepseek-v4-pro");
    out.OLLAMA_CONTEXT_WINDOW = out.OLLAMA_CONTEXT_WINDOW || "131072";
    console.log(`  → ${t("model", "модель")}: ${C.g}${out.OLLAMA_MODEL}${C.x}`);
  } else {
    console.log(`\n  ${t("OpenCode key", "Ключ OpenCode")}: ${C.c}https://opencode.ai/auth${C.x} ${t("(subscribe to Go → copy the API key).", "(подпишитесь на Go → скопируйте API key).")}`);
    out.OPENCODE_API_KEY = await askRequired(`  ${t("Paste the OpenCode API key", "Вставьте OpenCode API key")}`, {
      existing: process.env.OPENCODE_API_KEY || existing.OPENCODE_API_KEY || "",
      validate: opencodeCheck,
    });
    console.log(`\n  ${t("OpenCode Go models:", "Модели OpenCode Go:")}`);
    out.OPENCODE_MODEL = await pickFromList(OPENCODE_MODELS, out.OPENCODE_MODEL, OPENCODE_MODELS[0]);
    out.OPENCODE_CONTEXT_WINDOW = out.OPENCODE_CONTEXT_WINDOW || "131072";
    console.log(`  → ${t("model", "модель")}: ${C.g}${out.OPENCODE_MODEL}${C.x}`);
  }
  console.log(
    `  ${C.y}${t("Don't inflate the context window:", "Окно контекста не завышайте:")}${C.x} ${t("compaction computes its threshold from it; an inflated window risks overflow.", "компактация считает порог от него; завышенное окно = риск переполнения.")}`,
  );

  // ── Step 2: Deepgram (voice/video) ────────────────────────────────
  head(2, t("Deepgram — voice and video transcription", "Deepgram — расшифровка голоса и видео"));
  console.log(`  ${t("Where to get the key", "Где взять ключ")}: ${C.c}https://console.deepgram.com${C.x}`);
  console.log(`    1) ${t("sign up (free starter credit)", "зарегистрируйтесь (дают бесплатный стартовый кредит)")}`);
  console.log("    2) API Keys → Create a New API Key");
  console.log(`    3) ${t("copy the key", "скопируйте ключ")}`);
  out.DEEPGRAM_API_KEY = await askRequired(`  ${t("Paste the Deepgram API key", "Вставьте Deepgram API key")}`, {
    existing: process.env.DEEPGRAM_API_KEY || existing.DEEPGRAM_API_KEY || "",
    validate: deepgramCheck,
  });
  out.DEEPGRAM_LANGUAGE = await ask(`  ${t("Recognition language (multi = auto ru/uz/en)", "Язык распознавания (multi = авто ru/uz/en)")}`, out.DEEPGRAM_LANGUAGE || "multi");

  // ── Web search: provider + key ────────────────────────────────────
  // Without a key for the chosen provider web_search is off (DuckDuckGo gives a captcha from a server IP).
  console.log(`\n  ${C.b}${t("Web search", "Веб-поиск")}${C.x} — ${t("so Iva can search the internet (Enter on the key — skip, search stays off).", "чтобы Iva искала в интернете (Enter на ключе — пропустить, поиск будет выключен).")}`);
  const SEARCH = [
    { id: "tavily", key: "TAVILY_API_KEY", url: "https://app.tavily.com", note: t("free ~1000/mo, no card, has answer ★", "free ~1000/мес, без карты, есть answer ★") },
    { id: "exa", key: "EXA_API_KEY", url: "https://dashboard.exa.ai", note: t("free ~20k/mo, no card", "free ~20k/мес, без карты") },
    { id: "parallel", key: "PARALLEL_API_KEY", url: "https://platform.parallel.ai", note: t("starter credits, no card", "стартовые кредиты, без карты") },
    { id: "brave", key: "BRAVE_API_KEY", url: "https://api-dashboard.search.brave.com", note: t("card required (verification), ~$5/mo credit", "нужна карта (идентификация), ~$5/мес кредит") },
  ];
  SEARCH.forEach((s, i) => console.log(`   ${i + 1}. ${s.id}  ${C.c}${s.url}${C.x}  ${C.y}(${s.note})${C.x}`));
  const curSearch = existing.SEARCH_PROVIDER || out.SEARCH_PROVIDER || "tavily";
  const defIdx = Math.max(0, SEARCH.findIndex((s) => s.id === curSearch));
  const chSearch = await ask(`  ${t("Search provider (number)", "Провайдер поиска (номер)")}`, String(defIdx + 1));
  let si = parseInt(chSearch, 10) - 1;
  if (isNaN(si) || si < 0 || si >= SEARCH.length) si = defIdx;
  const sprov = SEARCH[si];
  out.SEARCH_PROVIDER = sprov.id;
  console.log(`  ${t("Key for", "Ключ")} ${sprov.id}: ${C.c}${sprov.url}${C.x}${sprov.id === "brave" ? `  ${C.y}${t("(card required)", "(потребуется карта)")}${C.x}` : ""}. ${t("Enter — skip.", "Enter — пропустить.")}`);
  const keyExisting = process.env[sprov.key] || existing[sprov.key] || out[sprov.key] || "";
  let kv = await ask(`  ${sprov.id} API key`, keyExisting ? mask(keyExisting) : "");
  if (keyExisting && (!kv || kv.endsWith(KEEP()))) kv = keyExisting;
  out[sprov.key] = (kv || "").trim();

  // ── Step 3: Telegram bot ──────────────────────────────────────────
  head(3, t("Telegram bot — how you talk to Iva", "Telegram-бот — через него вы говорите с Iva"));
  console.log(`  ${t("Create a bot via @BotFather in Telegram:", "Создайте бота у @BotFather в Telegram:")}`);
  console.log(`    1) ${t("open a chat with @BotFather", "откройте чат с @BotFather")}`);
  console.log(`    2) ${t("send /newbot", "отправьте /newbot")}`);
  console.log(`    3) ${t("set the bot's name and username", "задайте имя и username бота")}`);
  console.log(`    4) ${t("copy the token like 123456789:ABCdef...", "скопируйте token вида 123456789:ABCdef...")}`);
  let me = null;
  out.TELEGRAM_BOT_TOKEN = await askRequired(`  ${t("Paste the Bot token", "Вставьте Bot token")}`, {
    existing: existing.TELEGRAM_BOT_TOKEN || "",
    validate: async (token) => {
      try {
        me = await telegramGetMe(token);
        return null;
      } catch (e) {
        return t(`Telegram rejected the token (${e.message}). Copy it again from @BotFather.`, `Telegram не принял токен (${e.message}). Скопируйте заново у @BotFather.`);
      }
    },
  });
  out.TELEGRAM_BOT_USERNAME =
    me?.username || out.TELEGRAM_BOT_USERNAME || (await ask(`  ${t("Bot username (without @)", "Username бота (без @)")}`, existing.TELEGRAM_BOT_USERNAME || ""));
  if (me?.username) console.log(`  → ${t("bot", "бот")}: ${C.g}@${me.username}${C.x}`);
  out.TELEGRAM_WEBHOOK_SECRET_TOKEN = existing.TELEGRAM_WEBHOOK_SECRET_TOKEN || randomBytes(24).toString("hex");

  // ── Step 4: trusted users (loop until ≥1 ID) ──────────────────────
  head(4, t("Access — who the bot answers at all", "Доступ — кому бот вообще отвечает"));
  console.log(`  ${C.y}${t("IMPORTANT:", "ВАЖНО:")}${C.x} ${t("Iva answers ONLY trusted Telegram IDs.", "Iva отвечает ТОЛЬКО доверенным Telegram ID.")}`);
  console.log(`  ${t("Without at least one ID the bot stays silent to everyone (that's how your data is protected).", "Без хотя бы одного ID бот промолчит всем (так ваши данные защищены).")}`);
  const ids = new Set(
    (existing.TELEGRAM_ALLOWED_USER_IDS || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
  );
  while (ids.size === 0) {
    console.log(
      `\n  ${t("Let's find your ID.", "Определим ваш ID.")} ${C.c}${t(`Open Telegram, find @${out.TELEGRAM_BOT_USERNAME || "your_bot"} and send it any message`, `Откройте Telegram, найдите @${out.TELEGRAM_BOT_USERNAME || "своего_бота"} и напишите ему любое сообщение`)}${C.x} ${t('(e.g. "hi").', "(напр. «привет»).")}`,
    );
    await ask(`  ${t("Sent the bot a message? press Enter", "Написали боту? нажмите Enter")}`);
    try {
      const found = await fetchTelegramUserIds(out.TELEGRAM_BOT_TOKEN);
      if (found.length) {
        console.log(`  ${t("Found who messaged the bot:", "Нашёл, кто писал боту:")}`);
        found.forEach((u, i) => console.log(`   ${i + 1}. ${u.id}  ${u.name}`));
        const pick = await ask(`  ${t("Which IDs to add? numbers comma-separated (Enter — add all)", "Чьи ID добавить? номера через запятую (Enter — добавить всех)")}`, "");
        const chosen = pick
          ? pick.split(/[,\s]+/).map((n) => found[parseInt(n, 10) - 1]).filter(Boolean)
          : found;
        chosen.forEach((u) => ids.add(u.id));
      } else {
        console.log(`${C.y}  ${t("I see no messages to the bot. Did you definitely send one? (if a webhook is set, getUpdates returns nothing)", "Не вижу сообщений боту. Точно написали? (если уже стоит вебхук — getUpdates не отдаёт апдейты)")}${C.x}`);
      }
    } catch (e) {
      console.log(`${C.y}  ${t(`Couldn't fetch updates: ${e.message}`, `Не смог получить апдейты: ${e.message}`)}${C.x}`);
    }
    if (ids.size === 0) {
      const manual = await ask(
        `  ${t("Enter your Telegram ID manually (find it: message @userinfobot), or Enter — try again", "Введите свой Telegram ID вручную (узнать: напишите @userinfobot), или Enter — попробовать снова")}`,
        "",
      );
      manual.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).forEach((s) => ids.add(s));
    }
  }
  out.TELEGRAM_ALLOWED_USER_IDS = [...ids].join(",");
  out.TELEGRAM_DIGEST_CHAT_ID = existing.TELEGRAM_DIGEST_CHAT_ID || [...ids][0] || "";
  console.log(`  → ${t("access granted to ID", "доступ разрешён ID")}: ${C.g}${out.TELEGRAM_ALLOWED_USER_IDS}${C.x}`);

  // ── Step 5: timezone, vault, port ─────────────────────────────────
  head(5, t("Timezone and memory storage", "Часовой пояс и хранилище памяти"));
  console.log(`  ${t("The timezone lets Iva use your real local time, not the server's.", "Часовой пояс нужен, чтобы Iva понимала ваше реальное время, а не время сервера.")}`);
  out.ASSISTANT_TIMEZONE = await ask(
    `  ${t("Timezone (IANA, e.g. Asia/Almaty, Asia/Tashkent, Europe/Berlin)", "Часовой пояс (IANA, напр. Asia/Almaty, Asia/Tashkent, Europe/Moscow)")}`,
    out.ASSISTANT_TIMEZONE || "Asia/Almaty",
  );
  out.ASSISTANT_VAULT_DIR = await ask(`  ${t("Vault directory (memory + git backup)", "Каталог vault (память + git-бэкап)")}`, out.ASSISTANT_VAULT_DIR || "vault");
  out.ASSISTANT_DATA_DIR = out.ASSISTANT_DATA_DIR || "data";
  // Off-the-beaten-path port: 3000/8000/8080 are often taken on a typical VPS (docker etc.). The server
  // listens on IVA_PORT and clients (poll bridge, digest, rollups) reach it via ASSISTANT_HOST. We check
  // the chosen port is free — otherwise the server would die with EADDRINUSE (silent exit → bot is mute).
  out.IVA_PORT = await pickPort(out.IVA_PORT || "8723");
  out.ASSISTANT_HOST = out.ASSISTANT_HOST || `http://127.0.0.1:${out.IVA_PORT}`;

  // ── Write .env ────────────────────────────────────────────────────
  await writeEnv(out);

  const chosenModel = provider === "opencode" ? out.OPENCODE_MODEL : out.OLLAMA_MODEL;
  console.log();
  hr();
  console.log(`${C.g}${C.b}  ✓ ${t("Done — everything written to .env", "Готово — всё записано в .env")}${C.x}`);
  console.log(`  ${t("Provider", "Провайдер")}: ${provider} · ${t("Model", "Модель")}: ${C.g}${chosenModel}${C.x} · Deepgram: ${out.DEEPGRAM_LANGUAGE} · ${t("Bot", "Бот")}: ${C.g}@${out.TELEGRAM_BOT_USERNAME}${C.x}`);
  console.log(`  ${t("Access", "Доступ")}: ${out.TELEGRAM_ALLOWED_USER_IDS} · TZ: ${out.ASSISTANT_TIMEZONE} · vault: ${out.ASSISTANT_VAULT_DIR} · ${t("lang", "язык")}: ${out.AGENT_LANGUAGE}`);
  hr();
  rl.close();
}

main().catch((e) => {
  console.error(`${C.r}${t("Setup aborted:", "Настройка прервана:")}${C.x}`, e?.message || e);
  process.exit(1);
});
