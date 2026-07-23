// Экран скиллов: read-only список из .eve/agent-summary.json (skills[] {name, description}),
// по 8 на страницу. Файл — продукт сборки eve; путь от deps.root (корень репо). В worktree
// его может не быть — тогда честный текст, а не пустой экран. Пагинацию (pg) двигает движок.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PER_PAGE = 8;

export default {
  parent: "r",
  render(st, ctx) {
    const T = ctx.tr;
    let skills = null;
    try {
      const data = JSON.parse(readFileSync(join(ctx.deps.root, ".eve/agent-summary.json"), "utf8"));
      skills = Array.isArray(data?.skills) ? data.skills : [];
    } catch {
      skills = null; // файла нет / битый — отличаем от «список пуст»
    }
    if (skills === null) {
      return {
        text: T(
          "🧩 Skills\n\nSkill list is unavailable — .eve/agent-summary.json not found (it appears after a build).",
          "🧩 Скиллы\n\nСписок недоступен — .eve/agent-summary.json не найден (появляется после сборки).",
        ),
        rows: [ctx.backRow("r")],
      };
    }
    if (skills.length === 0) {
      return { text: T("🧩 Skills\n\nNo skills registered.", "🧩 Скиллы\n\nСкиллов не зарегистрировано."), rows: [ctx.backRow("r")] };
    }
    const pages = Math.ceil(skills.length / PER_PAGE);
    const page = Math.min(Math.max(st.page || 0, 0), pages - 1);
    st.page = page;
    const body = skills
      .slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE)
      .map((s) => {
        const name = String(s?.name ?? "?");
        const desc = String(s?.description ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
        return `• ${name}${desc ? ` — ${desc}` : ""}`;
      })
      .join("\n");
    const rows = [];
    if (pages > 1) {
      rows.push([
        ctx.btn("‹", `iva_menu:sk:pg:${page > 0 ? page - 1 : 0}`),
        ctx.btn(`${page + 1}/${pages}`, `iva_menu:sk:pg:${page}`),
        ctx.btn("›", `iva_menu:sk:pg:${page < pages - 1 ? page + 1 : pages - 1}`),
      ]);
    }
    rows.push(ctx.backRow("r"));
    return { text: `${T(`🧩 Skills (${skills.length})`, `🧩 Скиллы (${skills.length})`)}\n\n${body}`, rows };
  },
  on() {},
};
