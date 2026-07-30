import { defineTool } from "eve/tools";
import { z } from "zod";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  acquireLock,
  atomicWrite,
  mergeCard,
  resolveCard,
} from "../lib/card-store.js";

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
const DESC_CAP = 500;

// Схема vault'а: корень vault'а → легаси `.claude`-путь (vault'ы до 0.3.3) → дефолт из репо.
function schemaPath(): string {
  const candidates = [
    join(VAULT(), "schema.json"),
    join(VAULT(), ".claude", "skills", "autograph", "schema.json"),
    join("scripts", "autograph", "schema.example.json"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

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
    const raw = readFileSync(schemaPath(), "utf8");
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

// Алиасы типов из схемы применяются ДО валидации: описание поля обещает person/company →
// contact, значит z.enum не должен отклонять их раньше execute. Алиасы, ведущие в типы вне
// CARD_TYPE_DIR (daily → daily-summary), не разворачиваются — их пишет ночной rollup.
function normalizeType(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const k = v.trim().toLowerCase();
  if (k in CARD_TYPE_DIR) return k;
  const mapped = SCHEMA.aliases[k];
  return mapped && mapped in CARD_TYPE_DIR ? mapped : k;
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
    "Создать или ДОПОЛНИТЬ типизированную карточку памяти в vault (существующая карточка " +
    "сливается, а не затирается: неизвестные поля и старый текст сохраняются). " +
    "Используй ЭТО (не write_file) " +
    "для карточек — гарантирует валидный тип и схему. type строго один из: " +
    Object.keys(CARD_TYPE_DIR).join(", ") +
    ". Поля вне схемы недопустимы. Summary (день/неделя/…) НЕ создавай — их пишет ночной rollup.",
  inputSchema: z.object({
    type: z
      .preprocess(normalizeType, z.enum(CARD_TYPES))
      .describe("Тип карточки (строго из списка; алиасы вроде person/company → contact применяются автоматически)"),
    title: z.string().min(1).describe("Имя/заголовок сущности (пойдёт в имя файла и заголовок)"),
    description: z
      .string()
      .min(1)
      .max(
        DESC_CAP,
        `description слишком длинное: максимум ${DESC_CAP} символов; сократи его и повтори вызов`,
      )
      .describe("Краткая выжимка что/зачем (1–2 фразы, для поиска)"),
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
    replace_body: z
      .boolean()
      .optional()
      .describe(
        "ТОЛЬКО для SUPERSEDE: заменить body целиком (сам перенеси старое значение в ## History). " +
          "Без флага body дописывается, противоречащие факты так не исправить.",
      ),
  }),
  async execute({ type, title, description, tags, status, domain, related, body, confidence, replace_body }) {
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

    // Идентичность: точный слаг → иначе карточка того же типа с таким же H1/name/aliases
    // (легаси-файлы с латинским слагом и кириллическим заголовком).
    const id = resolveCard(dir, title);
    if (id.candidates && id.candidates.length > 1) {
      const list = id.candidates.map((f) => relative(VAULT(), f).split(sep).join("/"));
      return {
        ok: false,
        error:
          `Неоднозначная карточка для "${title}": подходят ${list.length} файлов. ` +
          "Уточни заголовок или обнови нужный файл явно — ничего не записано.",
        candidates: list,
      };
    }
    const file = id.file;
    const rel = relative(VAULT(), file).split(sep).join("/");

    // Сбои лока/записи — структурированная ошибка, а не исключение: модель должна
    // увидеть внятное «занято/не записалось» и решить, что делать, а не уронить ход.
    let release: (() => void) | null = null;
    try {
      release = acquireLock(file);
      const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
      const { content, action } = mergeCard({
        existing,
        title,
        fields: {
          type,
          description,
          tags: tags.map((t) => t.toLowerCase().replace(/\s+/g, "-")),
          status: st,
          confidence: confidence || "EXTRACTED",
          ...(domain ? { domain } : {}),
        },
        initialFields: { created: today(), source: `daily/${today()}.md` },
        body,
        related,
        date: today(),
        replaceBody: replace_body === true,
      });
      atomicWrite(file, content);
      return { ok: true, file: rel, type, status: st, action, matchedBy: id.matchedBy };
    } catch (e) {
      return { ok: false, error: `Не удалось записать карточку ${rel}: ${(e as Error).message}` };
    } finally {
      release?.();
    }
  },
});
