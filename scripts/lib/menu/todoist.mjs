// Экран «Todoist» меню (/menu → ✅). Подключение Todoist через личный API-токен.
// Источник правды по операциям/кодам — agent/skills/todoist.md (коды выхода CLI: 0 ок ·
// 1 ошибка API · 2 НЕ авторизован · 3 неверные аргументы). Проба `todoist auth` ограничена
// 2с и кэшируется на 60с (единственный getUpdates-цикл моста нельзя блокировать дольше).
//
// API-токен — секрет: принимаем текстом только в личке (сообщение удаляет движок, secret:true),
// содержимое НЕ печатаем/не логируем; пишем файл 0600 в ~/.config/iva-todoist/token.
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const SID = "td";
const PARENT = "r";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = join(ROOT, "scripts/todoist.mjs");
const CONFIG_DIR = join(homedir(), ".config/iva-todoist");
const TOKEN_FILE = join(CONFIG_DIR, "token");
const CACHE_TTL_MS = 60_000;
let cache = { at: 0, status: null };

const isPrivate = (st) => Number(st.chatId) > 0;

// Проба авторизации: `todoist auth` → код 0 (ok), 2 (unauth), иначе ошибка сети/API (треат как unauth
// с пометкой — но для меню достаточно ok/other). Неавторизованный CLI выходит с кодом 2 сразу.
function probeAuth() {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, "auth"], { timeout: 2000, encoding: "utf8", cwd: ROOT }, (err) => {
      const code = typeof err?.code === "number" ? err.code : err ? 1 : 0;
      resolve(code === 0 ? "ok" : code === 2 ? "unauth" : "error");
    });
  });
}

// Cached auth status ("ok" | "unauth" | "error"), refreshed at most once per CACHE_TTL_MS.
async function authStatus() {
  if (cache.status && Date.now() - cache.at < CACHE_TTL_MS) return cache.status;
  const status = await probeAuth();
  cache = { at: Date.now(), status };
  return status;
}

// Drop the cached status so the next render re-probes (after connect/disconnect or a manual check).
const invalidate = () => (cache = { at: 0, status: null });

export default {
  parent: PARENT,

  async render(st, ctx) {
    const T = ctx.tr;
    const head = T("✅ Todoist", "✅ Todoist");
    const checkRow = [ctx.btn(T("Check again", "Проверить"), `iva_menu:${SID}:do:check`)];
    const s = await authStatus();

    if (s === "ok") {
      return {
        text: `${head}\n\n${T("✅ Connected. Tasks and reminders are available.", "✅ Подключено. Задачи и напоминания доступны.")}`,
        rows: [[ctx.btn(T("Disconnect", "Отключить"), `iva_menu:${SID}:do:logout`)], checkRow, ctx.backRow(PARENT)],
      };
    }
    if (s === "error") {
      return {
        text: [head, "", T("Todoist didn't respond (network or API). Try again in a moment.", "Todoist не ответил (сеть или API). Попробуй ещё раз чуть позже.")].join("\n"),
        rows: [checkRow, ctx.backRow(PARENT)],
      };
    }
    // unauth
    const text = [
      head,
      "",
      T("Not connected. Get a personal API token:", "Не подключено. Возьми личный API-токен:"),
      T("Todoist → Settings → Integrations → Developer → API token.", "Todoist → Settings → Integrations → Developer → API token."),
      "",
      T("Then send it here — I'll delete the message right away and store it securely.",
        "Затем пришли его сюда — сообщение сразу удалю, токен сохраню безопасно."),
    ].join("\n");
    return {
      text,
      rows: [[ctx.btn(T("Send token", "Прислать токен"), `iva_menu:${SID}:do:token`)], checkRow, ctx.backRow(PARENT)],
    };
  },

  async on(verb, args, st, ctx) {
    if (verb !== "do") return ctx.show(st, SID);
    const step = args[0];
    if (step === "check") invalidate();
    else if (step === "logout") {
      await writeFile(TOKEN_FILE, "", { mode: 0o600 }).catch(() => {});
      invalidate();
    } else if (step === "token") {
      if (!isPrivate(st)) {
        st.awaitText = null;
        return ctx.flows.screen(
          st,
          ctx.tr("The API token is sensitive — open a private chat and send it there.", "API-токен — секрет. Открой личный чат и пришли его там."),
          [ctx.backRow(PARENT)],
        );
      }
      st.awaitText = { kind: "tdtoken", secret: true };
      return ctx.flows.screen(
        st,
        ctx.tr(
          "Paste your Todoist API token. I'll delete the message right away and store it securely.",
          "Пришли API-токен Todoist. Сообщение сразу удалю, токен сохраню безопасно.",
        ),
        [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]],
      );
    }
    return ctx.show(st, SID);
  },

  texts: {
    // Приём токена текстом. Сообщение уже удалено движком (secret:true). Значение НЕ логируем.
    async tdtoken(text, msg, st, ctx) {
      const token = (text || "").trim();
      // Личный токен Todoist — компактная строка без пробелов. Не строгий hex-гейт (формат может
      // меняться), но отсекаем очевидный мусор/случайную вставку.
      if (!/^[A-Za-z0-9._-]{20,128}$/.test(token)) {
        st.awaitText = { kind: "tdtoken", secret: true };
        return ctx.flows.screen(
          st,
          ctx.tr("That doesn't look like an API token. Send it again or cancel.", "Это не похоже на API-токен. Пришли ещё раз или отмени."),
          [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]],
        );
      }
      st.awaitText = null;
      try {
        await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
        await writeFile(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
        await chmod(TOKEN_FILE, 0o600); // mode arg only applies on create — re-enforce on reconnect
      } catch {
        return ctx.flows.screen(
          st,
          ctx.tr("Couldn't store the token — check server permissions.", "Не смог сохранить токен — проверь права на сервере."),
          [ctx.backRow(PARENT)],
        );
      }
      invalidate();
      return ctx.show(st, SID);
    },
  },
};
