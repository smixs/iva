import { defineInstructions } from "eve/instructions";

// Язык ответов агента выбирается при установке (AGENT_LANGUAGE=en|ru, дефолт ru).
// Это единственный источник правды о языке вывода — персона в instructions.md
// языково-нейтральна. Самодостаточна: только eve/instructions + process.env (гоча eve 0.11.4).
const LANG = (process.env.AGENT_LANGUAGE ?? "ru").toLowerCase();

const RULE =
  LANG === "en"
    ? "Reply in English by default. If the user writes to you in another language, match theirs."
    : "Отвечай по-русски по умолчанию. Если пользователь пишет на другом языке — подстройся под него.";

export default defineInstructions({ markdown: `## Язык / Language\n${RULE}` });
