import { defineTool } from "eve/tools";
import { z } from "zod";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Строго типизированная запись карточки памяти. Заменяет «write_file по наитию» для карточек:
// zod-enum на type/status берётся из autograph schema.json (единый источник правды), поэтому
// модель НЕ может выдумать тип или добавить неизвестное поле — вызов упадёт на валидации.
// Ночной enforce.py остаётся backstop'ом для всего, что записалось мимо этого тула.

const VAULT = () => process.env.ASSISTANT_VAULT_DIR || "vault";

// Типы карточек, которые модель создаёт интерактивно (summary-типы пишет ночной rollup, не тул).
const CARD_TYPE_DIR: Record<string, string> = {
  contact: "contacts",
  project: "projects",
  decision: "decisions",
  idea: "ideas",
  note: "notes",
};

// Читаем схему на старте: валидные статусы per-type + алиасы. Fallback — зашитый минимум,
// чтобы тул не падал, если vault ещё не инициализирован.
function loadSchema(): { status: Record<string, string[]>; aliases: Record<string, string> } {
  const fallback: { status: Record<string, string[]>; aliases: Record<string, string> } = {
    status: {
      contact: ["active", "inactive"],
      project: ["active", "done", "paused", "cancelled", "draft"],
      decision: ["active", "superseded", "reverted"],
      idea: ["active", "explored", "archived", "draft"],
      note: ["active", "draft", "archived"],
    },
    aliases: { person: "contact", company: "contact", thought: "note", proposal: "idea" },
  };
  try {
    const raw = readFileSync(
      join(VAULT(), ".claude", "skills", "autograph", "schema.json"),
      "utf8",
    );
    const s = JSON.parse(raw);
    const status: Record<string, string[]> = {};
    for (const t of Object.keys(CARD_TYPE_DIR)) {
      const node = s.node_types?.[t];
      status[t] = node?.status || node?.statuses || fallback.status[t] || ["active"];
    }
    return { status, aliases: s.type_aliases || fallback.aliases };
  } catch {
    return fallback;
  }
}

const SCHEMA = loadSchema();
const CARD_TYPES = Object.keys(CARD_TYPE_DIR) as [string, ...string[]];

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "card"
  );
}

// Транслитерация не нужна — vault хранит кириллические слаги нормально (см. существующие карточки).
function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.ASSISTANT_TIMEZONE || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default defineTool({
  description:
    "Создать/перезаписать типизированную карточку памяти в vault. Используй ЭТО (не write_file) " +
    "для карточек — гарантирует валидный тип и схему. type строго один из: " +
    Object.keys(CARD_TYPE_DIR).join(", ") +
    ". Поля вне схемы недопустимы. Summary (день/неделя/…) НЕ создавай — их пишет ночной rollup.",
  inputSchema: z.object({
    type: z.enum(CARD_TYPES).describe("Тип карточки (строго из списка; person/company → contact)"),
    title: z.string().min(1).describe("Имя/заголовок сущности (пойдёт в имя файла и заголовок)"),
    description: z.string().min(1).describe("Краткая выжимка что/зачем (1–2 фразы, для поиска)"),
    tags: z.array(z.string()).min(1).max(6).describe("2–5 тегов, lowercase-kebab"),
    status: z.string().optional().describe("Статус жизненного цикла (валидируется по типу)"),
    domain: z.string().optional().describe("Домен (work/personal/…), опционально"),
    related: z
      .array(z.string())
      .optional()
      .describe("Вики-цели связей [[...]] (vault-пути или слаги), опционально"),
    body: z.string().min(1).describe("Тело карточки в markdown (контекст, факты)"),
    confidence: z
      .enum(["EXTRACTED", "INFERRED", "AMBIGUOUS"])
      .optional()
      .describe("EXTRACTED — прямо сказано; INFERRED — выведено; по умолчанию EXTRACTED"),
  }),
  async execute({ type, title, description, tags, status, domain, related, body, confidence }) {
    // Валидация статуса против схемы типа (жёстко — иначе модель придумает статус).
    const allowed = SCHEMA.status[type] || ["active"];
    const st = status && allowed.includes(status) ? status : allowed[0];
    if (status && !allowed.includes(status)) {
      return {
        ok: false,
        error: `Недопустимый status "${status}" для type "${type}". Разрешены: ${allowed.join(", ")}.`,
      };
    }

    const dir = join(VAULT(), "cards", CARD_TYPE_DIR[type]);
    mkdirSync(dir, { recursive: true });
    const slug = slugify(title);
    const rel = `cards/${CARD_TYPE_DIR[type]}/${slug}.md`;
    const file = join(VAULT(), "cards", CARD_TYPE_DIR[type], `${slug}.md`);
    const existed = existsSync(file);

    const fm: string[] = [
      "---",
      `type: ${type}`,
      `description: ${JSON.stringify(description)}`,
      `tags: [${tags.map((t) => t.toLowerCase().replace(/\s+/g, "-")).join(", ")}]`,
      `status: ${st}`,
      `created: ${today()}`,
      `source: daily/${today()}.md`,
      `confidence: ${confidence || "EXTRACTED"}`,
    ];
    if (domain) fm.push(`domain: ${domain}`);
    fm.push("---", "");

    let out = fm.join("\n") + `\n# ${title}\n\n${body.trim()}\n`;
    if (related && related.length) {
      out += `\n## Related\n` + related.map((r) => `- [[${r}]]`).join("\n") + "\n";
    }
    writeFileSync(file, out, "utf8");
    return { ok: true, file: rel, type, status: st, action: existed ? "updated" : "created" };
  },
});
