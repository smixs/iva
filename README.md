<div align="center">

# 🤖 Ева — личный ассистент-агент

**Durable AI-агент на [eve](https://eve.dev) + [Ollama Cloud](https://ollama.com/cloud) (DeepSeek-V4-Pro).**
Личность · скиллы · субагенты · MCP-ready · Telegram · cron — всё как файлы в TypeScript-проекте.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Built with eve](https://img.shields.io/badge/built%20with-eve-black)](https://eve.dev)
[![Model: Ollama Cloud](https://img.shields.io/badge/model-Ollama%20Cloud-blue)](https://ollama.com/cloud)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/smixs/eve-assistant/pulls)

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/eve-assistant/main/install.sh | bash
```

</div>

---

## Что это

Полноценный личный ассистент, который работает на подписке **Ollama Cloud** с открытыми моделями
(DeepSeek-V4-Pro и др.) вместо проприетарных API. Один скрипт ставит всё на VPS: зависимости,
интерактивный выбор модели, ключ, сборку и автозапуск.

## ✨ Возможности

- 🧠 **Любая модель Ollama Cloud** — интерактивный выбор из актуального списка (35+ моделей: DeepSeek, Qwen, GLM, Kimi, MiniMax, gpt-oss…)
- 🎭 **Личность** — настраиваемый system prompt (`agent/instructions.md`)
- 🛠️ **Tools** — типизированные действия (пример: менеджер задач с durable-хранилищем)
- 📚 **Скиллы** — load-on-demand процедуры (`load_skill`), прогрессивное раскрытие контекста
- 🤝 **Субагенты** — специалисты со своей моделью и структурным выводом (пример: `planner`)
- 🔌 **MCP-ready** — подключение внешних MCP/OpenAPI серверов (токены модель не видит)
- 💬 **Telegram-гейтвей** — бот, вложения, HITL inline-кнопки
- 🔒 **Allowlist по user ID** — бот отвечает только доверенным (fail-closed), приватные данные защищены
- ⏰ **Cron** — ежедневный дайджест (system cron на VPS / Vercel Cron)
- 💾 **Durable execution** — сессии переживают краши и рестарты
- 🖥️ **Dev TUI** — интерактивный терминал для отладки tool-loop

## 🚀 Установка одной командой

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/eve-assistant/main/install.sh | bash
```

Скрипт сам:
1. поставит **Node 24+** (через nvm, без root);
2. склонирует репозиторий и установит зависимости;
3. запустит **интерактивную настройку** — спросит ключ, покажет **актуальные модели Ollama Cloud** и даст выбрать;
4. соберёт агента (`eve build`);
5. (опц.) заведёт **systemd**-сервис для автозапуска.

### Вручную

```bash
git clone https://github.com/smixs/eve-assistant.git && cd eve-assistant
npm ci
npm run setup     # интерактивно: ключ + выбор модели + Telegram
npm run build
npm start         # прод-сервер (eve start)
# или: npm run dev — интерактивный TUI
```

## 🎛️ Интерактивная настройка (`npm run setup`)

`scripts/setup.mjs` обращается к `https://ollama.com/v1/models` по вашему ключу, показывает
**живой список доступных моделей** и даёт выбрать номером, затем (опц.) настраивает Telegram
и пишет `.env`. Никаких внешних зависимостей.

```
  Доступно моделей: 35

    1. deepseek-v3.2
   10. deepseek-v4-pro      ★ рекомендуется
   ...
  Выбери модель (номер) [10]:
```

## ⚙️ Конфигурация (`.env`)

| Переменная | Назначение |
|---|---|
| `OLLAMA_API_KEY` | Ключ Ollama Cloud (обязателен) |
| `OLLAMA_MODEL` | id модели, напр. `deepseek-v4-pro` |
| `OLLAMA_CONTEXT_WINDOW` | Размер окна (по умолч. 131072) |
| `TELEGRAM_BOT_TOKEN` · `TELEGRAM_BOT_USERNAME` · `TELEGRAM_WEBHOOK_SECRET_TOKEN` | Telegram-бот |
| `TELEGRAM_DIGEST_CHAT_ID` | Куда слать утренний дайджест |
| `ASSISTANT_DATA_DIR` | Хранилище задач (по умолч. `./data`) |

См. [`.env.example`](.env.example).

## 🧩 Архитектура

```
Telegram / Dev TUI / HTTP
          │
      eve harness  ──►  DeepSeek-V4-Pro (Ollama Cloud, /v1)
          │
   ┌──────┼─────────┬───────────┬──────────┐
 tools  skills   subagents   channels   schedules
(tasks) (digest) (planner)  (telegram)   (cron)
```

Запрос → eve harness ведёт tool-loop на выбранной модели → вызывает tools, грузит скиллы,
делегирует субагентам → durable-сессия переживает рестарт.

## 📁 Структура

```
agent/
├── agent.ts              # модель (Ollama Cloud) + конфиг
├── instructions.md       # личность
├── tools/tasks.ts        # пример tool (durable JSON)
├── skills/morning-digest.md
├── subagents/planner/    # субагент со structured output
└── channels/telegram.ts  # гейтвей
scripts/
├── setup.mjs             # интерактивная настройка
├── daily-digest.ts       # cron-дайджест
└── smoke-test.mjs        # проверка tool-loop
install.sh                # установка одной командой
DEPLOY.md                 # VPS / Vercel / webhook / cron
```

## 🔒 Безопасность доступа

Личный ассистент хранит приватные данные, поэтому Telegram-бот отвечает **только доверенным
пользователям** из `TELEGRAM_ALLOWED_USER_IDS`. Логика — в [`agent/channels/telegram.ts`](agent/channels/telegram.ts):

- **Fail-closed:** пустой allowlist = бот не отвечает никому.
- Недоверенному в личке приходит его собственный Telegram ID (чтобы передать владельцу); апдект дропается до запуска агента.
- `npm run setup` определяет твой ID автоматически (через `getUpdates`) и кладёт в allowlist.
- Вебхук дополнительно защищён секрет-токеном (`X-Telegram-Bot-Api-Secret-Token`).

Проверено: апдейт от недоверённого user ID не доходит до модели (0 вызовов), от доверенного — обрабатывается.

## 🚢 Деплой

Self-host на VPS (`eve build` + `eve start` под systemd) или Vercel. Telegram webhook, system cron,
прод-авторизация — в [DEPLOY.md](DEPLOY.md).

## 🗺️ Roadmap

- [ ] MCP-подключения (Gmail, Calendar, Notion) — слой `agent/connections/`
- [ ] Прод-авторизация eve-канала (Auth.js / Clerk / bearer)
- [ ] Вынос задач в БД/KV для serverless

## 🧰 Стек

eve · Vercel AI SDK · `@ai-sdk/openai-compatible` · Ollama Cloud · TypeScript · Node 24 · Zod

## 📄 Лицензия

[MIT](LICENSE) © [smixs](https://github.com/smixs)

---

<sub>Keywords: AI agent, eve framework, Ollama Cloud, DeepSeek-V4-Pro, open-source LLM agent,
Telegram bot, personal assistant, MCP, durable agent, self-hosted AI, TypeScript agent,
agent framework, LLM tool calling, cron AI, Vercel AI SDK.</sub>
