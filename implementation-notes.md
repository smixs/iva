# Implementation Notes — assistant (eve + Ollama Cloud / DeepSeek-V4-Pro)

Живой журнал решений. Что сделано не по дефолту/спеке и почему.

## 2026-06-18

### Decisions
- **Модель через `@ai-sdk/openai-compatible@3.0.0-beta.57`**, baseURL `https://ollama.com/v1`.
  Версия подобрана по совпадению `@ai-sdk/provider@4.0.0-beta.19` с запиненным `ai@7.0.0-beta.178`
  (иначе ломается тип `LanguageModel`). Провайдер дедуплицировался на тот же provider — конфликта нет.
- **Конфиг модели вынесен в `agent/lib/model.ts`** (`assistantModel`) и импортируется и корнем,
  и субагентом `planner`. Причина: declared subagent НЕ наследует модель от корня (иначе упал бы
  на дефолт `anthropic/claude-sonnet-4.6`, для которого нет ключа). В субагенте импорт относительный
  (`../../lib/model.js`), в корне — через import-map (`#lib/model.js`).
- **Задачи хранятся в простом JSON-файле** (`./data/tasks.json`, путь через `ASSISTANT_DATA_DIR`),
  а не в sandbox `/workspace`. Причина: tools в eve выполняются в app-runtime с доступом к fs;
  на VPS файл переживает рестарты. `defineState` не подошёл — он per-session, а задачи кросс-сессионные.
- **Cron на VPS — двойная схема.** `agent/schedules/morning.ts` (handler + `receive(telegram)`) —
  Vercel-ready, но на self-host НЕ срабатывает (eve запускает schedules только как Vercel Cron).
  Реальный триггер на VPS — `scripts/daily-digest.ts` через `eve/client` + Telegram Bot API,
  запускаемый system cron.
- **Личность:** агент «Ева», ru, кратко. Инструкции явно велят ходить в tool `tasks` и не выдумывать задачи.
- **Субагент `planner`** — чистый reasoning-специалист с `outputSchema` (goal + steps[]). Сам задачи не
  пишет; план возвращает корню, тот добавляет через `tasks`. Так проще (изоляция субагента не требует
  копировать tool).

### Deviations
- Менеджер пакетов — **npm**, не pnpm (вопреки глобальному правилу). Решение пользователя: eve init
  заточен под npm, флага выбора нет. Supply-chain политика (minimumReleaseAge) здесь не применяется.
- `eve init --yes` не существует — флаг отброшен; скаффолд сделан запуском init в фоне (dev-TUI
  в non-TTY просто выходит).

### Gotchas
- **R1 (reasoning) на уровне API не подтвердился:** DeepSeek-V4-Pro отдаёт `reasoning` отдельным
  полем, `content`/`tool_calls` чистые. Smoke-тест вернул валидный `tool_calls`. Режим thinking
  пока дефолтный (не трогаем `modelOptions`).
- EBADENGINE warning: node 26 vs требуемый eve 24.x — безвреден (26 новее).

### Open questions (ответил сам)
- **Prod-auth eve-канала.** Scaffold-канал = localDev() + placeholderAuth(). Локально (localhost)
  `eve/client` работает через localDev. В проде на VPS localDev игнорируется → cron-скрипту нужен
  bearer (`ASSISTANT_BEARER`) и канал надо настроить на реальный auth. Это deploy-time задача,
  для локальной проверки v1 не блокирует. Помечено в .env.example.
- **chat_id для дайджеста** получить через getUpdates после создания бота → `TELEGRAM_DIGEST_CHAT_ID`.

## 2026-06-18 (проверка tool-loop)

### Verified (eve dev, deepseek-v4-pro:cloud, scripts/smoke-test.mjs)
Все 5 ходов прошли на DeepSeek:
- tool `tasks` add/list — `actions.requested`/`action.result` в каждом ходе;
- память между ходами (ход 2 помнит обе задачи) — durable session;
- скилл — `load_skill` + дайджест строго в формате morning-digest (2 tool-calls в ходе);
- субагент — `subagent.called:planner` + `subagent.completed`, вернул структуру из 7 шагов.
Вывод: tool-loop на DeepSeek-V4-Pro в eve стабилен. Главная цель v1 достигнута.

### Gotchas (важные)
- **eve dev (v0.11.4) ломается на cross-authored import.** Если authored-модуль импортирует другой
  authored-модуль по относительному `.js` (например `agent.ts` → `lib/model.js`, или
  `schedules/morning.ts` → `channels/telegram.js`), dev source-backed загрузчик
  (`loadSourceBackedRuntimeModelReference`) не находит модуль в снапшоте (там `.ts`) и роняет
  загрузку всей module-map → падает КАЖДЫЙ ход (`session.failed`, FatalError USER_ERROR).
  - Фикс 1: модель определена inline в каждом `agent.ts` (не вынесена в `lib/`).
  - Фикс 2: handler-schedule убран из `agent/`. `eve build` со schedule собирается УСПЕШНО
    (croner + eve.schedule.mjs) — баг только в dev. Vercel-сниппет расписания → DEPLOY.md.
- **Статус хода — `waiting`, не `completed`.** Интерактивный ход оставляет сессию в `waiting`
  (готова к следующему сообщению). `scripts/daily-digest.ts` проверяет наличие `result.message`,
  а не `status === "completed"`.
- **Порт dev — 2000** (не 3000). Prod `eve start` — `PORT` или 3000.
- `timeout`/`gtimeout` на macOS нет — для тестов не использовать.

## 2026-06-18 (безопасность доступа + конфигурируемость)

### Decisions
- **Allowlist Telegram по user ID (fail-closed).** `agent/channels/telegram.ts` переопределяет
  `onMessage`: пускает только `TELEGRAM_ALLOWED_USER_IDS`; пустой список = никто. Недоверенному
  в личке шлётся его ID, апдейт дропается (`return null`) до запуска агента. Дефолтные
  `defaultOnMessage`/`defaultTelegramAuth`/`shouldDispatch` НЕ экспортируются публично
  (`eve/channels/telegram` — единственный экспорт), поэтому логика диспатча и `auth`-контекст
  воспроизведены вручную по исходнику eve (authenticator `telegram-webhook`, principalId
  `telegram:<uid>` / `telegram:<chat>:<uid>`).
- **Модель конфигурируема через `OLLAMA_MODEL`/`OLLAMA_CONTEXT_WINDOW`** (env), дефолт
  `deepseek-v4-pro`. `setup.mjs` тянет живой список с `/v1/models` (35 моделей) и пишет выбор в `.env`.
- **Автоопределение Telegram ID** в setup через `getUpdates` (работает до setWebhook).
- **Один скрипт установки** `install.sh` (Node 24+ via nvm, deps, setup, build, systemd user-service);
  читает ввод из `/dev/tty` → работает через `curl | bash`.

### Verified (runtime, dev + поддельные вебхуки)
- bad secret → 401 (встроенная проверка eve);
- user 999 (не в allowlist) → `executeModelCall: 0`, агент НЕ запущен, отправлен denial-note;
- user 111 (в allowlist) → агент отработал, ответ сформирован.
  (sendMessage падал с 401 только из-за dummy-токена в тесте.)

### Gotchas
- `attributes` в `SessionAuthContext` — тип `Record<string, string | readonly string[]>`,
  не `unknown` (иначе typecheck падает).
- `getUpdates` не работает, если уже стоит вебхук (Telegram запрещает) — определять ID до setWebhook.

## 2026-06-20 (v2 — bare-VPS + память DAG + Deepgram)

### Decisions
- **Sandbox убран → host-native тулзы.** На bare VPS у Евы полный shell + файловый доступ через
  override встроенных тулзов (`bash`/`read_file`/`write_file`/`glob`/`grep`) на Node `fs`/`child_process`.
  Снимает зависимость от Docker/microsandbox. Периметр держит allowlist Telegram (fail-closed).
- **Deepgram в TS через REST** (`POST /v1/listen?model=nova-3&language=multi`), без Python в рантайме
  бота. Функция транскрипции **инлайнится** в `telegram.ts` (cross-authored import ломает `eve dev`),
  при необходимости дублируется в rollup-скрипт. Голос/видео берутся из `message.raw` (eve парсит как
  attachments только photo/document).
- **Двусторонний транскрипт** vault: сторона юзера пишется в `onMessage` (`context:[transcript]` доносит
  расшифровку до модели при пустом `message.text`), сторона Евы — `message.completed` хук
  `agent/hooks/transcript.ts`.
- **Память — DAG через systemd-таймеры + `eve/client`** (`scripts/memory/rollup.ts <period>`,
  `doctor.ts`), т.к. eve-расписания на self-host не идут. Один параметризованный rollup-скрипт;
  doctor делает autograph health/decay/moc/dedup + git commit&push vault.
- **autograph вендорится в репо** (`vault/.claude/skills/autograph/`), запуск через `uv run`. Используем
  только механические скрипты; `enrich.py` (OpenRouter) **обходим** — теги/связи/классификацию делает
  сама Eva (только DeepSeek, без второго LLM-провайдера).
- **Часовой пояс** — `ASSISTANT_TIMEZONE` (→ `TZ` в systemd) + динамическая инструкция `now`, вместо
  хардкода «Almaty UTC+5».

### Decisions (Component F — installer/setup/env/docs)
- **install.sh расширен под bare-VPS.** Detect-then-install системных пакетов (`git`/`gh`/`python3`/`ffmpeg`)
  через apt/dnf/brew; `sudo -v` один раз в начале, если пакеты нужны и не root. `gh` на apt ставится через
  официальный источник cli.github.com (нет в базовых репах Debian/Ubuntu). uv — `curl … astral.sh/uv`.
  Node 24 через nvm (как было). Затем `npm ci` → `eve build` → `git init` vault → systemd сервис + таймеры.
- **ffmpeg ставится, но помечен опциональным** — nova-3 обычно принимает видео-контейнеры напрямую
  (берёт аудиодорожку); ffmpeg как страховка под перекодировку.
- **Таймеры памяти ставятся из `deploy/eve-memory-*.{service,timer}`** (создаёт компонент памяти). install.sh
  копирует юниты в `~/.config/systemd/user/` с подстановкой плейсхолдеров `__PROJECT_DIR__`/`__NODE_BIN__`
  (sed, безвредно если их нет), `enable --now` + `loginctl enable-linger`. Если deploy-юнитов ещё нет —
  пропускает с warn (устойчиво к порядку сборки компонентов).
- **Vault git init в install.sh**, без авто-`gh auth login`: создаётся локальный репо + `.gitignore`,
  пользователю печатается напоминание `gh auth login` + `gh repo create --private`. Авторизацию руками
  один раз — gh-токен в неинтерактивном `curl|bash` не выпросить.
- **setup.mjs**: добавлены промпты `DEEPGRAM_API_KEY` (required, с маскировкой «…(оставить)» как у Ollama),
  `DEEPGRAM_LANGUAGE` (multi), `ASSISTANT_TIMEZONE` (Asia/Almaty), `ASSISTANT_VAULT_DIR` (vault). Записаны в
  ordered-writer в логическом порядке (после Telegram, перед ASSISTANT_DATA_DIR).
- **package.json**: убран devDep `microsandbox` (+ из package-lock через `npm install --package-lock-only`;
  оставшиеся 2 упоминания в lock — это optional peerDependency самого `eve`, не наш пакет). Добавлены скрипты
  `memory`/`doctor` (`node --env-file=.env scripts/memory/*.ts`). `fast-glob` НЕ добавлен — в коде не
  референсится (хост-glob делает свой обход на `fs`). `ai`-pin/overrides/resolutions не тронуты.

### Gotchas / Open questions
- **`npm run memory daily`** — задокументировано как `npm run memory -- daily` (безопасная передача аргумента
  периода в rollup.ts через `--`).
- **deploy/ и scripts/memory/ на момент работы компонента F не существуют** (их создают другие компоненты).
  install.sh и package.json ссылаются на них «вперёд»; install.sh устойчив к отсутствию deploy-юнитов.
