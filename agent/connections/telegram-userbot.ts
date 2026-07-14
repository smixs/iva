// Подключение к локальному telegram-userbot прокси (services/telegram-userbot/serve.py):
// личный Telegram-аккаунт владельца через Telethon (userbot). Прокси — единственный
// владелец сессии, живёт как systemd-сервис на 127.0.0.1. Тулы видны модели как
// connection__telegram-userbot__<tool> и находятся через connection_search.
//
// Онбординг (QR-логин) и правила безопасности — в скилле telegram-userbot.
// URL/токен модель НЕ видит: они на стороне рантайма.
import { defineMcpClientConnection } from "eve/connections";

const port = process.env.TELEGRAM_MCP_PORT ?? "8724";

export default defineMcpClientConnection({
  url: `http://127.0.0.1:${port}/mcp`,
  description:
    "Личный Telegram владельца (userbot, НЕ бот-аккаунт): читать диалоги/историю/поиск " +
    "и отправлять сообщения от его имени. Требует подключения аккаунта через QR " +
    "(скилл telegram-userbot). Соблюдай анти-бан правила из скилла.",
  auth: {
    getToken: async () => ({ token: process.env.TELEGRAM_MCP_TOKEN ?? "" }),
  },
});
