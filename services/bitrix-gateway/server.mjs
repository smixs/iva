import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BitrixHttpClient } from './client.mjs';
import { GatewayError, toPublicError } from './errors.mjs';
import { BitrixReadOnlyGateway } from './gateway.mjs';

export const DEFAULT_SOCKET_PATH = '/run/iva-bitrix/gateway.sock';

function sendJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  response.end(payload);
}

function defaultLogger(entry) {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function logResult(logger, operation, taskId, startedAt, resultCategory) {
  logger({
    operation,
    taskId: taskId ?? null,
    durationMs: Math.max(0, Date.now() - startedAt),
    resultCategory,
  });
}

function listOptions(url) {
  const permitted = new Set(['status', 'search', 'limit', 'offset']);
  const counts = new Map();
  for (const key of url.searchParams.keys()) {
    if (!permitted.has(key)) {
      throw new GatewayError('INVALID_QUERY', 'The request contains an unknown query parameter.', {
        status: 400,
        category: 'invalid_request',
      });
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.get(key) > 1) {
      throw new GatewayError('INVALID_QUERY', 'Query parameters may not be repeated.', {
        status: 400,
        category: 'invalid_request',
      });
    }
  }
  const options = {
    status: url.searchParams.get('status') ?? undefined,
    search: url.searchParams.get('search') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  };
  if (options.limit !== undefined && (!/^\d+$/u.test(options.limit) || Number(options.limit) < 1 || Number(options.limit) > 100)) {
    throw new GatewayError('INVALID_QUERY', 'limit must be an integer from 1 to 100.', {
      status: 400,
      category: 'invalid_request',
    });
  }
  if (options.offset !== undefined && (!/^\d+$/u.test(options.offset) || !Number.isSafeInteger(Number(options.offset)))) {
    throw new GatewayError('INVALID_QUERY', 'offset must be a nonnegative integer.', {
      status: 400,
      category: 'invalid_request',
    });
  }
  return options;
}

export function createRequestHandler({ gateway, logger = defaultLogger } = {}) {
  if (!gateway) throw new TypeError('gateway is required');
  return async function requestHandler(request, response) {
    const startedAt = Date.now();
    let operation = 'unknown';
    let taskId = null;
    try {
      if (request.method !== 'GET') {
        operation = 'reject_method';
        sendJson(response, 405, {
          ok: false,
          error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported by the Bitrix gateway.' },
        }, { allow: 'GET' });
        logResult(logger, operation, taskId, startedAt, 'method_not_allowed');
        return;
      }

      const url = new URL(request.url ?? '/', 'http://unix-socket');
      if (url.pathname === '/health' && url.search === '') {
        operation = 'health';
        const result = await gateway.health();
        sendJson(response, 200, result);
        logResult(logger, operation, taskId, startedAt, 'ok');
        return;
      }
      if (url.pathname === '/v1/tasks') {
        operation = 'list_tasks';
        const result = await gateway.listTasks(listOptions(url));
        sendJson(response, 200, result);
        logResult(logger, operation, taskId, startedAt, 'ok');
        return;
      }
      if (url.pathname === '/v1/tasks/active') {
        operation = 'list_active_tasks';
        if (url.search !== '') {
          throw new GatewayError('INVALID_QUERY', 'The daily task endpoint does not accept query parameters.', {
            status: 400,
            category: 'invalid_request',
          });
        }
        const result = await gateway.listActiveTasks();
        sendJson(response, 200, result);
        logResult(logger, operation, taskId, startedAt, 'ok');
        return;
      }
      const snapshotMatch = /^\/v1\/tasks\/([1-9]\d*)\/snapshot$/u.exec(url.pathname);
      if (snapshotMatch && url.search === '') {
        operation = 'task_snapshot';
        taskId = snapshotMatch[1];
        const result = await gateway.taskSnapshot(taskId);
        sendJson(response, 200, result);
        logResult(logger, operation, taskId, startedAt, 'ok');
        return;
      }

      operation = 'reject_path';
      sendJson(response, 404, {
        ok: false,
        error: { code: 'NOT_FOUND', message: 'The requested Bitrix gateway endpoint does not exist.' },
      });
      logResult(logger, operation, taskId, startedAt, 'not_found');
    } catch (error) {
      const normalized = toPublicError(error, gateway.client?.webhookUrl);
      sendJson(response, normalized.status, normalized.body);
      logResult(logger, operation, taskId, startedAt, normalized.category);
    }
  };
}

async function removeStaleSocket(socketPath) {
  try {
    const details = await lstat(socketPath);
    if (!details.isSocket()) throw new Error('Refusing to replace a non-socket gateway path.');
    await unlink(socketPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function startServer({ env = process.env, logger = defaultLogger, gateway } = {}) {
  const socketPath = env.BITRIX_GATEWAY_SOCKET || DEFAULT_SOCKET_PATH;
  if (!path.isAbsolute(socketPath) || socketPath.includes('\u0000')) {
    throw new Error('BITRIX_GATEWAY_SOCKET must be an absolute path.');
  }
  const activeGateway = gateway ?? new BitrixReadOnlyGateway({ client: new BitrixHttpClient({ env }) });
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o750 });
  await removeStaleSocket(socketPath);
  const server = http.createServer(createRequestHandler({ gateway: activeGateway, logger }));

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
  await chmod(socketPath, 0o660);
  return { server, socketPath, gateway: activeGateway };
}

async function main() {
  const { server, socketPath } = await startServer();
  const shutdown = () => {
    server.close(async () => {
      try { await unlink(socketPath); } catch (error) { if (error?.code !== 'ENOENT') process.exitCode = 1; }
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Bitrix gateway failed to start.\n');
    process.exitCode = 1;
  });
}
