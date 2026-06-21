# Деплой Iva

## Установка одной командой (bare VPS)
```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva/main/install.sh | bash
```
`install.sh` сам ставит системные зависимости (`git`, `gh`, `python3`, `ffmpeg`), `uv`,
Node 24+ (nvm), npm-зависимости, проводит интерактивную настройку (`setup.mjs`), собирает
агента, инициализирует vault как git-репо и заводит systemd user-сервис + таймеры памяти.
Если нужны системные пакеты — пароль `sudo` запрашивается один раз в начале. Ввод читается
из `/dev/tty`, поэтому `curl | bash` работает интерактивно.

## Переменные окружения
Скопируй `.env.example` → `.env` и заполни (или запусти `npm run setup`). Минимум:
`OLLAMA_API_KEY`, `DEEPGRAM_API_KEY`.
- Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`,
  `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_DIGEST_CHAT_ID`.
- Deepgram: `DEEPGRAM_API_KEY`, `DEEPGRAM_LANGUAGE` (дефолт `multi` — авто ru/uz/en).
- Память/время: `ASSISTANT_TIMEZONE` (IANA, дефолт `Asia/Almaty` — даты транскрипта, таймеры,
  динамическая инструкция `now`), `ASSISTANT_VAULT_DIR` (дефолт `vault`).

## Доступ к хосту (без sandbox)
На self-host у Iva host-native тулзы (`bash`/`read_file`/`write_file`/`glob`/`grep`) — они
выполняются прямо на VPS через Node `fs`/`child_process`, без microsandbox/Docker. Это полный
shell + файловый доступ к серверу. Защита периметра — allowlist Telegram (`TELEGRAM_ALLOWED_USER_IDS`,
fail-closed): писать Iva могут только доверенные ID. По желанию запускай сервис под отдельным
non-root пользователем.

## Голос и видео (Deepgram)
Голосовые, видео-кружки, аудио и видео из Telegram автоматически транскрибируются (Deepgram
nova-3, `language=multi`) перед попаданием к Iva и записываются в дневной транскрипт vault.
Нужен `DEEPGRAM_API_KEY`. Файлы >20 MB Bot API не отдаёт — обрабатывается грациозным фолбэком.

## Vault (память + git-бэкап)
`ASSISTANT_VAULT_DIR` — отдельный приватный git-репо (память Iva + Obsidian). `install.sh`
делает `git init` и кладёт `.gitignore`. Привязку к приватному remote и бэкап настраивает
пользователь один раз при первом запуске:
```bash
gh auth login
gh repo create <user>/iva-vault --private --source="$VAULT_DIR" --remote=origin --push
```
`scripts/memory/doctor.ts` коммитит и пушит память после обработки; если remote/credentials
не настроены — шлёт в Telegram напоминание выполнить `gh auth login`.

## Локальная разработка
```bash
npm run dev            # интерактивный TUI (eve dev), сервер на http://127.0.0.1:2000
# headless:  npm exec -- eve dev --no-ui --logs all
```
Проверка tool-loop без Telegram: `node scripts/smoke-test.mjs`.

> ВНИМАНИЕ: `eve dev` (v0.11.4) падает, если в `agent/` есть handler-schedule, импортирующий
> другой authored-модуль (например канал). Поэтому активного `agent/schedules/*.ts` в проекте нет —
> на VPS расписания всё равно не запускаются (они только для Vercel). Cron на VPS — через system cron
> (ниже). Vercel-вариант расписания — в конце файла.

## Self-host на VPS (`eve build` + `eve start`)
```bash
npm ci
npm exec -- eve build         # → ./.output
node .output/server/index.mjs # или npm start (eve start); порт через PORT/NITRO_PORT (дефолт Nitro 3000)
                              # 8723 задаёт не сервер, а юнит/.env от iva (PORT=$IVA_PORT)
```
Запускай под process-manager (systemd/pm2) с подгрузкой `.env`. Пример systemd-юнита:
```ini
[Service]
WorkingDirectory=/srv/assistant
EnvironmentFile=/srv/assistant/.env
ExecStart=/usr/bin/node /srv/assistant/.output/server/index.mjs
Environment=PORT=8723   # literal: systemd не подставит $IVA_PORT из .env; должен совпадать с IVA_PORT
Restart=always
```
(Юнит, который генерирует сам `iva`, уже бакает `Environment=PORT=$IVA_PORT` — этот ручной пример нужно держать в синхроне.)
Перед публичным доступом: nginx reverse-proxy + TLS (Let's Encrypt) на домен.

### Авторизация eve-канала в проде
Scaffold-канал использует `localDev()` + `placeholderAuth()`. В проде `localDev` игнорируется,
а `placeholderAuth` не пускает. Варианты: заменить на реальный провайдер (Auth.js/Clerk),
либо для приватного single-user сервера выдать bearer и настроить канал на него
(тогда cron-скрипту передавать `ASSISTANT_BEARER`).

## Telegram: polling (по умолчанию)
Бот работает через **long-polling** — отдельный процесс сам забирает апдейты у Telegram и
скармливает их локальному eve. **Домен/HTTPS/reverse-proxy не нужны.** `install.sh` ставит и
запускает сервис `iva-telegram-poll`; вручную — `npm run poll`. Статус/логи:
```bash
systemctl --user status iva-telegram-poll
journalctl --user -u iva-telegram-poll -f
```
Реализация: `scripts/telegram-poll.mjs` (`getUpdates` → `POST 127.0.0.1:$IVA_PORT/eve/v1/telegram`
с заголовком `X-Telegram-Bot-Api-Secret-Token`). Offset хранится в `data/telegram-offset.json`.

### Webhook (опционально, если есть публичный HTTPS)
Polling и webhook взаимоисключающи. Хочешь webhook — выключи мост
(`systemctl --user disable --now iva-telegram-poll`) и зарегистрируй вебхук:
```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<домен>/eve/v1/telegram",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'",
       "allowed_updates":["message","callback_query"]}'
```

### Доступ (важно)
Бот отвечает только ID из `TELEGRAM_ALLOWED_USER_IDS` (через запятую). Пусто = не отвечает
никому (fail-closed). `npm run setup` определит твой ID автоматически. Менять список можно в
`.env` без пересборки (перезапусти процесс). `getUpdates` работает только пока вебхук не
зарегистрирован — определяй ID до `setWebhook`.

## Cron на VPS (утренний дайджест)
`scripts/daily-digest.ts` берёт дайджест у агента (`eve/client`) и шлёт в Telegram. system cron:
```cron
0 5 * * *  cd /srv/assistant && node --env-file=.env scripts/daily-digest.ts >> /var/log/assistant-cron.log 2>&1
```
(05:00 UTC ≈ 10:00 Алматы. Агент должен быть запущен.)

## Система памяти — systemd-таймеры (DAG-роллапы)
> eve-расписания (`defineSchedule`) на self-host НЕ срабатывают — они становятся Vercel Cron
> только на Vercel. Поэтому роллапы памяти крутятся через systemd user-таймеры, которые драйвят
> Iva через `eve/client`.

`install.sh` устанавливает юниты из `deploy/iva-memory-*.{service,timer}` в
`~/.config/systemd/user/` и включает их (`systemctl --user enable --now`, `loginctl enable-linger`).
`OnCalendar` берёт `TZ` из `EnvironmentFile=.env` (`ASSISTANT_TIMEZONE`). Таймеры:

| Таймер | Когда | Что делает |
|--------|-------|-----------|
| `iva-memory-daily`   | ночью     | транскрипт дня → карточки + daily-summary, отчёт в Telegram |
| `iva-memory-weekly`  | Вс ночью  | 7 daily-summary → weekly-summary + MOC, отчёт в Telegram |
| `iva-memory-monthly` | 1-е число | weekly → monthly-summary |
| `iva-memory-yearly`  | 1 января  | monthly → yearly-summary |
| `iva-memory-doctor`  | ночью     | autograph health/decay/moc/dedup + `git commit && push` vault |

Ручной прогон: `npm run memory -- daily` (или `weekly`/`monthly`/`yearly`), `npm run doctor`.
Статус: `systemctl --user list-timers`.

## Если переедешь на Vercel — нативное расписание
На Vercel `defineSchedule` сам станет Vercel Cron Job. Создай `agent/schedules/morning.ts`:
```ts
import { defineSchedule } from "eve/schedules";
import telegram from "../channels/telegram.js";

export default defineSchedule({
  cron: "0 5 * * *", // UTC
  async run({ receive, waitUntil, appAuth }) {
    const chatId = process.env.TELEGRAM_DIGEST_CHAT_ID;
    if (!chatId) return;
    waitUntil(
      receive(telegram, {
        message: "Загрузи скилл morning-digest и собери утренний дайджест по задачам пользователя.",
        target: { chatId },
        auth: appAuth,
      }),
    );
  },
});
```
Тогда `scripts/daily-digest.ts` + system cron не нужны. (На Vercel хранилище задач из ./data —
эфемерно: для прод-Vercel задачи надо вынести в БД/KV.)
