// Экран кронов: read-only. systemctl --user list-timers (фильтр iva-* + xfeed-daily):
// «имя → следующий запуск», плюс счётчик задач из data/tasks.json. Пагинация по 8.
//
// execFile ограничен таймаутом 1.5с и кэшируется на 60с — единственный getUpdates-цикл
// моста нельзя блокировать дольше (список таймеров редко висит, одной ограниченной пробы
// достаточно, async-перерисовка тут не нужна).
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";

const PER_PAGE = 8;
const CACHE_TTL_MS = 60_000;
let cache = { at: 0, timers: null };

function run(cmd, args, timeout = 1500) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: "utf8" }, (err, stdout = "") => resolve(String(stdout)));
  });
}

// Толерантный парс: колонки list-timers переменной ширины (NEXT/LEFT содержат пробелы),
// поэтому берём только надёжное — имя таймера (*.timer) и ведущую абсолютную дату NEXT.
function parseTimers(stdout) {
  const out = [];
  for (const line of stdout.split("\n")) {
    if (!/\.timer\b/.test(line)) continue; // пропускаем шапку/подвал/пустые
    const unit = (line.match(/(\S+\.timer)/) || [])[1];
    if (!unit) continue;
    if (!/^iva-/.test(unit) && !/^xfeed-daily/.test(unit)) continue;
    const dm = line.match(/^(\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: \S+)?)/);
    out.push({ unit, next: dm ? dm[1] : "—" });
  }
  out.sort((a, b) => a.unit.localeCompare(b.unit));
  return out;
}

async function loadTimers() {
  if (cache.timers && Date.now() - cache.at < CACHE_TTL_MS) return cache.timers;
  const stdout = await run("systemctl", ["--user", "list-timers", "--all", "--no-pager"]);
  const timers = parseTimers(stdout);
  cache = { at: Date.now(), timers };
  return timers;
}

function taskCount(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "tasks.json"), "utf8"));
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.tasks) ? raw.tasks : [];
    return arr.length;
  } catch {
    return 0;
  }
}

export default {
  parent: "r",
  async render(st, ctx) {
    const T = ctx.tr;
    const timers = await loadTimers();
    const taskLine = T(`Tasks in queue: ${taskCount(ctx.deps.dataDir)}`, `Задач в очереди: ${taskCount(ctx.deps.dataDir)}`);
    const head = T("⏰ Timers & tasks", "⏰ Кроны и задачи");
    if (timers.length === 0) {
      return {
        text: `${head}\n\n${T("No Iva timers found.", "Таймеров Iva не найдено.")}\n${taskLine}`,
        rows: [ctx.backRow("r")],
      };
    }
    const pages = Math.ceil(timers.length / PER_PAGE);
    const page = Math.min(Math.max(st.page || 0, 0), pages - 1);
    st.page = page;
    const body = timers
      .slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE)
      .map((t) => `• ${t.unit.replace(/\.timer$/, "")} → ${t.next}`)
      .join("\n");
    const rows = [];
    if (pages > 1) {
      rows.push([
        ctx.btn("‹", `iva_menu:cron:pg:${page > 0 ? page - 1 : 0}`),
        ctx.btn(`${page + 1}/${pages}`, `iva_menu:cron:pg:${page}`),
        ctx.btn("›", `iva_menu:cron:pg:${page < pages - 1 ? page + 1 : pages - 1}`),
      ]);
    }
    rows.push(ctx.backRow("r"));
    return { text: `${head}\n\n${body}\n\n${taskLine}`, rows };
  },
  on() {},
};
