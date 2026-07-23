// Экран языка интерфейса: [Русский ✓] [English]. Переключение применяется мгновенно —
// settings.json подхватывают свежим чтением оба процесса (мост и канал). Плюс дублируем в
// .env AGENT_LANGUAGE, чтобы node --env-file потребители (cron-скрипты, init-vault) были
// согласованы на своём следующем запуске без правок.
import { writeSettings } from "../settings.mjs";
import { upsertEnv } from "../env-file.mjs";

export default {
  parent: "r",
  render(st, ctx) {
    const cur = ctx.getLang();
    const mark = (v) => (cur === v ? " ✓" : "");
    const rows = [
      [
        ctx.btn(`Русский${mark("ru")}`, "iva_menu:lang:set:ru"),
        ctx.btn(`English${mark("en")}`, "iva_menu:lang:set:en"),
      ],
      ctx.backRow("r"),
    ];
    return { text: ctx.tr("🌐 Interface language", "🌐 Язык интерфейса"), rows };
  },
  async on(verb, args, st, ctx) {
    if (verb !== "set") return;
    const v = args[0] === "en" ? "en" : "ru";
    writeSettings({ language: v });
    try {
      await upsertEnv(ctx.deps.envPath, { AGENT_LANGUAGE: v });
    } catch {
      // .env недоступен — язык всё равно сменится через settings.json; не падаем.
    }
    ctx.lang = v; // обновляем снимок -> root перерисуется уже на новом языке
    st.page = 0;
    await ctx.show(st, "r");
  },
};
