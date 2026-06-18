# Деплой ассистента (Ева)

## Переменные окружения
Скопируй `.env.example` → `.env` и заполни. Минимум: `OLLAMA_API_KEY`.
Для Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`,
`TELEGRAM_DIGEST_CHAT_ID`.

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
node .output/server/index.mjs # или npm start (eve start); порт через PORT (по умолчанию 3000)
```
Запускай под process-manager (systemd/pm2) с подгрузкой `.env`. Пример systemd-юнита:
```ini
[Service]
WorkingDirectory=/srv/assistant
EnvironmentFile=/srv/assistant/.env
ExecStart=/usr/bin/node /srv/assistant/.output/server/index.mjs
Restart=always
```
Перед публичным доступом: nginx reverse-proxy + TLS (Let's Encrypt) на домен.

### Авторизация eve-канала в проде
Scaffold-канал использует `localDev()` + `placeholderAuth()`. В проде `localDev` игнорируется,
а `placeholderAuth` не пускает. Варианты: заменить на реальный провайдер (Auth.js/Clerk),
либо для приватного single-user сервера выдать bearer и настроить канал на него
(тогда cron-скрипту передавать `ASSISTANT_BEARER`).

## Telegram webhook
После деплоя на публичный HTTPS-домен зарегистрируй вебхук:
```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<домен>/eve/v1/telegram",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'",
       "allowed_updates":["message","callback_query"]}'
```
Свой `chat_id` для дайджеста: напиши боту, затем
`curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"` → поле `message.chat.id`.

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
