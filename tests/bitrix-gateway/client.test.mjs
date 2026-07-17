import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BITRIX_READ_METHODS,
  BitrixHttpClient,
  maskWebhook,
  toPublicError,
} from '../../services/bitrix-gateway/index.mjs';
import { fakeWebhook, jsonResponse } from './helpers.mjs';

function clientWith(fetchImpl, overrides = {}) {
  return new BitrixHttpClient({
    env: { BITRIX_WEBHOOK_URL: fakeWebhook() },
    fetchImpl,
    sleep: async () => {},
    baseDelayMs: 1,
    maxDelayMs: 1,
    ...overrides,
  });
}

test('runtime allowlist rejects writes, generic legacy comments, and non-preflight scope before fetch', async () => {
  let fetchCalls = 0;
  const client = clientWith(async () => {
    fetchCalls += 1;
    return jsonResponse({ result: {} });
  });

  await assert.rejects(client.request('tasks.task.update', { taskId: '123' }), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(client.request('task.commentitem.add', { taskId: '123' }), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(client.request('im.dialog.read', { DIALOG_ID: 'chat1' }), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(client.request('im.dialog.unread', { DIALOG_ID: 'chat1' }), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(client.request('task.commentitem.getlist', { TASKID: '123' }), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(client.request('scope'), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(client.getLegacyComments({ TASKID: '123' }, {
    taskChatIdNull: true,
    tasksTaskNull: true,
    tasksNull: false,
    commentsIndicated: true,
  }), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(fetchCalls, 0);
  assert.deepEqual([...BITRIX_READ_METHODS].sort(), [
    'im.chat.get',
    'im.dialog.get',
    'im.dialog.messages.get',
    'profile',
    'scope',
    'task.checklistitem.getlist',
    'tasks.task.get',
    'tasks.task.list',
  ]);
});

test('legacy comments require the complete, positive chat-resolution gate', async () => {
  const urls = [];
  const client = clientWith(async (url) => {
    urls.push(url);
    return jsonResponse({ result: [] });
  });
  await client.getLegacyComments({ TASKID: '123' }, {
    taskChatIdNull: true,
    tasksTaskNull: true,
    tasksNull: true,
    commentsIndicated: true,
  });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /task\.commentitem\.getlist\.json$/u);
});

test('documented chat-history reads are allowed without enabling any read-state method', async () => {
  let fetchCalls = 0;
  const client = clientWith(async () => {
    fetchCalls += 1;
    return jsonResponse({ result: { messages: [] } });
  });
  await client.request('im.dialog.messages.get', { DIALOG_ID: 'chat1' });
  assert.equal(fetchCalls, 1);
  assert.equal(BITRIX_READ_METHODS.includes('im.dialog.read'), false);
  assert.equal(BITRIX_READ_METHODS.includes('im.dialog.unread'), false);
});

test('read-state preflight bypass requires the exact context and fixed dialog parameters', async () => {
  const calls = [];
  const client = clientWith(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return jsonResponse({ result: {} });
  });
  const context = { purpose: 'read_state_preflight' };

  await assert.rejects(client.request('im.dialog.get', { DIALOG_ID: 'chat1' }), {
    code: 'METHOD_NOT_ALLOWED',
  });
  await assert.rejects(client.request('im.dialog.get', { DIALOG_ID: 'chat1' }, { purpose: 'preflight' }), {
    code: 'METHOD_NOT_ALLOWED',
  });
  await assert.rejects(client.request(
    'im.dialog.get',
    { DIALOG_ID: 'chat1' },
    { purpose: 'read_state_preflight', extra: true },
  ), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(client.request('im.dialog.get', { DIALOG_ID: '1' }, context), {
    code: 'METHOD_NOT_ALLOWED',
  });
  await assert.rejects(client.request(
    'im.dialog.messages.get',
    { DIALOG_ID: 'chat1', LIMIT: 2 },
    context,
  ), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(client.request(
    'im.dialog.messages.get',
    { DIALOG_ID: 'chat1', LIMIT: 1, LAST_ID: '99' },
    context,
  ), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(calls.length, 0);

  await client.request('scope', {}, context);
  await client.request('im.dialog.get', { DIALOG_ID: 'chat1' }, context);
  await client.request('im.dialog.messages.get', { DIALOG_ID: 'chat1', LIMIT: 1 }, context);

  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /scope\.json$/u);
  assert.match(calls[1].url, /im\.dialog\.get\.json$/u);
  assert.match(calls[2].url, /im\.dialog\.messages\.get\.json$/u);
  assert.deepEqual(calls[2].body, { DIALOG_ID: 'chat1', LIMIT: 1 });
});

test('webhook is sourced only from env and is masked from errors and public output', async () => {
  assert.throws(() => new BitrixHttpClient({ env: {}, fetchImpl: async () => {} }), { code: 'CONFIG_MISSING' });
  const webhook = fakeWebhook();
  const client = clientWith(async () => {
    throw new Error('network failed at ' + webhook);
  }, { maxAttempts: 1 });

  let caught;
  try {
    await client.request('profile');
  } catch (error) {
    caught = error;
  }
  assert(caught);
  assert.doesNotMatch(String(caught.cause?.message), /unit-test-token/u);
  assert.doesNotMatch(maskWebhook('failure ' + webhook, webhook), /unit-test-token/u);
  assert.doesNotMatch(JSON.stringify(toPublicError(caught, webhook)), /unit-test-token/u);
});

test('retries only network, 429, QUERY_LIMIT_EXCEEDED, and 5xx', async (t) => {
  await t.test('network error retries', async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('socket reset');
      return jsonResponse({ result: { ID: '42' } });
    });
    await client.request('profile');
    assert.equal(calls, 2);
  });

  for (const scenario of [
    { name: '429', first: jsonResponse({ error: 'TOO_MANY_REQUESTS' }, { status: 429 }) },
    { name: 'query limit', first: jsonResponse({ error: 'QUERY_LIMIT_EXCEEDED' }) },
    { name: '5xx', first: jsonResponse({ error: 'TEMPORARY' }, { status: 503 }) },
  ]) {
    await t.test(scenario.name + ' retries', async () => {
      let calls = 0;
      const client = clientWith(async () => {
        calls += 1;
        return calls === 1 ? scenario.first : jsonResponse({ result: { ID: '42' } });
      });
      await client.request('profile');
      assert.equal(calls, 2);
    });
  }

  await t.test('OVERLOAD_LIMIT does not retry and returns a conservative retry window', async () => {
    const nowMs = Date.UTC(2026, 6, 17, 9, 0, 0);
    const sleeps = [];
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return jsonResponse({ error: 'OVERLOAD_LIMIT' }, { status: 503 });
    }, {
      now: () => nowMs,
      sleep: async (delay) => sleeps.push(delay),
    });
    await assert.rejects(client.request('profile'), {
      code: 'BITRIX_OVERLOAD_LIMIT',
      retryAt: new Date(nowMs + 10 * 60_000).toISOString(),
    });
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  });

  await t.test('permission error does not retry', async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return jsonResponse({ error: 'ACCESS_DENIED' }, { status: 403 });
    });
    await assert.rejects(client.request('profile'), { code: 'BITRIX_ACCESS_DENIED' });
    assert.equal(calls, 1);
  });

  await t.test('exhausted 5xx is unavailable, not rate limited', async () => {
    const client = clientWith(async () => jsonResponse({ error: 'TEMPORARY' }, { status: 503 }), { maxAttempts: 2 });
    await assert.rejects(client.request('profile'), { code: 'BITRIX_UNAVAILABLE' });
  });

  await t.test('access denial is never retried even when paired with 5xx', async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return jsonResponse({ error: 'ACCESS_DENIED' }, { status: 503 });
    });
    await assert.rejects(client.request('profile'), { code: 'BITRIX_ACCESS_DENIED' });
    assert.equal(calls, 1);
  });

  await t.test('long Retry-After is persisted without a bounded sleep or immediate retry', async () => {
    const nowMs = Date.UTC(2026, 6, 17, 9, 0, 0);
    const sleeps = [];
    let calls = 0;
    const client = clientWith(
      async () => {
        calls += 1;
        return jsonResponse({ error: 'QUERY_LIMIT_EXCEEDED' }, {
          status: 429,
          headers: { 'retry-after': '60' },
        });
      },
      {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 2_000,
        now: () => nowMs,
        sleep: async (delay) => sleeps.push(delay),
      },
    );
    await assert.rejects(client.request('profile'), {
      code: 'BITRIX_RATE_LIMITED',
      retryAt: new Date(nowMs + 60_000).toISOString(),
    });
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  });

  await t.test('short Retry-After sleeps within the bound and retries once', async () => {
    let nowMs = Date.UTC(2026, 6, 17, 9, 0, 0);
    const sleeps = [];
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: 'QUERY_LIMIT_EXCEEDED' }, { status: 429, headers: { 'retry-after': '1' } })
        : jsonResponse({ result: { ID: '42' } });
    }, {
      maxAttempts: 3,
      maxDelayMs: 2_000,
      now: () => nowMs,
      sleep: async (delay) => {
        sleeps.push(delay);
        nowMs += delay;
      },
    });
    await client.request('profile');
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [1_000]);
  });
});

test('upstream JSON responses are rejected before parsing when they exceed the byte cap', async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    const body = JSON.stringify({ result: 'x'.repeat(200) });
    return {
      status: 200,
      ok: true,
      headers: { get: (name) => String(name).toLowerCase() === 'content-length' ? String(Buffer.byteLength(body)) : null },
      async text() { return body; },
    };
  }, { maxResponseBytes: 64 });
  await assert.rejects(client.request('profile'), { code: 'BITRIX_RESPONSE_TOO_LARGE' });
  assert.equal(calls, 1);
});
