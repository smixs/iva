import { telegramChannel } from "eve/channels/telegram";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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

// Для медиа text/attachments пусты (eve не парсит голос/видео в attachments),
// поэтому обычный shouldDispatch их всегда отбрасывает (строка с проверкой длины).
// Гейтим по чату: личка — всегда; группа/супергруппа — только реплай боту,
// команда или @упоминание в подписи. Иначе в группе чужой голос ушёл бы в Deepgram.
function shouldDispatchMedia(msg: any, bot?: string): boolean {
  if (msg.from?.isBot === true || msg.chat.type === "channel") return false;
  if (msg.chat.type === "private") return true;
  const caption: string = msg.caption || "";
  return (
    msg.replyToMessage?.from?.isBot === true ||
    isBotCommand(caption, bot) ||
    (bot !== undefined && caption.toLowerCase().includes(`@${bot.toLowerCase()}`))
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

// --- Сырой транскрипт: дозапись реплики в дневной файл vault ---
//
// САМОДОСТАТОЧНО: только node-builtins (fs/path/Intl). Тот же хелпер продублирован
// в agent/hooks/transcript.ts — общий модуль НЕ выносим (cross-authored import
// ломает `eve dev` 0.11.4). Формат d_brain: `## HH:MM [type]` + контент.
// Дата/время — в часовом поясе пользователя (ASSISTANT_TIMEZONE, иначе локальный TZ).
function appendDaily(type: string, content: string): void {
  const tz = process.env.ASSISTANT_TIMEZONE || undefined;
  const now = new Date();
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const dir = join(process.env.ASSISTANT_VAULT_DIR || "vault", "daily");
  mkdirSync(dir, { recursive: true });
  // Append-only: существующие записи никогда не переписываются.
  appendFileSync(join(dir, `${localDate}.md`), `\n## ${hhmm} ${type}\n${content}\n`, "utf8");
}

// --- Deepgram: транскрипция голоса/видео (nova-3, language=multi) ---
//
// Инлайн (НЕ общий модуль — см. выше). Тело — сырые байты, ответ →
// results.channels[0].alternatives[0].transcript.
async function transcribe(audio: ArrayBuffer): Promise<string> {
  const language = process.env.DEEPGRAM_LANGUAGE || "multi";
  const url =
    `https://api.deepgram.com/v1/listen?model=nova-3&language=${language}` +
    `&punctuate=true&smart_format=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY ?? ""}`,
      "Content-Type": "application/octet-stream",
    },
    body: audio,
  });
  if (!res.ok) throw new Error(`Deepgram HTTP ${res.status}`);
  const json = (await res.json()) as {
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
  };
  return json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}

// Голос/видео eve НЕ парсит как attachments (только photo/document) — берём из raw.
// Метка определяет и префикс контекста, и [type] в daily.
const MEDIA_KINDS: ReadonlyArray<readonly [string, "voice" | "video"]> = [
  ["voice", "voice"],
  ["audio", "voice"],
  ["video", "video"],
  ["video_note", "video"],
  ["animation", "video"],
];

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

    // 2. Голос/видео → Deepgram. Берём file_id из raw (eve их не парсит в attachments).
    const raw = message.raw as Record<string, { file_id?: string } | undefined>;
    let media: { fileId: string; label: "voice" | "video" } | null = null;
    for (const [key, label] of MEDIA_KINDS) {
      const obj = raw[key];
      if (obj && typeof obj.file_id === "string") {
        media = { fileId: obj.file_id, label };
        break;
      }
    }

    if (media) {
      // Гейтим медиа как обычный диспатч (в группе — только обращённое к боту).
      if (!shouldDispatchMedia(message, ctx.telegram.botUsername)) return null;
      const tag = `[${media.label}]`;
      const caption = (message.caption || "").trim();
      await ctx.telegram.startTyping();
      try {
        // getFile → file_path. Файлы >20MB Bot API не отдаёт (getFile вернёт ошибку).
        const fileRes = await ctx.telegram.request("getFile", { file_id: media.fileId });
        const fileBody = fileRes.body as
          | { ok?: boolean; description?: string; result?: { file_path?: string } }
          | null;
        const filePath = fileBody?.result?.file_path;

        if (!filePath) {
          const desc = String(fileBody?.description ?? "");
          if (/too big/i.test(desc)) {
            // Грациозный фолбэк: фиксируем факт + подпись, отвечаем юзеру, дропаем апдейт.
            const note = `(файл >20MB — Telegram не отдаёт его ботам)${caption ? `\n\n${caption}` : ""}`;
            appendDaily(tag, note);
            try {
              await ctx.telegram.sendMessage(
                "Файл больше 20 МБ — Telegram не отдаёт такие ботам. " +
                  "Подпись сохранил; перешли файл иначе (ссылкой/частями).",
              );
            } catch {
              /* молча игнорируем сбой ответа */
            }
            return null;
          }
          throw new Error(`getFile failed: ${desc || "no file_path"}`);
        }

        // Скачиваем байты напрямую с file-эндпоинта Telegram.
        const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
        const dl = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
        if (!dl.ok) throw new Error(`download HTTP ${dl.status}`);
        const audio = await dl.arrayBuffer();

        const transcript = (await transcribe(audio)).trim();
        if (!transcript) {
          try {
            await ctx.telegram.sendMessage("Не удалось распознать запись — пусто.");
          } catch {
            /* молча игнорируем сбой ответа */
          }
          return null;
        }

        // Сырой транскрипт юзера → daily; расшифровка долетает до Евы через context[].
        appendDaily(tag, transcript);
        return { auth: buildAuth(message), context: [`${tag} ${transcript}`] };
      } catch (err) {
        try {
          await ctx.telegram.sendMessage(
            `Не смог обработать запись: ${String((err as Error).message ?? err).slice(0, 200)}`,
          );
        } catch {
          /* молча игнорируем сбой ответа */
        }
        return null;
      }
    }

    // 3. Штатное гейтирование диспатча (текст/фото/документы).
    if (!shouldDispatch(message, ctx.telegram.botUsername)) return null;

    // Сырой транскрипт: текстовая реплика юзера → daily.
    const userText = (message.text || "").trim();
    if (userText) appendDaily("[text]", userText);

    await ctx.telegram.startTyping();
    return { auth: buildAuth(message) };
  },
});
