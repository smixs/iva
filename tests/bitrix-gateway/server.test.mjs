import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayError } from '../../services/bitrix-gateway/errors.mjs';
import { createRequestHandler } from '../../services/bitrix-gateway/server.mjs';
import { fakeWebhook } from './helpers.mjs';

async function invoke(handler, { method = 'GET', url = '/' } = {}) {
  const response = {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') { this.body += body; },
  };
  await handler({ method, url }, response);
  return { ...response, json: JSON.parse(response.body) };
}

test('server exposes only fixed GET endpoints and validates numeric task paths before gateway access', async () => {
  const snapshots = [];
  let activeListCalls = 0;
  const gateway = {
    client: { webhookUrl: fakeWebhook() },
    health: async () => ({ ok: true, ready: true, userId: '42', scopes: ['im', 'profile', 'task'] }),
    listTasks: async (options) => ({ ok: true, userId: '42', tasks: [{ id: String(options.offset) }], total: 8 }),
    listActiveTasks: async () => {
      activeListCalls += 1;
      return { ok: true, userId: '42', tasks: [{ id: 'all' }], total: 1 };
    },
    taskSnapshot: async (taskId) => {
      snapshots.push(taskId);
      return { ok: true, snapshot: { task: { id: taskId }, discussion: { source: 'none', messages: [] } } };
    },
  };
  const logs = [];
  const handler = createRequestHandler({ gateway, logger: (entry) => logs.push(entry) });

  const health = await invoke(handler, { url: '/health' });
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, ready: true, userId: '42', scopes: ['im', 'profile', 'task'] });

  const list = await invoke(handler, { url: '/v1/tasks?status=all&limit=10&offset=7' });
  assert.equal(list.status, 200);
  assert.equal(list.json.tasks[0].id, '7');
  const active = await invoke(handler, { url: '/v1/tasks/active' });
  assert.equal(active.status, 200);
  assert.equal(active.json.tasks[0].id, 'all');
  assert.equal(activeListCalls, 1);
  assert.equal((await invoke(handler, { url: '/v1/tasks/active?limit=1' })).status, 400);

  assert.equal((await invoke(handler, { url: '/v1/tasks/123/snapshot' })).status, 200);
  for (const url of [
    '/v1/tasks/0/snapshot',
    '/v1/tasks/-1/snapshot',
    '/v1/tasks/001/snapshot',
    '/v1/tasks/123%2F..%2F456/snapshot',
    '/v1/tasks/123/snapshot?method=tasks.task.update',
    '/v1/tasks/active/',
    '/v1/tasks/daily',
    '/v1/method/tasks.task.update',
  ]) {
    assert.equal((await invoke(handler, { url })).status, 404);
  }
  assert.deepEqual(snapshots, ['123']);
  assert.equal((await invoke(handler, { method: 'POST', url: '/v1/tasks' })).status, 405);
  assert.equal((await invoke(handler, { method: 'POST', url: '/v1/tasks/active' })).status, 405);
  assert.equal((await invoke(handler, { url: '/v1/tasks?unknown=secret' })).status, 400);
  assert.equal((await invoke(handler, { url: '/v1/tasks?limit=1.5' })).status, 400);
  assert.equal((await invoke(handler, { url: '/v1/tasks?offset=-1' })).status, 400);

  for (const entry of logs) {
    assert.deepEqual(Object.keys(entry).sort(), ['durationMs', 'operation', 'resultCategory', 'taskId']);
  }
});

test('server returns fixed error schema and masks webhook material from body and logs', async () => {
  const webhook = fakeWebhook();
  const logs = [];
  const gateway = {
    client: { webhookUrl: webhook },
    health: async () => {
      throw new GatewayError('UPSTREAM_TEST', 'Failed at ' + webhook, {
        status: 503,
        category: 'upstream_test',
      });
    },
  };
  const result = await invoke(createRequestHandler({ gateway, logger: (entry) => logs.push(entry) }), { url: '/health' });
  assert.equal(result.status, 503);
  assert.deepEqual(Object.keys(result.json), ['ok', 'error']);
  assert.equal(result.json.ok, false);
  assert.doesNotMatch(result.body, /unit-test-token/u);
  assert.doesNotMatch(JSON.stringify(logs), /unit-test-token/u);
  assert.equal(logs[0].resultCategory, 'upstream_test');
});
