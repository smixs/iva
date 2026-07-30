export interface ProviderErrorText {
  readonly en: string;
  readonly ru: string;
}

interface ProviderErrorInput {
  readonly message: string;
  readonly details?: unknown;
}

const RETRY_WRAPPER =
  /^\s*AI_RetryError:\s*Failed after \d+ attempts?\.\s*Last error:\s*/iu;
const GIST_LIMIT = 120;

function stripRetryWrapper(text: string): string {
  return text.replace(RETRY_WRAPPER, "").trim();
}

function detailsText(details: unknown): string {
  if (typeof details === "string") return stripRetryWrapper(details);
  if (details === undefined || details === null) return "";
  try {
    return JSON.stringify(details);
  } catch {
    return "";
  }
}

function resetAfter(text: string): string | undefined {
  const match = /resets\s+in\s+([^.;\n"'}`\]]+)/iu.exec(text);
  const reset = match?.[1]?.trim();
  return reset ? reset : undefined;
}

function maskTelegramBotToken(text: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return token ? text.split(token).join("***") : text;
}

function firstLineGist(message: string): string {
  const unwrapped = maskTelegramBotToken(stripRetryWrapper(message));
  const firstLine = (unwrapped.split(/\r?\n/u, 1)[0] ?? "").trim().replace(/\s+/gu, " ");
  const gist = firstLine || "Unknown provider error";
  return gist.length <= GIST_LIMIT
    ? gist
    : `${gist.slice(0, GIST_LIMIT - 1).trimEnd()}…`;
}

export function humanizeProviderError({
  message,
  details,
}: ProviderErrorInput): ProviderErrorText {
  const unwrappedMessage = stripRetryWrapper(message);
  const evidence = `${unwrappedMessage}\n${detailsText(details)}`;

  if (/usage\s+limit\s+reached|rate[ _-]?limit|\b429\b/iu.test(evidence)) {
    const reset = resetAfter(evidence);
    return reset
      ? {
          en: `Provider limit exhausted - resets in ${reset}; wait or switch models: /model`,
          ru: `Лимит провайдера исчерпан - сброс через ${reset}; подожди или смени модель: /model`,
        }
      : {
          en: "Provider limit exhausted - wait or switch models: /model",
          ru: "Лимит провайдера исчерпан - подожди или смени модель: /model",
        };
  }

  if (/insufficient[ _-]?credits|billing|\b402\b/iu.test(evidence)) {
    return {
      en: "Provider balance/plan exhausted - top up or switch models: /model",
      ru: "Баланс/тариф провайдера исчерпан - пополни или смени модель: /model",
    };
  }

  if (/invalid[ _-]?api[ _-]?key|unauthorized|\b(?:401|403)\b/iu.test(evidence)) {
    return {
      en: "Provider key does not work - check it in /menu",
      ru: "Ключ провайдера не работает - проверь его в /menu",
    };
  }

  if (
    /upstream\s+request\s+failed|\b5(?:\d{2}|xx)\b|overloaded|internal\s+server\s+error/iu.test(
      evidence,
    )
  ) {
    return {
      en: "Provider-side failure - try again in a couple of minutes",
      ru: "Сбой на стороне провайдера - попробуй через пару минут",
    };
  }

  if (
    /timeout|ECONNRESET|ETIMEDOUT|fetch\s+failed|stream(?:\s+was)?\s+aborted/iu.test(
      evidence,
    )
  ) {
    return {
      en: "Provider is not responding - try again later",
      ru: "Провайдер не отвечает - попробуй позже",
    };
  }

  if (/context\s+length|too\s+many\s+tokens|maximum\s+context/iu.test(evidence)) {
    return {
      en: "The turn failed (the context may have overflowed). Commands: /new — start over, /restart — restart.",
      ru: "Ход не удался (возможно, переполнился контекст). Команды: /new — начать заново, /restart — перезапустить.",
    };
  }

  const gist = firstLineGist(message);
  return {
    en: `Turn failed: ${gist}`,
    ru: `Ход упал: ${gist}`,
  };
}
