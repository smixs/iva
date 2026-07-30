export function notificationChat(env = process.env) {
  const digest = String(env.TELEGRAM_DIGEST_CHAT_ID ?? "").trim();
  if (digest) return digest;
  return String(env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(/[,\s]+/).map((id) => id.trim()).find(Boolean) ?? "";
}
