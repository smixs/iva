import { GatewayError, maskWebhook } from './errors.mjs';

const READ_METHODS = new Set([
  'profile',
  'scope',
  'tasks.task.list',
  'tasks.task.get',
  'task.checklistitem.getlist',
  'im.chat.get',
  'im.dialog.get',
  'im.dialog.messages.get',
]);

const LEGACY_COMMENT_METHOD = 'task.commentitem.getlist';
const READ_STATE_PREFLIGHT_PURPOSE = 'read_state_preflight';
const DEFAULT_OVERLOAD_RETRY_MS = 10 * 60_000;
const DEFAULT_MAX_RETRY_WINDOW_MS = 24 * 60 * 60_000;

function boundedBackoff(attempt, baseDelayMs, maxDelayMs) {
  return Math.min(baseDelayMs * (2 ** (attempt - 1)), maxDelayMs);
}

function serverRetryWindow(response, nowMs, maxRetryWindowMs) {
  const header = response?.headers?.get?.('retry-after');
  if (header === null || header === undefined || String(header).trim() === '') return null;
  const value = String(header).trim();
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, maxRetryWindowMs);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(0, at - nowMs), maxRetryWindowMs);
}

function retryAt(delayMs, now) {
  return new Date(now() + delayMs).toISOString();
}

function isExactReadStatePreflight(context) {
  return Boolean(
    context
    && typeof context === 'object'
    && context.purpose === READ_STATE_PREFLIGHT_PURPOSE
    && Object.keys(context).length === 1,
  );
}

function isCanonicalDialogId(value) {
  return /^chat[1-9]\d*$/u.test(String(value ?? ''));
}

function assertReadStatePreflightParams(method, params) {
  const keys = Object.keys(params ?? {}).sort();
  if (method === 'im.dialog.get') {
    if (keys.length !== 1 || keys[0] !== 'DIALOG_ID' || !isCanonicalDialogId(params.DIALOG_ID)) {
      throw new GatewayError('METHOD_NOT_ALLOWED', 'Read-state preflight dialog parameters are fixed.', {
        status: 403,
        category: 'allowlist_denied',
      });
    }
    return;
  }
  if (
    keys.length !== 2
    || keys[0] !== 'DIALOG_ID'
    || keys[1] !== 'LIMIT'
    || !isCanonicalDialogId(params.DIALOG_ID)
    || params.LIMIT !== 1
  ) {
    throw new GatewayError('METHOD_NOT_ALLOWED', 'Read-state preflight message parameters are fixed.', {
      status: 403,
      category: 'allowlist_denied',
    });
  }
}

function errorCode(payload) {
  return String(payload?.error ?? payload?.error_code ?? '').toUpperCase();
}

function responseTooLarge() {
  return new GatewayError('BITRIX_RESPONSE_TOO_LARGE', 'Bitrix returned a response larger than the gateway safety limit.', {
    status: 502,
    category: 'invalid_response',
  });
}

async function readJsonBounded(response, maxBytes) {
  const declared = Number(response?.headers?.get?.('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw responseTooLarge();

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLarge();
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  }

  if (typeof response?.text === 'function') {
    const body = await response.text();
    if (Buffer.byteLength(body) > maxBytes) throw responseTooLarge();
    return JSON.parse(body);
  }

  // Test doubles may expose only json(); production Node fetch responses use
  // the bounded ReadableStream path above.
  return response.json();
}

export class BitrixHttpClient {
  constructor({
    env = process.env,
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000,
    maxAttempts = 3,
    baseDelayMs = 100,
    maxDelayMs = 2_000,
    maxRetryWindowMs = DEFAULT_MAX_RETRY_WINDOW_MS,
    overloadRetryMs = DEFAULT_OVERLOAD_RETRY_MS,
    maxResponseBytes = 8 * 1024 * 1024,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = () => Date.now(),
  } = {}) {
    const webhookUrl = env?.BITRIX_WEBHOOK_URL;
    if (!webhookUrl) {
      throw new GatewayError('CONFIG_MISSING', 'BITRIX_WEBHOOK_URL is not configured.', {
        status: 503,
        category: 'configuration_error',
      });
    }

    let parsed;
    try {
      parsed = new URL(webhookUrl);
    } catch {
      throw new GatewayError('CONFIG_INVALID', 'BITRIX_WEBHOOK_URL is invalid.', {
        status: 503,
        category: 'configuration_error',
      });
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
      throw new GatewayError('CONFIG_INVALID', 'BITRIX_WEBHOOK_URL must be an HTTPS URL without embedded credentials.', {
        status: 503,
        category: 'configuration_error',
      });
    }

    this.webhookUrl = parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
    this.portalOrigin = parsed.origin;
    this.chatReadVerified = String(env.BITRIX_CHAT_READ_VERIFIED ?? '').trim().toLowerCase() === 'true';
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Math.min(Number(timeoutMs) || 10_000, 60_000));
    this.maxAttempts = Math.max(1, Math.min(Number(maxAttempts) || 3, 5));
    this.baseDelayMs = Math.max(0, Number(baseDelayMs) || 0);
    this.maxDelayMs = Math.max(this.baseDelayMs, Number(maxDelayMs) || 0);
    this.maxRetryWindowMs = Math.max(
      this.maxDelayMs,
      Math.min(Number(maxRetryWindowMs) || DEFAULT_MAX_RETRY_WINDOW_MS, DEFAULT_MAX_RETRY_WINDOW_MS),
    );
    this.overloadRetryMs = Math.max(
      this.maxDelayMs,
      Math.min(Number(overloadRetryMs) || DEFAULT_OVERLOAD_RETRY_MS, this.maxRetryWindowMs),
    );
    this.maxResponseBytes = Math.max(1, Math.min(Number(maxResponseBytes) || 8 * 1024 * 1024, 16 * 1024 * 1024));
    this.sleep = sleep;
    this.now = now;
  }

  async request(method, params = {}, context = {}) {
    if (!READ_METHODS.has(method)) {
      throw new GatewayError('METHOD_NOT_ALLOWED', 'The requested Bitrix method is not allowed.', {
        status: 403,
        category: 'allowlist_denied',
      });
    }
    const readStatePreflight = isExactReadStatePreflight(context);
    if (
      method === 'scope'
      && context.purpose !== 'preflight'
      && context.purpose !== 'health'
      && !readStatePreflight
    ) {
      throw new GatewayError('METHOD_NOT_ALLOWED', 'The Bitrix scope method is limited to gateway preflight.', {
        status: 403,
        category: 'allowlist_denied',
      });
    }
    if (method === 'im.dialog.get') {
      if (!readStatePreflight) {
        throw new GatewayError('METHOD_NOT_ALLOWED', 'The Bitrix dialog method is limited to read-state preflight.', {
          status: 403,
          category: 'allowlist_denied',
        });
      }
      assertReadStatePreflightParams(method, params);
    }
    if (method === 'im.dialog.messages.get' && readStatePreflight) {
      assertReadStatePreflightParams(method, params);
    } else if (method === 'im.dialog.messages.get' && !this.chatReadVerified) {
      throw new GatewayError(
        'CHAT_READ_STATE_UNVERIFIED',
        'Bitrix chat reads are disabled until their read-state behavior is explicitly verified.',
        {
          status: 503,
          category: 'chat_read_state_unverified',
        },
      );
    }
    return this.#perform(method, params);
  }

  async getLegacyComments(params, resolution) {
    const authorized = (
      resolution?.taskChatIdNull === true
      && resolution?.tasksTaskNull === true
      && resolution?.tasksNull === true
      && resolution?.commentsIndicated === true
    );
    if (!authorized) {
      throw new GatewayError('METHOD_NOT_ALLOWED', 'Legacy task comments are allowed only after chat resolution is exhausted.', {
        status: 403,
        category: 'allowlist_denied',
      });
    }
    return this.#perform(LEGACY_COMMENT_METHOD, params);
  }

  async #perform(method, params) {
    const endpoint = new URL(`${method}.json`, this.webhookUrl).href;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response;
      let payload;
      try {
        response = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(params ?? {}),
          signal: controller.signal,
        });
        try {
          payload = await readJsonBounded(response, this.maxResponseBytes);
        } catch (error) {
          if (error instanceof GatewayError) throw error;
          payload = null;
        }
      } catch (cause) {
        clearTimeout(timer);
        if (cause instanceof GatewayError) throw cause;
        if (attempt < this.maxAttempts) {
          const delay = boundedBackoff(attempt, this.baseDelayMs, this.maxDelayMs);
          await this.sleep(delay);
          continue;
        }
        const delay = boundedBackoff(attempt, this.baseDelayMs, this.maxDelayMs);
        throw new GatewayError('BITRIX_UNAVAILABLE', 'Bitrix is temporarily unavailable.', {
          status: 503,
          category: 'network_error',
          retryAt: retryAt(delay, this.now),
          cause: new Error(maskWebhook(cause?.message, this.webhookUrl)),
        });
      } finally {
        clearTimeout(timer);
      }

      const code = errorCode(payload);
      const denied = response.status === 401 || response.status === 403 || /(?:ACCESS|AUTH|SCOPE|PERMISSION)/u.test(code);
      if (denied) {
        throw new GatewayError('BITRIX_ACCESS_DENIED', 'Bitrix denied this read request.', {
          status: 403,
          category: 'access_denied',
        });
      }
      const overload = code === 'OVERLOAD_LIMIT';
      const retryable = !overload && (
        response.status === 429
        || response.status >= 500
        || code === 'QUERY_LIMIT_EXCEEDED'
      );
      const limited = response.status === 429 || code === 'QUERY_LIMIT_EXCEEDED';
      const serverWindow = serverRetryWindow(response, this.now(), this.maxRetryWindowMs);

      if (retryable && attempt < this.maxAttempts) {
        if (serverWindow !== null && serverWindow > this.maxDelayMs) {
          throw new GatewayError(
            limited ? 'BITRIX_RATE_LIMITED' : 'BITRIX_UNAVAILABLE',
            limited ? 'Bitrix is temporarily rate limited.' : 'Bitrix is temporarily unavailable.',
            {
              status: 503,
              category: limited ? 'rate_limited' : 'upstream_unavailable',
              retryAt: retryAt(serverWindow, this.now),
            },
          );
        }
        const delay = serverWindow ?? boundedBackoff(attempt, this.baseDelayMs, this.maxDelayMs);
        await this.sleep(delay);
        continue;
      }

      if (retryable) {
        const delay = serverWindow ?? boundedBackoff(attempt, this.baseDelayMs, this.maxDelayMs);
        throw new GatewayError(
          limited ? 'BITRIX_RATE_LIMITED' : 'BITRIX_UNAVAILABLE',
          limited ? 'Bitrix is temporarily rate limited.' : 'Bitrix is temporarily unavailable.',
          {
            status: 503,
            category: limited ? 'rate_limited' : 'upstream_unavailable',
            retryAt: retryAt(delay, this.now),
          },
        );
      }
      if (overload) {
        throw new GatewayError('BITRIX_OVERLOAD_LIMIT', 'Bitrix rejected the request because its overload limit was reached.', {
          status: 503,
          category: 'overload_limit',
          retryAt: retryAt(this.overloadRetryMs, this.now),
        });
      }
      if (!response.ok || code) {
        throw new GatewayError('BITRIX_REQUEST_FAILED', 'Bitrix could not complete this read request.', {
          status: 502,
          category: 'upstream_error',
        });
      }
      if (!payload || typeof payload !== 'object') {
        throw new GatewayError('BITRIX_INVALID_RESPONSE', 'Bitrix returned an invalid response.', {
          status: 502,
          category: 'invalid_response',
        });
      }
      return payload;
    }

    throw new GatewayError('BITRIX_UNAVAILABLE', 'Bitrix is temporarily unavailable.', {
      status: 503,
      category: 'network_error',
    });
  }
}

export const BITRIX_READ_METHODS = Object.freeze([...READ_METHODS]);
