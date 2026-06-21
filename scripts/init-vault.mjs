// Инициализация ЖИВОГО vault памяти из шаблона.
//
//   node scripts/init-vault.mjs
//
// Живой vault (ASSISTANT_VAULT_DIR, дефолт ./vault) — ОТДЕЛЬНЫЙ приватный git-репо:
// личные транскрипты/блобы/карточки НЕ должны попадать в код-репозиторий. Этот скрипт
// копирует структуру из vault-template/ (если живой vault пуст) и git-init-ит его.
// Идемпотентен: существующий vault с данными не перетирается.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const VAULT = resolve(process.env.ASSISTANT_VAULT_DIR ?? "vault");
const TEMPLATE = resolve("vault-template");

if (!existsSync(TEMPLATE)) {
  console.error(`init-vault: не найден шаблон ${TEMPLATE} (запусти из корня проекта)`);
  process.exit(1);
}

function isEmpty(dir) {
  if (!existsSync(dir)) return true;
  // Пустым считаем vault без контента (только .git допустим).
  return readdirSync(dir).every((name) => name === ".git");
}

mkdirSync(VAULT, { recursive: true });

if (isEmpty(VAULT)) {
  // Копируем скелет (правила, autograph, dbrain-processor, schema.json, пустые каталоги).
  cpSync(TEMPLATE, VAULT, { recursive: true });

  // Выбираем язык ядра памяти по AGENT_LANGUAGE: en → CORE.en.md перетирает CORE.md.
  // Сидовый CORE.en.md из живого vault убираем в любом случае — в нём остаётся один CORE.md.
  const lang = (process.env.AGENT_LANGUAGE ?? "ru").toLowerCase();
  const coreEn = resolve(VAULT, "CORE.en.md");
  if (existsSync(coreEn)) {
    if (lang === "en") cpSync(coreEn, resolve(VAULT, "CORE.md"));
    rmSync(coreEn);
  }

  console.log(`init-vault: vault создан из шаблона → ${VAULT} (CORE: ${lang})`);
} else {
  console.log(`init-vault: vault уже содержит данные, шаблон не копирую → ${VAULT}`);
}

// Живой vault — собственный git-репо (бэкап + Obsidian). doctor.ts затем коммитит/пушит.
if (!existsSync(resolve(VAULT, ".git"))) {
  execFileSync("git", ["-C", VAULT, "init", "-q"]);
  execFileSync("git", ["-C", VAULT, "add", "-A"]);
  try {
    execFileSync("git", ["-C", VAULT, "commit", "-q", "-m", "chore: init memory vault from template"]);
  } catch {
    // Нет git-идентичности — не критично: doctor.ts закоммитит позже.
    console.warn("init-vault: первый commit не прошёл (настрой git user.name/email) — продолжаю");
  }
  console.log("init-vault: git-репо vault инициализирован.");
  console.log(
    "Привяжи приватный remote для бэкапа:\n" +
      "  gh auth login\n" +
      `  gh repo create <user>/iva-vault --private --source="${VAULT}" --remote=origin --push`,
  );
} else {
  console.log("init-vault: git-репо vault уже есть — пропускаю init.");
}
