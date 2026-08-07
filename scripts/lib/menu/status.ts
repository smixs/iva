/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- conversion keeps source-compatible runtime indexing. */
// Экран статуса: одна карта — версия, провайдер·модель·размышления, поиск+ключ, язык,
// userbot, Google, расход за сегодня. Быстрые поля (env/файлы) читаются синхронно в первом
// рендере; общая userbot-проба systemd/HTTP/Telethon НЕ ждётся синхронно — сначала
// заглушка «…», затем async-edit по завершении. Так единственный getUpdates-цикл моста не
// блокируется дольше ~1.5с.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readEnvValues } from "../env-file.ts";
import { CATALOG } from "../model-catalog.ts";
import { SEARCH_CATALOG } from "../search-catalog.ts";
import { readEntries, summarize } from "../usage.ts";
import { probeUserbotHealth } from "../userbot-health.ts";

type Env = Record<string, string | undefined>;
type VersionPackage = { version?: unknown };
type StatusState = { chatId: unknown; userId: unknown; screen: string };
type Health = { state?: string };
type MenuContext = {
  deps: {
    root: string;
    envPath: string;
    dataDir: string;
    probeUserbotHealth?: (options: {
      root: string;
      port: string;
    }) => Promise<Health>;
  };
  flows: {
    get: (chatId: unknown, userId: unknown) => StatusState | null;
    screen: (
      state: StatusState,
      text: string,
      rows: Array<Array<unknown>>,
    ) => Promise<unknown>;
  };
  getLang: () => string;
  tr: (en: string, ru: string) => string;
  btn: (text: string, callbackData: string) => unknown;
  backRow: (screen: string) => Array<unknown>;
};

function version(root: string) {
  try {
    const parsed = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as VersionPackage;
    return typeof parsed.version === "string" ? parsed.version : "?";
  } catch {
    return "?";
  }
}

const groupThousands = (n: string | number | undefined) =>
  String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

function usageToday(
  dataDir: string,
  tz: string | undefined,
  T: MenuContext["tr"],
) {
  try {
    const agg = summarize(readEntries(dataDir), {
      window: "today",
      now: Date.now(),
      tz,
    });
    const totals = (
      agg as { totals?: { total?: unknown; turns?: unknown } } | null
    )?.totals;
    const total =
      typeof totals?.total === "number" || typeof totals?.total === "string"
        ? totals.total
        : 0;
    const turns =
      typeof totals?.turns === "number" || typeof totals?.turns === "string"
        ? totals.turns
        : 0;
    return T(
      `${groupThousands(total)} tokens · ${turns} turns`,
      `${groupThousands(total)} токенов · ${turns} ходов`,
    );
  } catch {
    return T("n/a", "н/д");
  }
}

// Собирает быстрые поля (без медленной пробы) — переиспользуется первым рендером и async-edit'ом.
function fastFields(env: Env, ctx: MenuContext) {
  const configuredProvider = env.MODEL_PROVIDER ?? "ollama";
  const providerIsValid = Object.hasOwn(CATALOG, configuredProvider);
  const cat = providerIsValid
    ? CATALOG[configuredProvider as keyof typeof CATALOG]
    : undefined;
  const searchProv =
    typeof env.SEARCH_PROVIDER === "string" &&
    Object.hasOwn(SEARCH_CATALOG, env.SEARCH_PROVIDER)
      ? env.SEARCH_PROVIDER
      : "tavily";
  const searchCat = SEARCH_CATALOG[searchProv as keyof typeof SEARCH_CATALOG];
  return {
    version: version(ctx.deps.root),
    provider: providerIsValid
      ? configuredProvider
      : `invalid (${configuredProvider})`,
    model: cat ? env[cat.modelVar] || cat.def : "?",
    effort: cat ? (env.THINKING_EFFORT || "").toLowerCase() : "",
    searchProv,
    hasKey: Boolean(searchCat && env[searchCat.keyVar]),
    lang: ctx.getLang(),
    gws: existsSync(join(homedir(), ".config/gws/client_secret.json")),
    usage: usageToday(ctx.deps.dataDir, env.ASSISTANT_TIMEZONE, ctx.tr),
  };
}

function buildView(
  d: ReturnType<typeof fastFields>,
  health: Health | null,
  ctx: MenuContext,
) {
  const T = ctx.tr;
  const labels = {
    off: T("off", "выкл"),
    starting: T("starting", "запускается"),
    unreachable: T("unreachable", "недоступен"),
    unauthorized: T("login required", "нужен вход"),
    ready: T("ready", "готов"),
  };
  const ub =
    health === null
      ? "…"
      : labels[health.state as keyof typeof labels] || labels.unreachable;
  const lines = [
    T("📊 Status", "📊 Статус"),
    "",
    `Iva v${d.version}`,
    T(
      `Model: ${d.provider} · ${d.model}${d.effort ? ` · think ${d.effort}` : ""}`,
      `Модель: ${d.provider} · ${d.model}${d.effort ? ` · размышления ${d.effort}` : ""}`,
    ),
    T(
      `Search: ${d.searchProv} ${d.hasKey ? "🔑" : "🔒"}`,
      `Поиск: ${d.searchProv} ${d.hasKey ? "🔑" : "🔒"}`,
    ),
    T(`Language: ${d.lang}`, `Язык: ${d.lang}`),
    `Userbot: ${ub}`,
    T(
      `Google: ${d.gws ? "configured" : "not set"}`,
      `Google: ${d.gws ? "настроен" : "не настроен"}`,
    ),
    T(`Usage today: ${d.usage}`, `Расход за сегодня: ${d.usage}`),
  ];
  const rows = [
    [ctx.btn(T("🔄 Refresh", "🔄 Обновить"), "iva_menu:st:rf")],
    ctx.backRow("r"),
  ];
  return { text: lines.join("\n"), rows };
}

export default {
  parent: "r",
  async render(st: StatusState, ctx: MenuContext) {
    const env = (await readEnvValues(ctx.deps.envPath)) as Env;
    const d = fastFields(env, ctx);

    // Медленную пробу гоним ОТДЕЛЬНО и правим сообщение по готовности — только если экран
    // всё ещё текущий (пользователь не ушёл в другой раздел / не закрыл меню).
    const probe = ctx.deps.probeUserbotHealth || probeUserbotHealth;
    probe({ root: ctx.deps.root, port: env.TELEGRAM_MCP_PORT || "8724" })
      .then((result: Health) => {
        if (ctx.flows.get(st.chatId, st.userId) === st && st.screen === "st") {
          const v = buildView(d, result, ctx);
          return ctx.flows.screen(st, v.text, v.rows);
        }
      })
      .catch(() => {});
    return buildView(d, null, ctx);
  },
  on() {},
};
