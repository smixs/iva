// Экран «Google» (gws) меню (/menu → 🔗). Подключение Google Workspace CLI `gws`.
// Источник правды по шагам/кодам — agent/skills/google-workspace.md (коды выхода gws:
// 0 ок · 1 ошибка API · 2 НЕ авторизован · 3 неверные аргументы; проверка подключения —
// `gws gmail +triage`). Проба execFile ограничена 1.5с и кэшируется на 60с (единственный
// getUpdates-цикл моста нельзя блокировать дольше).
//
// client_secret.json — секрет: принимаем текстом только в личке (сообщение удаляет движок,
// secret:true), содержимое НЕ печатаем/не логируем; пишем файл 0600.
import { existsSync } from "node:fs";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const SID = "gws";
const PARENT = "r";
const CONFIG_DIR = join(homedir(), ".config/gws");
const SECRET_PATH = join(CONFIG_DIR, "client_secret.json");
const LOGIN_CMD = "gws auth login -s gmail,calendar,drive"; // из google-workspace.md:64
const CACHE_TTL_MS = 60_000;
let cache = { at: 0, status: null };

const isPrivate = (st) => Number(st.chatId) > 0;

// Проба авторизации. Возвращает "missing" (нет бинаря gws), "unauth" (код 2) или "ok".
// Неавторизованный gws выходит с кодом 2 сразу (без сети); авторизованный `+triage` может
// не уложиться в 1.5с — таймаут трактуем как «похоже, подключено» (код != 2).
function probeAuth() {
  return new Promise((resolve) => {
    execFile("gws", ["gmail", "+triage"], { timeout: 1500, encoding: "utf8" }, (err) => {
      if (err && err.code === "ENOENT") return resolve("missing");
      const code = typeof err?.code === "number" ? err.code : err ? 1 : 0;
      resolve(code === 2 ? "unauth" : "ok");
    });
  });
}

async function authStatus() {
  if (cache.status && Date.now() - cache.at < CACHE_TTL_MS) return cache.status;
  const status = await probeAuth();
  cache = { at: Date.now(), status };
  return status;
}

const invalidate = () => (cache = { at: 0, status: null });

function instructions(ctx) {
  const T = ctx.tr;
  const text = [
    T("🔗 Google Workspace", "🔗 Google Workspace"),
    "",
    T(
      "No OAuth client yet. In a browser on your computer:",
      "OAuth-клиента ещё нет. В браузере на компьютере:",
    ),
    T(
      "1) console.cloud.google.com → create/pick a project.\n2) OAuth consent screen: External, add yourself to Test users.\n3) Credentials → Create → OAuth client ID → type Desktop app → Download JSON.",
      "1) console.cloud.google.com → создай/выбери проект.\n2) Экран согласия: External, добавь себя в Test users.\n3) Credentials → Create → OAuth client ID → тип Desktop app → скачай JSON.",
    ),
    "",
    T("Then paste the downloaded JSON here.", "Затем пришли содержимое скачанного JSON сюда."),
  ].join("\n");
  return { text, rows: [[ctx.btn(T("Send client JSON", "Прислать client JSON"), `iva_menu:${SID}:do:secret`)], ctx.backRow(PARENT)] };
}

export default {
  parent: PARENT,

  async render(st, ctx) {
    const T = ctx.tr;
    if (!existsSync(SECRET_PATH)) return instructions(ctx);

    const status = await authStatus();
    const head = T("🔗 Google Workspace", "🔗 Google Workspace");
    const checkRow = [ctx.btn(T("Check again", "Проверить"), `iva_menu:${SID}:do:check`)];

    if (status === "missing") {
      return {
        text: `${head}\n\n${T("The gws CLI isn't available on the server.", "CLI `gws` не найден на сервере.")}`,
        rows: [checkRow, ctx.backRow(PARENT)],
      };
    }
    if (status === "unauth") {
      const text = [
        head,
        "",
        T("Client secret is in place, but gws isn't authorized yet.", "client_secret.json на месте, но gws ещё не авторизован."),
        "",
        T("Log in over SSH on the server:", "Войди по SSH на сервере:"),
        LOGIN_CMD,
        "",
        T("gws prints a link — open it in your browser and approve, then tap «Check again».", "gws напечатает ссылку — открой её в браузере и подтверди, затем нажми «Проверить»."),
      ].join("\n");
      return { text, rows: [checkRow, ctx.backRow(PARENT)] };
    }
    // ok
    return {
      text: `${head}\n\n${T("✅ Connected. Scopes: gmail, calendar, drive.", "✅ Подключено. Права: gmail, calendar, drive.")}`,
      rows: [checkRow, ctx.backRow(PARENT)],
    };
  },

  async on(verb, args, st, ctx) {
    if (verb !== "do") return ctx.show(st, SID);
    const step = args[0];

    if (step === "secret") {
      if (!isPrivate(st)) {
        st.awaitText = null;
        return ctx.flows.screen(
          st,
          ctx.tr("The client secret is sensitive — open a private chat and send it there.", "client_secret — секрет. Открой личный чат и пришли его там."),
          [ctx.backRow(PARENT)],
        );
      }
      st.awaitText = { kind: "gwsjson", secret: true, data: {} };
      return ctx.flows.screen(
        st,
        ctx.tr(
          "Paste the contents of client_secret.json as text. I'll delete the message right away and store the file securely.",
          "Пришли содержимое client_secret.json текстом. Сообщение сразу удалю, файл сохраню безопасно.",
        ),
        [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]],
      );
    }

    if (step === "check") {
      invalidate();
      return ctx.show(st, SID);
    }
    return ctx.show(st, SID);
  },

  texts: {
    // Приём client_secret.json текстом. Сообщение уже удалено движком (secret:true).
    // Содержимое НЕ логируем/не печатаем в чат ни при каком исходе; файл пишем 0600.
    async gwsjson(text, msg, st, ctx) {
      const raw = String(text).trim();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return ctx.flows.screen(
          st,
          ctx.tr("Couldn't parse that as JSON. Send the file contents again or cancel.", "Не удалось разобрать JSON. Пришли содержимое файла ещё раз или отмени."),
          [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]],
        );
      }
      // Форма client_secret.json: корневой ключ installed (Desktop app) или web, с client_id.
      const node = parsed?.installed || parsed?.web;
      if (!node || typeof node.client_id !== "string" || !node.client_id) {
        return ctx.flows.screen(
          st,
          ctx.tr(
            "That doesn't look like a client_secret.json (need an installed/web section with client_id). Send it again or cancel.",
            "Это не похоже на client_secret.json (нужен раздел installed/web с client_id). Пришли ещё раз или отмени.",
          ),
          [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]],
        );
      }
      st.awaitText = null;
      try {
        await mkdir(CONFIG_DIR, { recursive: true });
        await writeFile(SECRET_PATH, raw, { encoding: "utf8", mode: 0o600 });
        await chmod(SECRET_PATH, 0o600); // mode игнорируется, если файл уже существовал
      } catch (e) {
        return ctx.flows.screen(
          st,
          ctx.tr(`Couldn't save the file: ${e.message}`, `Не удалось сохранить файл: ${e.message}`),
          [ctx.backRow(PARENT)],
        );
      }
      invalidate();
      return ctx.flows.screen(
        st,
        ctx.tr(
          `Saved. Now log in over SSH: ${LOGIN_CMD} — then tap «Check again».`,
          `Сохранил. Теперь войди по SSH: ${LOGIN_CMD} — затем нажми «Проверить».`,
        ),
        [[ctx.btn(ctx.tr("Check again", "Проверить"), `iva_menu:${SID}:do:check`)], ctx.backRow(PARENT)],
      );
    },
  },
};
