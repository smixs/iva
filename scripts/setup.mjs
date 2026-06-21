#!/usr/bin/env node
// Интерактивная настройка Iva: пишет .env.
// Пошаговый гайд с инструкциями откуда брать каждый ключ, живой валидацией и
// циклом — скрипт НЕ завершится, пока не введены все обязательные секреты.
// Без внешних зависимостей.
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
// Модели OpenCode Go (нет /models-эндпоинта — список зашит; можно поменять в .env).
const OPENCODE_MODELS = [
  "opencode-go/deepseek-v4-pro",
  "opencode-go/deepseek-v4-flash",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/glm-5.2",
  "opencode-go/qwen3.7",
];

const C = { g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", b: "\x1b[1m", r: "\x1b[31m", x: "\x1b[0m" };
const TOTAL = 5;

// Ввод из tty даже при запуске через `curl | bash`.
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

// Выбор свободного порта: спрашиваем желаемый, проверяем доступность теми же Probe,
// что и `check-port` (scripts/lib/ports.mjs); при занятости предлагаем ближайший свободный.
// Закрывает корень бага на этапе настройки — сервер не стартанёт на занятом порту.
async function pickPort(def) {
  const checker = defaultChecker();
  for (;;) {
    const port = Number(await ask("  Порт локального eve-сервера", String(def)));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.log(`  ${C.r}Некорректный порт${C.x} — нужно число 1..65535.`);
      continue;
    }
    const { occupied, holders } = await checker.check(port);
    if (!occupied) return String(port);
    const free = await new PortSelector(checker).firstFree(port + 1);
    const who = holders.length ? ` (${holders.join("; ")})` : "";
    console.log(`  ${C.y}Порт ${port} занят${who}.${C.x}${free ? ` Ближайший свободный: ${C.g}${free}${C.x}.` : ""}`);
    if (free && (await askYesNo(`  Взять ${free}?`, true))) return String(free);
    // иначе повторяем цикл — пользователь введёт другой порт вручную
  }
}
const mask = (s) => (s ? s.slice(0, 6) + "…(оставить)" : "");
const hr = () => console.log(`${C.c}  ────────────────────────────────────────────${C.x}`);
const head = (n, title) => console.log(`\n${C.b}${C.c}  Шаг ${n}/${TOTAL}: ${title}${C.x}`);

// Повторяет вопрос, пока не получит непустое и (если задано) валидное значение.
async function askRequired(label, { help = "", existing = "", validate = null } = {}) {
  for (;;) {
    if (help) console.log(help);
    let a = await ask(label, existing ? mask(existing) : "");
    if (existing && (!a || a.endsWith("…(оставить)"))) a = existing;
    a = (a || "").trim();
    if (!a) {
      console.log(`${C.y}  ⚠ Обязательное поле — без него Iva не заработает. Введите значение.${C.x}\n`);
      continue;
    }
    if (validate) {
      process.stdout.write("  проверяю… ");
      const err = await validate(a);
      if (err) {
        console.log(`${C.r}не ок${C.x}\n${C.y}  ⚠ ${err}${C.x}\n`);
        continue;
      }
      console.log(`${C.g}ок${C.x}`);
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

async function ollamaModels(key) {
  const res = await fetch(`${OLLAMA_BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("ключ отклонён"), { auth: true });
  }
  if (!res.ok) throw new Error(`Ollama API вернул ${res.status}`);
  return ((await res.json()).data || []).map((m) => m.id).sort();
}
async function opencodeCheck(key) {
  try {
    const res = await fetch(`${OPENCODE_BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (res.status === 401 || res.status === 403) {
      return "OpenCode не принял ключ (401/403). Проверьте подписку Go и что ключ скопирован целиком.";
    }
    return null; // 200/404 — ключ хотя бы валиден по форме
  } catch {
    return null; // сеть барахлит — не блокируем
  }
}
async function deepgramCheck(key) {
  try {
    const res = await fetch("https://api.deepgram.com/v1/projects", {
      headers: { Authorization: `Token ${key}` },
    });
    if (res.status === 401 || res.status === 403) {
      return "Deepgram не принял ключ (401/403). Скопируйте ключ целиком со страницы API Keys.";
    }
    return null;
  } catch {
    return null;
  }
}
async function telegramGetMe(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.description || "токен отклонён");
  return j.result;
}
async function fetchTelegramUserIds(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || "getUpdates не сработал");
  const seen = new Map();
  for (const u of json.result || []) {
    const m = u.message || u.edited_message;
    const f = m?.from;
    if (f && !seen.has(String(f.id))) {
      const name = [f.first_name, f.last_name, f.username ? `@${f.username}` : ""].filter(Boolean).join(" ");
      seen.set(String(f.id), { id: String(f.id), name: name || "(без имени)" });
    }
  }
  return [...seen.values()];
}

// Выбор из списка по номеру (с дефолтом). Возвращает выбранный элемент.
async function pickFromList(items, current, recommended) {
  items.forEach((id, i) =>
    console.log(`   ${String(i + 1).padStart(2)}. ${id}${id === recommended ? `  ${C.g}★${C.x}` : ""}`),
  );
  const curIdx = items.indexOf(current);
  const recIdx = items.indexOf(recommended);
  const defNum = (curIdx >= 0 ? curIdx : Math.max(0, recIdx)) + 1;
  const ch = await ask("\n  Номер модели", String(defNum || 1));
  let idx = parseInt(ch, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= items.length) idx = defNum - 1;
  return items[idx];
}

async function main() {
  const existing = await loadExistingEnv();
  const out = { ...existing };

  // Уже настроено? Не гоняем по шагам — спрашиваем один раз.
  const prov0 = existing.MODEL_PROVIDER || "ollama";
  const provKey = prov0 === "opencode" ? "OPENCODE_API_KEY" : "OLLAMA_API_KEY";
  const provModel = prov0 === "opencode" ? "OPENCODE_MODEL" : "OLLAMA_MODEL";
  const REQUIRED = [provKey, provModel, "DEEPGRAM_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS"];
  const isComplete = REQUIRED.every((k) => (existing[k] || "").trim());
  if (isComplete) {
    console.log(`\n${C.b}${C.g}  Iva уже настроена:${C.x}`);
    console.log(`  • Провайдер: ${prov0}`);
    console.log(`  • Модель:    ${existing[provModel]}`);
    console.log(`  • Бот:       @${existing.TELEGRAM_BOT_USERNAME || "?"}`);
    console.log(`  • Доступ:    ${existing.TELEGRAM_ALLOWED_USER_IDS}`);
    console.log(`  • Deepgram:  ${existing.DEEPGRAM_LANGUAGE || "multi"}   ·   TZ: ${existing.ASSISTANT_TIMEZONE || "?"}`);
    if (!(await askYesNo("\n  Перенастроить заново?", false))) {
      console.log(`${C.g}  Оставляю текущие настройки как есть — ничего вводить не нужно.${C.x}`);
      rl.close();
      return;
    }
    console.log(`\n  Идём по шагам. ${C.y}Enter на каждом шаге оставит текущее значение.${C.x}`);
  } else {
    console.log(`\n${C.b}${C.g}  Настройка Iva — вводим секреты по шагам${C.x}`);
    console.log("  Займёт пару минут. Для каждого ключа подскажу, где его взять, и проверю на месте.");
    console.log(`  ${C.y}Скрипт не завершится, пока вы не введёте все обязательные секреты.${C.x}`);
  }

  // ── Шаг 1: провайдер модели + модель ──────────────────────────────
  head(1, "Провайдер и модель — мозг Iva");
  console.log("  Через кого ходить к модели (оба работают с российского IP):");
  console.log(`    1) Ollama Cloud — ${C.c}https://ollama.com${C.x} (~$20/мес, лимиты побольше)`);
  console.log(`    2) OpenCode Zen — ${C.c}https://opencode.ai${C.x} (Go ~$5/мес, дешевле)`);
  const provChoice = await ask("  Провайдер (1/2)", prov0 === "opencode" ? "2" : "1");
  const provider = provChoice.trim() === "2" ? "opencode" : "ollama";
  out.MODEL_PROVIDER = provider;

  if (provider === "ollama") {
    console.log(`\n  Ключ Ollama: ${C.c}https://ollama.com/settings/keys${C.x} (Settings → Keys → Create key)`);
    let models = [];
    out.OLLAMA_API_KEY = await askRequired("  Вставьте ключ Ollama", {
      existing: process.env.OLLAMA_API_KEY || existing.OLLAMA_API_KEY || "",
      validate: async (k) => {
        try {
          models = await ollamaModels(k);
          return null;
        } catch (e) {
          return e.auth ? "Ollama не принял ключ. Скопируйте заново (без пробелов)." : `не смог проверить: ${e.message}`;
        }
      },
    });
    console.log(`\n  Доступно моделей: ${models.length}. Рекомендую ${C.g}deepseek-v4-pro${C.x}.`);
    out.OLLAMA_MODEL = await pickFromList(models, out.OLLAMA_MODEL, "deepseek-v4-pro");
    out.OLLAMA_CONTEXT_WINDOW = out.OLLAMA_CONTEXT_WINDOW || "131072";
    console.log(`  → модель: ${C.g}${out.OLLAMA_MODEL}${C.x}`);
  } else {
    console.log(`\n  Ключ OpenCode: ${C.c}https://opencode.ai/auth${C.x} (подпишитесь на Go → скопируйте API key).`);
    out.OPENCODE_API_KEY = await askRequired("  Вставьте OpenCode API key", {
      existing: process.env.OPENCODE_API_KEY || existing.OPENCODE_API_KEY || "",
      validate: opencodeCheck,
    });
    console.log("\n  Модели OpenCode Go:");
    out.OPENCODE_MODEL = await pickFromList(OPENCODE_MODELS, out.OPENCODE_MODEL, OPENCODE_MODELS[0]);
    out.OPENCODE_CONTEXT_WINDOW = out.OPENCODE_CONTEXT_WINDOW || "131072";
    console.log(`  → модель: ${C.g}${out.OPENCODE_MODEL}${C.x}`);
  }
  console.log(
    `  ${C.y}Окно контекста не завышайте:${C.x} компактация считает порог от него; завышенное окно = риск переполнения.`,
  );

  // ── Шаг 2: Deepgram (голос/видео) ─────────────────────────────────
  head(2, "Deepgram — расшифровка голоса и видео");
  console.log(`  Где взять ключ: ${C.c}https://console.deepgram.com${C.x}`);
  console.log("    1) зарегистрируйтесь (дают бесплатный стартовый кредит)");
  console.log("    2) API Keys → Create a New API Key");
  console.log("    3) скопируйте ключ");
  out.DEEPGRAM_API_KEY = await askRequired("  Вставьте Deepgram API key", {
    existing: process.env.DEEPGRAM_API_KEY || existing.DEEPGRAM_API_KEY || "",
    validate: deepgramCheck,
  });
  out.DEEPGRAM_LANGUAGE = await ask("  Язык распознавания (multi = авто ru/uz/en)", out.DEEPGRAM_LANGUAGE || "multi");

  // ── Шаг 3: Telegram-бот ───────────────────────────────────────────
  head(3, "Telegram-бот — через него вы говорите с Iva");
  console.log("  Создайте бота у @BotFather в Telegram:");
  console.log("    1) откройте чат с @BotFather");
  console.log("    2) отправьте /newbot");
  console.log("    3) задайте имя и username бота");
  console.log("    4) скопируйте token вида 123456789:ABCdef...");
  let me = null;
  out.TELEGRAM_BOT_TOKEN = await askRequired("  Вставьте Bot token", {
    existing: existing.TELEGRAM_BOT_TOKEN || "",
    validate: async (t) => {
      try {
        me = await telegramGetMe(t);
        return null;
      } catch (e) {
        return `Telegram не принял токен (${e.message}). Скопируйте заново у @BotFather.`;
      }
    },
  });
  out.TELEGRAM_BOT_USERNAME =
    me?.username || out.TELEGRAM_BOT_USERNAME || (await ask("  Username бота (без @)", existing.TELEGRAM_BOT_USERNAME || ""));
  if (me?.username) console.log(`  → бот: ${C.g}@${me.username}${C.x}`);
  out.TELEGRAM_WEBHOOK_SECRET_TOKEN = existing.TELEGRAM_WEBHOOK_SECRET_TOKEN || randomBytes(24).toString("hex");

  // ── Шаг 4: доверенные пользователи (цикл до ≥1 ID) ────────────────
  head(4, "Доступ — кому бот вообще отвечает");
  console.log(`  ${C.y}ВАЖНО:${C.x} Iva отвечает ТОЛЬКО доверенным Telegram ID.`);
  console.log("  Без хотя бы одного ID бот промолчит всем (так ваши данные защищены).");
  const ids = new Set(
    (existing.TELEGRAM_ALLOWED_USER_IDS || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
  );
  while (ids.size === 0) {
    console.log(
      `\n  Определим ваш ID. ${C.c}Откройте Telegram, найдите @${out.TELEGRAM_BOT_USERNAME || "своего_бота"} и напишите ему любое сообщение${C.x} (напр. «привет»).`,
    );
    await ask("  Написали боту? нажмите Enter");
    try {
      const found = await fetchTelegramUserIds(out.TELEGRAM_BOT_TOKEN);
      if (found.length) {
        console.log("  Нашёл, кто писал боту:");
        found.forEach((u, i) => console.log(`   ${i + 1}. ${u.id}  ${u.name}`));
        const pick = await ask("  Чьи ID добавить? номера через запятую (Enter — добавить всех)", "");
        const chosen = pick
          ? pick.split(/[,\s]+/).map((n) => found[parseInt(n, 10) - 1]).filter(Boolean)
          : found;
        chosen.forEach((u) => ids.add(u.id));
      } else {
        console.log(`${C.y}  Не вижу сообщений боту. Точно написали? (если уже стоит вебхук — getUpdates не отдаёт апдейты)${C.x}`);
      }
    } catch (e) {
      console.log(`${C.y}  Не смог получить апдейты: ${e.message}${C.x}`);
    }
    if (ids.size === 0) {
      const manual = await ask(
        "  Введите свой Telegram ID вручную (узнать: напишите @userinfobot), или Enter — попробовать снова",
        "",
      );
      manual.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).forEach((s) => ids.add(s));
    }
  }
  out.TELEGRAM_ALLOWED_USER_IDS = [...ids].join(",");
  out.TELEGRAM_DIGEST_CHAT_ID = existing.TELEGRAM_DIGEST_CHAT_ID || [...ids][0] || "";
  console.log(`  → доступ разрешён ID: ${C.g}${out.TELEGRAM_ALLOWED_USER_IDS}${C.x}`);

  // ── Шаг 5: часовой пояс и vault ───────────────────────────────────
  head(5, "Часовой пояс и хранилище памяти");
  console.log("  Часовой пояс нужен, чтобы Iva понимала ваше реальное время, а не время сервера.");
  out.ASSISTANT_TIMEZONE = await ask(
    "  Часовой пояс (IANA, напр. Asia/Almaty, Asia/Tashkent, Europe/Moscow)",
    out.ASSISTANT_TIMEZONE || "Asia/Almaty",
  );
  out.ASSISTANT_VAULT_DIR = await ask("  Каталог vault (память + git-бэкап)", out.ASSISTANT_VAULT_DIR || "vault");
  out.ASSISTANT_DATA_DIR = out.ASSISTANT_DATA_DIR || "data";
  // Непопсовый порт: 3000/8000/8080 на типовом VPS заняты (docker и т.п.). Сервер слушает IVA_PORT,
  // а клиенты (poll-мост, дайджест, роллапы) ходят на него же через ASSISTANT_HOST. Проверяем,
  // что выбранный порт свободен, — иначе сервер упал бы с EADDRINUSE (тихий выход → бот молчит).
  out.IVA_PORT = await pickPort(out.IVA_PORT || "8723");
  out.ASSISTANT_HOST = out.ASSISTANT_HOST || `http://127.0.0.1:${out.IVA_PORT}`;

  // ── Запись .env ───────────────────────────────────────────────────
  const order = [
    "MODEL_PROVIDER",
    "OLLAMA_API_KEY", "OLLAMA_MODEL", "OLLAMA_CONTEXT_WINDOW",
    "OPENCODE_API_KEY", "OPENCODE_MODEL", "OPENCODE_CONTEXT_WINDOW",
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS", "TELEGRAM_DIGEST_CHAT_ID",
    "DEEPGRAM_API_KEY", "DEEPGRAM_LANGUAGE",
    "ASSISTANT_TIMEZONE", "ASSISTANT_VAULT_DIR",
    "ASSISTANT_DATA_DIR", "IVA_PORT", "ASSISTANT_HOST", "ASSISTANT_BEARER",
  ];
  const keys = [...order.filter((k) => out[k] != null), ...Object.keys(out).filter((k) => !order.includes(k))];
  const body = keys.map((k) => `${k}=${out[k]}`).join("\n") + "\n";
  await writeFile(ENV_PATH, body, "utf8");

  const chosenModel = provider === "opencode" ? out.OPENCODE_MODEL : out.OLLAMA_MODEL;
  console.log();
  hr();
  console.log(`${C.g}${C.b}  ✓ Готово — всё записано в .env${C.x}`);
  console.log(`  Провайдер: ${provider} · Модель: ${C.g}${chosenModel}${C.x} · Deepgram: ${out.DEEPGRAM_LANGUAGE} · Бот: ${C.g}@${out.TELEGRAM_BOT_USERNAME}${C.x}`);
  console.log(`  Доступ: ${out.TELEGRAM_ALLOWED_USER_IDS} · TZ: ${out.ASSISTANT_TIMEZONE} · vault: ${out.ASSISTANT_VAULT_DIR}`);
  hr();
  rl.close();
}

main().catch((e) => {
  console.error(`${C.r}Настройка прервана:${C.x}`, e?.message || e);
  process.exit(1);
});
