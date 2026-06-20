import { defineDynamic, defineInstructions } from "eve/instructions";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Динамическая инструкция: каждый турн инжектит «ядро памяти» (vault/CORE.md) в системный
// промпт — кто пользователь, постоянные предпочтения, активные цели, указатели. Это always-on
// RAM памяти (аналог core memory у MemGPT): маленькое, переживает компактацию (инструкции —
// не часть сжимаемой истории диалога). Пишет ядро ночной rollup; живой чат правит его только
// на явное «запомни …». Самодостаточна — только eve + node fs/path (гоча eve 0.11.4).
const VAULT = process.env.ASSISTANT_VAULT_DIR ?? "vault";
const MAX_CHARS = 1200; // жёсткий лимит ядра (~300 токенов) — держим always-on пол плоским.

function coreMarkdown(): string {
  let core: string;
  try {
    core = readFileSync(join(VAULT, "CORE.md"), "utf8").trim();
  } catch {
    return ""; // нет файла (vault не инициализирован) — молча ничего не инжектим.
  }
  if (!core) return "";
  if (core.length > MAX_CHARS) {
    core = core.slice(0, MAX_CHARS) + "\n…(ядро усечено — ночной rollup ужмёт)";
  }
  return `## Ядро памяти (CORE) — кто пользователь и что в работе\n${core}`;
}

export default defineDynamic({
  events: {
    // turn.started — перечитывается каждый турн, чтобы ядро не «застывало» после правок.
    "turn.started": () => defineInstructions({ markdown: coreMarkdown() }),
  },
});
