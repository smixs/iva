// Экран статуса: одна карта — версия, провайдер·модель·размышления, поиск+ключ, язык,
// userbot, Google, расход за сегодня. Быстрые поля (env/файлы) читаются синхронно в первом
// рендере; медленная проба (systemctl is-active userbot) НЕ ждётся синхронно — сначала
// заглушка «…», затем async-edit по завершении. Так единственный getUpdates-цикл моста не
// блокируется дольше ~1.5с. Проба кэшируется на 60с.
import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { readEnvValues } from "../env-file.mjs";
import { CATALOG } from "../model-catalog.mjs";
import { SEARCH_CATALOG } from "../search-catalog.mjs";
import { readEntries, summarize } from "../usage.mjs";

const PROBE_TTL_MS = 60_000;
let probeCache = { at: 0, ubActive: null };

function run(cmd, args, timeout = 1500) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: "utf8" }, (err, stdout = "") =>
      resolve({ failed: Boolean(err), code: typeof err?.code === "number" ? err.code : err ? 1 : 0, stdout: String(stdout) }),
    );
  });
}

async function probeUserbot() {
  const r = await run("systemctl", ["--user", "is-active", "iva-telegram-userbot.service"]);
  return r.code === 0 || r.stdout.trim() === "active";
}

function version(root) {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version || "?";
  } catch {
    return "?";
  }
}

const groupThousands = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

function usageToday(dataDir, tz, T) {
  try {
    const agg = summarize(readEntries(dataDir), { window: "today", now: Date.now(), tz });
    const total = agg?.totals?.total || 0;
    const turns = agg?.totals?.turns || 0;
    return T(`${groupThousands(total)} tokens · ${turns} turns`, `${groupThousands(total)} токенов · ${turns} ходов`);
  } catch {
    return T("n/a", "н/д");
  }
}

// Собирает быстрые поля (без медленной пробы) — переиспользуется первым рендером и async-edit'ом.
function fastFields(env, ctx) {
  const provider = CATALOG[env.MODEL_PROVIDER] ? env.MODEL_PROVIDER : "ollama";
  const cat = CATALOG[provider];
  const searchProv = env.SEARCH_PROVIDER || "tavily";
  const searchCat = SEARCH_CATALOG[searchProv];
  return {
    version: version(ctx.deps.root),
    provider,
    model: env[cat.modelVar] || cat.def,
    effort: (env.THINKING_EFFORT || "").toLowerCase(),
    searchProv,
    hasKey: Boolean(searchCat && env[searchCat.keyVar]),
    lang: ctx.getLang(),
    gws: existsSync(join(homedir(), ".config/gws/client_secret.json")),
    usage: usageToday(ctx.deps.dataDir, env.ASSISTANT_TIMEZONE, ctx.tr),
  };
}

function buildView(d, ubActive, ctx) {
  const T = ctx.tr;
  const ub = ubActive === null ? "…" : ubActive ? T("active", "активен") : T("off", "выкл");
  const lines = [
    T("📊 Status", "📊 Статус"),
    "",
    `Iva v${d.version}`,
    T(`Model: ${d.provider} · ${d.model}${d.effort ? ` · think ${d.effort}` : ""}`,
      `Модель: ${d.provider} · ${d.model}${d.effort ? ` · размышления ${d.effort}` : ""}`),
    T(`Search: ${d.searchProv} ${d.hasKey ? "🔑" : "🔒"}`, `Поиск: ${d.searchProv} ${d.hasKey ? "🔑" : "🔒"}`),
    T(`Language: ${d.lang}`, `Язык: ${d.lang}`),
    `Userbot: ${ub}`,
    T(`Google: ${d.gws ? "configured" : "not set"}`, `Google: ${d.gws ? "настроен" : "не настроен"}`),
    T(`Usage today: ${d.usage}`, `Расход за сегодня: ${d.usage}`),
  ];
  const rows = [[ctx.btn(T("🔄 Refresh", "🔄 Обновить"), "iva_menu:st:rf")], ctx.backRow("r")];
  return { text: lines.join("\n"), rows };
}

export default {
  parent: "r",
  async render(st, ctx) {
    const env = await readEnvValues(ctx.deps.envPath);
    const d = fastFields(env, ctx);
    const fresh = probeCache.ubActive !== null && Date.now() - probeCache.at < PROBE_TTL_MS;
    const ubActive = fresh ? probeCache.ubActive : null;

    if (!fresh) {
      // Медленную пробу гоним ОТДЕЛЬНО и правим сообщение по готовности — только если экран
      // всё ещё текущий (пользователь не ушёл в другой раздел / не закрыл меню).
      probeUserbot()
        .then((active) => {
          probeCache = { at: Date.now(), ubActive: active };
          if (ctx.flows.get(st.chatId, st.userId) === st && st.screen === "st") {
            const v = buildView(d, active, ctx);
            return ctx.flows.screen(st, v.text, v.rows);
          }
        })
        .catch(() => {});
    }
    return buildView(d, ubActive, ctx);
  },
  on() {},
};
