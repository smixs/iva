// Экран «Userbot» меню (/menu → 📡). Статус личного userbot-прокси (Telegram) + подключение.
// Статус — systemctl --user is-active/is-enabled iva-telegram-userbot.service (execFile,
// таймаут 1.5с, кэш 60с: единственный getUpdates-цикл моста нельзя блокировать дольше).
// Наличие creds — булевы TELEGRAM_API_ID/TELEGRAM_API_HASH из .env (значения не показываем).
//
// Секреты (api_id/api_hash) принимаются только в личке; сообщение с ними удаляет движок
// (secret:true) до texts.ubcred. Значения не попадают в лог/eve/текст. Пишем через upsertEnv.
// Включение — отсоединённый `iva userbot setup` (сборка venv медленная, до 3 мин): не ждём
// синхронно, показываем заглушку и перерисовываем экран по завершении.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { readEnvValues, upsertEnv } from "../env-file.mjs";

const SID = "ub";
const PARENT = "r";
const SVC = "iva-telegram-userbot.service";
const CACHE_TTL_MS = 60_000;
let cache = { at: 0, data: null };

const isPrivate = (st) => Number(st.chatId) > 0;

function run(cmd, args, timeout = 1500) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: "utf8" }, (err, stdout = "") =>
      resolve({ failed: Boolean(err), code: typeof err?.code === "number" ? err.code : err ? 1 : 0, stdout: String(stdout) }),
    );
  });
}

// Статус юнита: {active, enabled}. is-active даёт код 0/«active»; is-enabled печатает
// enabled/disabled/static… (код != 0 у disabled — берём stdout как метку). Кэш 60с.
async function probeStatus() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  // Параллельно: две последовательные пробы по 1.5с дали бы worst-case 3с блокировки
  // единственного getUpdates-цикла — параллель возвращает бюджет к 1.5с.
  const [a, e] = await Promise.all([
    run("systemctl", ["--user", "is-active", SVC]),
    run("systemctl", ["--user", "is-enabled", SVC]),
  ]);
  const data = {
    active: a.code === 0 || a.stdout.trim() === "active",
    enabled: e.stdout.trim() || (e.code === 0 ? "enabled" : "—"),
  };
  cache = { at: Date.now(), data };
  return data;
}

const invalidate = () => (cache = { at: 0, data: null });

// Единая сборка карты — используется и render(), и async-перерисовкой после setup.
async function buildScreen(st, ctx) {
  const T = ctx.tr;
  const env = await readEnvValues(ctx.deps.envPath);
  const hasCreds = Boolean(env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH);
  const status = await probeStatus();
  const head = T("📡 Telegram userbot", "📡 Telegram-userbot");
  const statusLine = T(
    `Service: ${status.active ? "active" : "inactive"} (${status.enabled})`,
    `Сервис: ${status.active ? "активен" : "неактивен"} (${status.enabled})`,
  );

  if (!hasCreds) {
    const text = [
      head,
      "",
      statusLine,
      "",
      T(
        "No API credentials yet. Create an app at https://my.telegram.org (API development tools) — you'll get api_id and api_hash.",
        "Ключей ещё нет. Создай приложение на https://my.telegram.org (API development tools) — получишь api_id и api_hash.",
      ),
    ].join("\n");
    return { text, rows: [[ctx.btn(T("Enter credentials", "Ввести ключи"), `iva_menu:${SID}:do:creds`)], ctx.backRow(PARENT)] };
  }

  if (!status.active) {
    const text = [
      head,
      "",
      statusLine,
      "",
      T("Credentials are set. Turn the proxy on — it builds a venv (up to ~3 min).", "Ключи заданы. Включи прокси — соберётся venv (до ~3 мин)."),
    ].join("\n");
    return {
      text,
      rows: [
        [ctx.btn(T("Turn on", "Включить"), `iva_menu:${SID}:do:setup`)],
        [ctx.btn(T("🔄 Refresh", "🔄 Обновить"), `iva_menu:${SID}:rf`)],
        ctx.backRow(PARENT),
      ],
    };
  }

  // Активен: подключение аккаунта — через QR у бота (флоу на стороне агента, не моста).
  const text = [
    head,
    "",
    statusLine,
    "",
    T(
      "Proxy is on. To connect your account, message the bot: «connect my telegram» — it replies with a QR to scan.",
      "Прокси включён. Чтобы подключить аккаунт — напиши боту: «подключи мой телеграм», он пришлёт QR для входа.",
    ),
  ].join("\n");
  return {
    text,
    rows: [
      [ctx.btn(T("Turn off", "Выключить"), `iva_menu:${SID}:do:off`), ctx.btn(T("🔄 Refresh", "🔄 Обновить"), `iva_menu:${SID}:rf`)],
      ctx.backRow(PARENT),
    ],
  };
}

// Приглашение ввести api_id или api_hash (двухшаговый секретный приём).
function promptCred(st, ctx, step) {
  st.awaitText = { kind: "ubcred", secret: true, data: { step } };
  const text = step === "api_id"
    ? ctx.tr("Send your api_id (a number). I'll delete the message right away.", "Пришли api_id (число). Сообщение сразу удалю.")
    : ctx.tr("Now send your api_hash. I'll delete the message right away.", "Теперь пришли api_hash. Сообщение сразу удалю.");
  return ctx.flows.screen(st, text, [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]]);
}

export default {
  parent: PARENT,

  render(st, ctx) {
    return buildScreen(st, ctx);
  },

  async on(verb, args, st, ctx) {
    if (verb !== "do") return ctx.show(st, SID);
    const step = args[0];

    if (step === "creds") {
      if (!isPrivate(st)) {
        st.awaitText = null;
        return ctx.flows.screen(
          st,
          ctx.tr("Credentials are secrets — open a private chat and enter them there.", "Ключи — это секрет. Открой личный чат и введи их там."),
          [ctx.backRow(PARENT)],
        );
      }
      st.data.ub = {};
      return promptCred(st, ctx, "api_id");
    }

    if (step === "setup") {
      const bin = join(ctx.deps.root, "bin/iva.mjs");
      // Отсоединённо: НЕ ждём (venv-сборка до 3 мин заблокировала бы poll-цикл). Перерисуем
      // экран по завершении — только если пользователь всё ещё на нём.
      run(process.execPath, [bin, "userbot", "setup"], 180_000)
        .then(async () => {
          invalidate();
          if (ctx.flows.get(st.chatId, st.userId) === st && st.screen === SID) {
            const v = await buildScreen(st, ctx);
            await ctx.flows.screen(st, v.text, v.rows);
          }
        })
        .catch((e) => ctx.deps.log?.("userbot setup error:", e.message));
      return ctx.flows.screen(
        st,
        ctx.tr("◇ Setting up the userbot proxy…", "◇ Собираю userbot-прокси…"),
        [ctx.backRow(PARENT)],
      );
    }

    if (step === "off") {
      await run("systemctl", ["--user", "disable", "--now", SVC]);
      invalidate();
      return ctx.show(st, SID);
    }
    return ctx.show(st, SID);
  },

  texts: {
    // Двухшаговый приём: сначала api_id (число), затем api_hash. Сообщения уже удалены движком.
    async ubcred(text, msg, st, ctx) {
      const value = String(text).trim();
      const step = st.awaitText?.data?.step;
      if (step === "api_id") {
        if (!/^\d+$/.test(value)) {
          return ctx.flows.screen(
            st,
            ctx.tr("api_id must be a number. Send it again or cancel.", "api_id должен быть числом. Пришли ещё раз или отмени."),
            [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]],
          );
        }
        st.data.ub = { apiId: value };
        return promptCred(st, ctx, "api_hash");
      }
      // api_hash: у Telegram это 32 hex-символа; принимаем непустой токен без пробелов.
      if (!/^\S{8,}$/.test(value)) {
        return ctx.flows.screen(
          st,
          ctx.tr("That doesn't look like an api_hash. Send it again or cancel.", "Это не похоже на api_hash. Пришли ещё раз или отмени."),
          [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]],
        );
      }
      const apiId = st.data.ub?.apiId;
      st.awaitText = null;
      st.data.ub = null;
      try {
        await upsertEnv(ctx.deps.envPath, { TELEGRAM_API_ID: apiId, TELEGRAM_API_HASH: value });
      } catch (e) {
        return ctx.flows.screen(
          st,
          ctx.tr(`Couldn't write .env: ${e.message}`, `Не удалось записать .env: ${e.message}`),
          [ctx.backRow(PARENT)],
        );
      }
      invalidate();
      // Ключи есть — экран покажет [Включить].
      return ctx.show(st, SID);
    },
  },
};
