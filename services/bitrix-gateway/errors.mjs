const WEBHOOK_PATTERN = /https:\/\/[^\s"'<>]+\/rest\/\d+\/[^/\s"'<>]+\/?/giu;

export class GatewayError extends Error {
  constructor(code, message, { status = 500, category = code.toLowerCase(), retryAt, cause } = {}) {
    super(message, { cause });
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
    this.category = category;
    this.retryAt = retryAt;
  }
}

export function maskWebhook(value, webhookUrl = '') {
  let message = String(value ?? '');

  if (webhookUrl) {
    for (const secret of new Set([
      webhookUrl,
      webhookUrl.replace(/\/$/u, ''),
      encodeURI(webhookUrl),
      encodeURIComponent(webhookUrl),
    ])) {
      if (secret) message = message.replaceAll(secret, '[REDACTED_WEBHOOK]');
    }

    try {
      const parsed = new URL(webhookUrl);
      const secretPath = parsed.pathname.replace(/\/$/u, '');
      if (secretPath) message = message.replaceAll(secretPath, '/rest/[REDACTED]');
    } catch {
      // Invalid webhook values are rejected by the client constructor.
    }
  }

  return message.replace(WEBHOOK_PATTERN, '[REDACTED_WEBHOOK]');
}

export function toPublicError(error, webhookUrl = '') {
  if (error instanceof GatewayError) {
    const publicError = {
      code: error.code,
      message: maskWebhook(error.message, webhookUrl),
    };
    if (error.retryAt) publicError.retryAt = error.retryAt;
    return { status: error.status, category: error.category, body: { ok: false, error: publicError } };
  }

  return {
    status: 500,
    category: 'internal_error',
    body: {
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The Bitrix gateway could not complete the request.',
      },
    },
  };
}
