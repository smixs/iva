// Экран «🔔 Уведомления»: чем Iva имеет право прервать день. Тумблеры только у Report'ов —
// плановых сводок; алерты (проблемы и предложения обновиться) не выключаются, о чём экран
// говорит прямым текстом (ADR-0007).
//
// Тумблер пишется в data/settings.json, который и rollup, и schedule дайджеста читают в
// момент запуска — переключение применяется без рестарта процессов.
//
// Правило репо: ни одной module-level const с переведённой строкой — подписи собираются в
// render() через ctx.tr, иначе язык замёрзнет до рестарта.
import { readSettings, writeSettings } from "#lib/settings.ts";
import { memoryReportsEnabled } from "../notice-policy.ts";

const PARENT = "r";

type Button = { text: string; callback_data: string };
type MenuState = { page: number };
type MenuContext = {
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
  show: (state: MenuState, screen: string) => Promise<void>;
};

// Целевой тумблер → ключ в settings.json. Аргумент callback_data — короткий ASCII-энум
// (грамматика в index.ts), а не имя ключа: мусорный аргумент просто не найдёт цели.
const TOGGLES = {
  rep: "memoryReports",
  dig: "digestSchedule",
} as const;
type Toggle = keyof typeof TOGGLES;

function isToggle(value: string): value is Toggle {
  return Object.hasOwn(TOGGLES, value);
}

function digestEnabled(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  const digest = (settings as { digestSchedule?: unknown }).digestSchedule;
  if (typeof digest !== "object" || digest === null) return false;
  return (digest as { enabled?: unknown }).enabled === true;
}

export default {
  parent: PARENT,
  render(_state: MenuState, ctx: MenuContext) {
    const settings = readSettings();
    const T = ctx.tr;
    // Кнопка несёт значение, которое надо получить, а не «переключи»: повторный тап по
    // протухшему меню приводит к тому же состоянию, а не мигает туда-обратно.
    const toggle = (on: boolean, label: string, target: Toggle) =>
      ctx.btn(
        `${on ? "✓" : "○"} ${label}`,
        `iva_menu:ntc:set:${target}:${on ? "0" : "1"}`,
      );
    const rows = [
      [
        toggle(
          memoryReportsEnabled(settings),
          T("Memory reports", "Отчёты памяти"),
          "rep",
        ),
      ],
      [
        toggle(
          digestEnabled(settings),
          T("Morning digest", "Утренний дайджест"),
          "dig",
        ),
      ],
      ctx.backRow(PARENT),
    ];
    return {
      text: T(
        "🔔 Notices\n\nMemory reports: what Iva filed overnight and over the week.\n" +
          "Morning digest: your day ahead at 08:00.\n\n" +
          "Alerts — problems and updates — always arrive.",
        "🔔 Уведомления\n\nОтчёты памяти: что Ива разложила за ночь и за неделю.\n" +
          "Утренний дайджест: план дня в 08:00.\n\n" +
          "Алерты — о проблемах и обновлениях — приходят всегда.",
      ),
      rows,
    };
  },
  async on(
    verb: string,
    args: string[],
    state: MenuState,
    ctx: MenuContext,
  ): Promise<void> {
    if (verb !== "set") return;
    const [target, value] = args;
    // Тап несёт и цель, и значение. Всё, что не из этого словаря, — протухшая или чужая
    // кнопка: настройки от неё не двигаются.
    if (typeof target !== "string" || !isToggle(target)) return;
    if (value !== "0" && value !== "1") return;
    const key = TOGGLES[target];
    const enabled = value === "1";
    // writeSettings мержит поверхностно, поэтому вложенный объект патчится целиком —
    // иначе соседние ключи (расписание дайджеста) были бы стёрты этим тапом.
    const current = readSettings()[key];
    const kept =
      typeof current === "object" && current !== null && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {};
    writeSettings({ [key]: { ...kept, enabled } });
    await ctx.show(state, "ntc");
  },
};
