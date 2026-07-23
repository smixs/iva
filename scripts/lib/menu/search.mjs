// Экран «Поиск» меню (/menu → 🔍). Выбор веб-провайдера + приём/смена API-ключа.
//
// Инварианты ключей (как у /model-визарда telegram-poll.mjs:510-535): значение ключа
// НИКОГДА не попадает в лог/eve/текст ошибки. Удаление сообщения с ключом делает САМ
// движок (index.mjs onText, secret:true) ДО вызова texts.apikey — здесь не дублируем.
// Секретный приём разрешаем только в личке (проверка при установке awaitText — обязанность
// экрана). Смена SEARCH_PROVIDER применяется инструментом лишь после рестарта iva.service
// (web_search.ts читает process.env), поэтому после записи предлагаем restart-offer —
// plain sc("restart","iva.service"), НИКОГДА restartAgent (диалоги в .workflow-data живы).

import { readEnvValues, upsertEnv } from "../env-file.mjs";
import { SEARCH_CATALOG, checkSearchKey } from "../search-catalog.mjs";

const SID = "srch";
const PARENT = "r";
const DEFAULT_PROVIDER = "tavily"; // web_search.ts: провайдер по умолчанию, когда SEARCH_PROVIDER пуст

// Telegram: id личных чатов положительны, групп/супергрупп — отрицательны. Секреты
// принимаем только в личке (в группе бот может не иметь прав на удаление, и ключ увидят
// посторонние). st не хранит chat.type, поэтому опираемся на знак chatId — надёжно.
const isPrivate = (st) => Number(st.chatId) > 0;

// Текущий провайдер из .env (свежим чтением — снимок процесса устаревает после upsertEnv).
function currentProvider(env) {
  const p = env.SEARCH_PROVIDER;
  return p && SEARCH_CATALOG[p] ? p : DEFAULT_PROVIDER;
}

// Экран-приглашение ввести ключ: ставит awaitText (перехват следующего текста движком)
// и показывает, где взять ключ. secret:true — приём только в личке (иначе отказ).
async function promptKey(st, ctx, provider) {
  const cat = SEARCH_CATALOG[provider];
  if (!cat) return ctx.show(st, SID);
  if (!isPrivate(st)) {
    st.awaitText = null;
    return ctx.flows.screen(
      st,
      ctx.tr(
        "API keys are secrets — open a private chat with me and set the search key there.",
        "Ключи — это секрет. Открой личный чат со мной и введи ключ поиска там.",
      ),
      [ctx.backRow(PARENT)],
    );
  }
  st.awaitText = { kind: "apikey", secret: true, data: { provider, keyVar: cat.keyVar, returnScreen: SID } };
  const text = [
    ctx.tr(`${cat.label} search key`, `Ключ поиска ${cat.label}`),
    "",
    ctx.tr(
      "Send it in the next message — I'll delete it from the chat right away.",
      "Пришли его следующим сообщением — я сразу удалю его из чата.",
    ),
    ctx.tr(`Get your key at ${cat.url}`, `Ключ можно получить на ${cat.url}`),
  ].join("\n");
  // «Отмена» = вернуться на список (o перерисует экран и снимет awaitText в render).
  return ctx.flows.screen(st, text, [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]]);
}

// Экран «провайдер выбран — применить рестартом?»: после записи SEARCH_PROVIDER.
async function restartOffer(st, ctx, provider) {
  const cat = SEARCH_CATALOG[provider];
  const label = cat ? cat.label : provider;
  const text = [
    ctx.tr(`Search provider set: ${label}.`, `Провайдер поиска: ${label}.`),
    ctx.tr(
      "It applies after an agent restart (the search tool reads it at startup).",
      "Применится после перезапуска агента (инструмент поиска читает провайдера при старте).",
    ),
  ].join("\n");
  return ctx.flows.screen(st, text, [
    [
      ctx.btn(ctx.tr("Restart now", "Перезапустить сейчас"), `iva_menu:${SID}:rs:now`),
      ctx.btn(ctx.tr("Later", "Позже"), `iva_menu:${SID}:rs:later`),
    ],
    ctx.backRow(PARENT),
  ]);
}

export default {
  parent: PARENT,

  // Список провайдеров: ✓ у текущего, 🔑 при наличии ключа (только булевы — значения ключей
  // наружу не выводим). Свежее чтение .env на каждый рендер — состояние всегда актуально.
  async render(st, ctx) {
    st.awaitText = null; // возврат на список снимает возможный ждущий ввод ключа
    const env = await readEnvValues(ctx.deps.envPath);
    const current = currentProvider(env);
    const rows = Object.entries(SEARCH_CATALOG).map(([id, cat]) => {
      const mark = id === current ? "✓ " : "";
      const keyBadge = env[cat.keyVar] ? " 🔑" : "";
      return [ctx.btn(`${mark}${cat.label}${keyBadge}`, `iva_menu:${SID}:set:${id}`)];
    });
    // Сменить ключ текущего провайдера (даже если он уже есть).
    rows.push([ctx.btn(ctx.tr("🔁 Change key", "🔁 Сменить ключ"), `iva_menu:${SID}:key:${current}`)]);
    rows.push(ctx.backRow(PARENT));
    const text = [
      ctx.tr("🔍 Web search", "🔍 Веб-поиск"),
      "",
      ctx.tr(
        "Pick a provider. ✓ — current, 🔑 — its key is set. Tapping a provider without a key asks for one.",
        "Выбери провайдера. ✓ — текущий, 🔑 — ключ задан. Тап по провайдеру без ключа попросит его ввести.",
      ),
    ].join("\n");
    return { text, rows };
  },

  async on(verb, args, st, ctx) {
    if (verb === "set") {
      const provider = args[0];
      const cat = SEARCH_CATALOG[provider];
      if (!cat) return ctx.show(st, SID);
      const env = await readEnvValues(ctx.deps.envPath);
      if (!env[cat.keyVar]) return promptKey(st, ctx, provider); // нет ключа → приём
      await upsertEnv(ctx.deps.envPath, { SEARCH_PROVIDER: provider }); // ключ есть → просто переключаем
      return restartOffer(st, ctx, provider);
    }
    if (verb === "key") {
      // «Сменить ключ» — приём ключа для указанного провайдера независимо от наличия.
      const provider = SEARCH_CATALOG[args[0]] ? args[0] : currentProvider(await readEnvValues(ctx.deps.envPath));
      return promptKey(st, ctx, provider);
    }
    if (verb === "rs") {
      if (args[0] === "now") {
        // plain restart — не restartAgent(): смена конфигурации не «сброс», диалоги живут.
        const ok = await ctx.deps.sc("restart", "iva.service");
        return ctx.flows.end(
          st,
          ok
            ? ctx.tr("♻️ Restarting the agent — the new provider is live in ~30s.", "♻️ Перезапускаю агента — новый провайдер активен через ~30 сек.")
            : ctx.tr("⚠️ Couldn't restart (systemctl). Check the service on the server.", "⚠️ Не удалось перезапустить (systemctl). Проверь сервис на сервере."),
          [ctx.backRow(PARENT)],
        );
      }
      // later
      return ctx.flows.end(
        st,
        ctx.tr("Saved. It'll apply on the next restart (/restart).", "Сохранил. Применится после перезапуска (/restart)."),
        [ctx.backRow(PARENT)],
      );
    }
    return ctx.show(st, SID);
  },

  texts: {
    // Приём API-ключа поиска. Сообщение уже удалено движком (secret:true) до этого вызова.
    // Значение ключа не пишется в лог/reply/eve ни при каком исходе.
    async apikey(text, msg, st, ctx) {
      const key = String(text).trim();
      const data = st.awaitText?.data ?? {};
      const provider = data.provider;
      const cat = SEARCH_CATALOG[provider];
      // Не похоже на ключ (пробелы/слишком коротко) — обычный текст, набранный при ждущем
      // приглашении. Не храним, снимаем ожидание, чтобы чат снова работал.
      if (!/^\S{8,}$/.test(key) || !cat) {
        st.awaitText = null;
        return ctx.flows.end(
          st,
          ctx.tr(
            "That doesn't look like a key — the prompt is cleared, I deleted the message just in case.",
            "Это не похоже на ключ — ожидание снято, сообщение удалил на всякий случай.",
          ),
          [ctx.backRow(PARENT)],
        );
      }
      const err = await checkSearchKey(provider, key);
      if (err) {
        // Причина отказа не содержит значения ключа (см. checkSearchKey) — печатать безопасно.
        return ctx.flows.screen(
          st,
          ctx.tr(`Key rejected (${err}). Send another key or go back.`, `Ключ не принят (${err}). Пришли другой ключ или вернись назад.`),
          [[ctx.btn(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`)]],
        );
      }
      st.awaitText = null;
      // Пишем ключ и провайдера вместе — переключение и ключ атомарны для юзера.
      await upsertEnv(ctx.deps.envPath, { [cat.keyVar]: key, SEARCH_PROVIDER: provider });
      return restartOffer(st, ctx, provider);
    },
  },
};
