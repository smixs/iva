import { telegramChannel } from "eve/channels/telegram";

// Токен (TELEGRAM_BOT_TOKEN) и секрет вебхука (TELEGRAM_WEBHOOK_SECRET_TOKEN)
// читаются из окружения автоматически.
//
// БЕЗОПАСНОСТЬ: бот отвечает ТОЛЬКО доверенным Telegram user ID из
// TELEGRAM_ALLOWED_USER_IDS (через запятую). Это личный ассистент с приватными
// данными — без allowlist кто угодно мог бы вытащить их. Fail-closed: если список
// пуст, не пускается никто.
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean),
);

// Повторяет дефолтную логику диспатча eve (приваты — всегда; группы — только
// команда/упоминание/ответ боту; боты и каналы игнорируются).
function isBotCommand(text: string, bot?: string): boolean {
  const m = /^\/(?<command>[A-Za-z0-9_]+)(?:@(?<target>[A-Za-z0-9_]+))?(?:\s|$)/u.exec(text);
  if (!m) return false;
  const target = m.groups?.target;
  return target === undefined ? true : bot !== undefined && target.toLowerCase() === bot.toLowerCase();
}
function shouldDispatch(msg: any, bot?: string): boolean {
  if (msg.from?.isBot === true || msg.chat.type === "channel") return false;
  const text: string = msg.text || msg.caption || "";
  if (!(text.trim().length > 0 || msg.attachments.length > 0)) return false;
  return (
    msg.chat.type === "private" ||
    msg.replyToMessage?.from?.isBot === true ||
    isBotCommand(text, bot) ||
    (bot !== undefined && text.toLowerCase().includes(`@${bot.toLowerCase()}`))
  );
}

// Воспроизводит дефолтный auth-контекст eve для Telegram-актора.
function buildAuth(msg: any) {
  const u = msg.from;
  if (!u) return null;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const attributes: Record<string, string> = {
    chat_id: msg.chat.id,
    chat_type: msg.chat.type,
    message_id: msg.messageId,
    user_id: u.id,
  };
  if (msg.chat.title !== undefined) attributes.chat_title = msg.chat.title;
  if (msg.messageThreadId !== undefined) attributes.message_thread_id = String(msg.messageThreadId);
  if (u.username !== undefined) attributes.username = u.username;
  return {
    attributes,
    authenticator: "telegram-webhook",
    issuer: isGroup ? `telegram:${msg.chat.id}` : "telegram",
    principalId: isGroup ? `telegram:${msg.chat.id}:${u.id}` : `telegram:${u.id}`,
    principalType: u.isBot ? "service" : "user",
  };
}

export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME ?? "my_bot",
  uploadPolicy: {
    allowedMediaTypes: ["image/*", "application/pdf"],
    maxBytes: 10 * 1024 * 1024,
  },
  async onMessage(ctx, message) {
    const userId = message.from?.id;

    // 1. Allowlist — главный барьер доступа.
    if (ALLOWED.size === 0 || !userId || !ALLOWED.has(userId)) {
      // Вежливо отвечаем только в личке, чтобы человек мог передать свой ID владельцу.
      if (message.chat.type === "private") {
        const note =
          ALLOWED.size === 0
            ? "Бот ещё не настроен: владельцу нужно добавить Telegram ID в TELEGRAM_ALLOWED_USER_IDS."
            : `Нет доступа. Ваш Telegram ID: ${userId ?? "неизвестен"} — передайте владельцу, чтобы он добавил вас.`;
        try {
          await ctx.telegram.sendMessage(note);
        } catch {
          /* молча игнорируем сбой ответа */
        }
      }
      return null; // дропаем апдейт
    }

    // 2. Штатное гейтирование диспатча.
    if (!shouldDispatch(message, ctx.telegram.botUsername)) return null;
    await ctx.telegram.startTyping();
    return { auth: buildAuth(message) };
  },
});
