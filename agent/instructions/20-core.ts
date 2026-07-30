import { defineDynamic, defineInstructions } from "eve/instructions";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_CAP } from "../../scripts/lib/core-cap.mjs";
import { clampCore } from "../../scripts/memory/core-clamp.mjs";

// Динамическая инструкция: каждый турн инжектит «ядро памяти» (vault/CORE.md) в системный
// промпт — кто пользователь, постоянные предпочтения, активные цели, указатели. Это always-on
// RAM памяти (аналог core memory у MemGPT): маленькое, переживает компактацию (инструкции —
// не часть сжимаемой истории диалога). Пишет ядро ночной rollup; живой чат правит его только
// на явное «запомни …». Clamp чистый и общий с ночным doctor.
const VAULT = process.env.ASSISTANT_VAULT_DIR ?? "vault";

function coreMarkdown(): string {
  let core: string;
  try {
    core = readFileSync(join(VAULT, "CORE.md"), "utf8").trim();
  } catch {
    return ""; // нет файла (vault не инициализирован) — молча ничего не инжектим.
  }
  if (!core) return "";
  // Тот же section-aware backstop, что у doctor: указатели нельзя отрезать слепым slice.
  if (core.length > CORE_CAP) core = clampCore(core);
  return `## Ядро памяти (CORE) — кто пользователь и что в работе\n${core}`;
}

export default defineDynamic({
  events: {
    // turn.started — перечитывается каждый турн, чтобы ядро не «застывало» после правок.
    "turn.started": () => defineInstructions({ markdown: coreMarkdown() }),
  },
});
