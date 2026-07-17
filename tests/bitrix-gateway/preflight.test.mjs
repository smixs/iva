import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  parseTaskIdArgv,
  runReadStatePreflight,
} from '../../services/bitrix-gateway/preflight-read-state.mjs';
import { fakeWebhook, rawTask, ScriptedClient } from './helpers.mjs';

const taskSelect = [
  'ID',
  'GROUP_ID',
  'RESPONSIBLE_ID',
  'RESPONSIBLE',
  'ACCOMPLICE',
  'ACCOMPLICES',
  'CHAT_ID',
];
const context = { purpose: 'read_state_preflight' };

function readyResponse(method) {
  if (method === 'profile') {
    return { result: { ID: '42', NAME: 'Profile name must not leak' } };
  }
  if (method === 'scope') return { result: ['task', 'im'] };
  return null;
}

function dialogResponse(overrides = {}) {
  return {
    result: {
      dialog: {
        COUNTER: '2',
        UNREAD_ID: '100',
        LAST_ID: '101',
        LAST_MESSAGE_ID: '101',
        TITLE: 'Dialog title must not leak',
        MESSAGE: 'Dialog text must not leak',
        WEBHOOK: fakeWebhook(),
        ...overrides,
      },
    },
  };
}

test('known chat preflight authorizes first, reads exactly one message, and emits state-only evidence', async () => {
  let dialogReads = 0;
  const client = new ScriptedClient(({ method, params, context: callContext }) => {
    const ready = readyResponse(method);
    if (ready) {
      if (method === 'scope') assert.deepEqual(callContext, context);
      return ready;
    }
    if (method === 'tasks.task.get') {
      assert.equal(params.taskId, '123');
      assert.deepEqual(params.select, taskSelect);
      return {
        result: {
          task: rawTask({
            TITLE: 'Injected task text must not leak',
            DESCRIPTION: fakeWebhook(),
            CHAT_ID: '500',
          }),
        },
      };
    }
    if (method === 'im.dialog.get') {
      dialogReads += 1;
      assert.deepEqual(callContext, context);
      assert.deepEqual(params, { DIALOG_ID: 'chat500' });
      return dialogResponse();
    }
    if (method === 'im.dialog.messages.get') {
      assert.deepEqual(callContext, context);
      assert.deepEqual(params, { DIALOG_ID: 'chat500', LIMIT: 1 });
      return {
        result: {
          messages: [{
            ID: '101',
            MESSAGE: 'Message body must not leak',
            AUTHOR_NAME: 'Message author must not leak',
            URL: fakeWebhook(),
          }],
        },
      };
    }
    throw new Error(`Unexpected method ${method}`);
  });

  const result = await runReadStatePreflight('123', { client });

  assert.deepEqual(result, {
    ok: true,
    result: 'observed',
    task_id: '123',
    user_id: '42',
    chat_id: '500',
    evidence_complete: true,
    probe_discriminating: true,
    read_state_changed: false,
    before: {
      counter: 2,
      unread_id: '100',
      last_id: '101',
      last_message_id: '101',
    },
    after: {
      counter: 2,
      unread_id: '100',
      last_id: '101',
      last_message_id: '101',
    },
  });
  assert.equal(dialogReads, 2);
  assert.deepEqual(client.calls.map((call) => call.method), [
    'profile',
    'scope',
    'tasks.task.get',
    'im.dialog.get',
    'im.dialog.messages.get',
    'im.dialog.get',
  ]);
  assert.equal(client.calls.filter((call) => call.method === 'im.dialog.messages.get').length, 1);

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /unit-test-token|Injected task|Dialog title|Dialog text|Message body|Message author/iu);
  assert.deepEqual(Object.keys(result.before), ['counter', 'unread_id', 'last_id', 'last_message_id']);
  assert.deepEqual(Object.keys(result.after), ['counter', 'unread_id', 'last_id', 'last_message_id']);
});

test('changed dialog evidence compares only the four allowed state fields', async () => {
  let dialogReads = 0;
  const client = new ScriptedClient(({ method }) => {
    const ready = readyResponse(method);
    if (ready) return ready;
    if (method === 'tasks.task.get') return { result: { task: rawTask({ CHAT_ID: '500' }) } };
    if (method === 'im.dialog.messages.get') {
      return { result: { messages: [{ ID: '101', MESSAGE: 'Ignored' }] } };
    }
    if (method === 'im.dialog.get') {
      dialogReads += 1;
      return dialogReads === 1
        ? dialogResponse({ TITLE: 'Before title' })
        : dialogResponse({ COUNTER: '1', TITLE: 'After title' });
    }
    throw new Error(`Unexpected method ${method}`);
  });

  const result = await runReadStatePreflight('123', { client });
  assert.equal(result.evidence_complete, true);
  assert.equal(result.probe_discriminating, true);
  assert.equal(result.read_state_changed, true);
  assert.equal(result.before.counter, 2);
  assert.equal(result.after.counter, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(result.before, 'title'), false);
});

test('null unread ID is non-discriminating and does not read a message', async () => {
  const client = new ScriptedClient(({ method }) => {
    const ready = readyResponse(method);
    if (ready) return ready;
    if (method === 'tasks.task.get') return { result: { task: rawTask({ CHAT_ID: '500' }) } };
    if (method === 'im.dialog.get') return dialogResponse({ UNREAD_ID: null });
    throw new Error(`Unexpected method ${method}`);
  });

  const result = await runReadStatePreflight('123', { client });
  assert.equal(result.result, 'baseline_not_discriminating');
  assert.equal(result.evidence_complete, true);
  assert.equal(result.probe_discriminating, false);
  assert.equal(result.read_state_changed, false);
  assert.equal(result.before.unread_id, null);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'after'), false);
  assert.equal(client.calls.some((call) => call.method === 'im.dialog.messages.get'), false);
  assert.equal(client.calls.filter((call) => call.method === 'im.dialog.get').length, 1);
});


test('zero unread counter is non-discriminating and does not read a message', async () => {
  const client = new ScriptedClient(({ method }) => {
    const ready = readyResponse(method);
    if (ready) return ready;
    if (method === 'tasks.task.get') return { result: { task: rawTask({ CHAT_ID: '500' }) } };
    if (method === 'im.dialog.get') return dialogResponse({ COUNTER: '0' });
    throw new Error(`Unexpected method ${method}`);
  });

  const result = await runReadStatePreflight('123', { client });
  assert.equal(result.result, 'baseline_not_discriminating');
  assert.equal(result.evidence_complete, true);
  assert.equal(result.probe_discriminating, false);
  assert.equal(result.read_state_changed, false);
  assert.equal(result.before.counter, 0);
  assert.equal(client.calls.some((call) => call.method === 'im.dialog.messages.get'), false);
});
test('missing or malformed dialog IDs remain incomplete evidence', async (t) => {
  const scenarios = [
    {
      name: 'missing unread ID',
      response() {
        const response = dialogResponse();
        delete response.result.dialog.UNREAD_ID;
        return response;
      },
    },
    {
      name: 'malformed last ID',
      response() {
        return dialogResponse({ LAST_ID: 'not-an-id' });
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const client = new ScriptedClient(({ method }) => {
        const ready = readyResponse(method);
        if (ready) return ready;
        if (method === 'tasks.task.get') {
          return { result: { task: rawTask({ CHAT_ID: '500' }) } };
        }
        if (method === 'im.dialog.get') return scenario.response();
        throw new Error(`Unexpected method ${method}`);
      });

      const result = await runReadStatePreflight('123', { client });
      assert.equal(result.result, 'baseline_not_discriminating');
      assert.equal(result.evidence_complete, false);
      assert.equal(result.probe_discriminating, false);
      assert.equal(result.read_state_changed, false);
      assert.equal(client.calls.some((call) => call.method === 'im.dialog.messages.get'), false);
    });
  }
});


test('task group and role policy deny before any chat method', async (t) => {
  const scenarios = [
    {
      name: 'wrong group',
      task: rawTask({ GROUP_ID: '98' }),
      code: 'TASK_OUTSIDE_GROUP',
    },
    {
      name: 'not a participant',
      task: rawTask({
        RESPONSIBLE_ID: '99',
        RESPONSIBLE: { ID: '99', NAME: 'Other' },
        ACCOMPLICE: ['43'],
        ACCOMPLICES: [{ ID: '43', NAME: 'Helper' }],
      }),
      code: 'TASK_NOT_AUTHORIZED',
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const client = new ScriptedClient(({ method }) => {
        const ready = readyResponse(method);
        if (ready) return ready;
        if (method === 'tasks.task.get') return { result: { task: scenario.task } };
        throw new Error(`Policy should deny before ${method}`);
      });
      await assert.rejects(runReadStatePreflight('123', { client }), { code: scenario.code });
      assert.equal(client.calls.some((call) => call.method.startsWith('im.')), false);
    });
  }
});

test('chat resolution tries TASKS_TASK then TASKS and returns no_task_chat without a dialog read', async () => {
  const client = new ScriptedClient(({ method, params }) => {
    const ready = readyResponse(method);
    if (ready) return ready;
    if (method === 'tasks.task.get') return { result: { task: rawTask({ CHAT_ID: null }) } };
    if (method === 'im.chat.get') {
      assert.equal(params.ENTITY_ID, '123');
      assert.ok(['TASKS_TASK', 'TASKS'].includes(params.ENTITY_TYPE));
      return { result: null };
    }
    throw new Error(`Unexpected method ${method}`);
  });

  const result = await runReadStatePreflight('123', { client });
  assert.deepEqual(result, {
    ok: true,
    result: 'no_task_chat',
    task_id: '123',
    user_id: '42',
    chat_id: null,
    evidence_complete: false,
    probe_discriminating: false,
    read_state_changed: false,
  });
  assert.deepEqual(
    client.calls.filter((call) => call.method === 'im.chat.get').map((call) => call.params.ENTITY_TYPE),
    ['TASKS_TASK', 'TASKS'],
  );
  assert.equal(client.calls.some((call) => call.method.startsWith('im.dialog.')), false);
});

test('TASKS fallback is skipped when TASKS_TASK resolves the task chat', async () => {
  let dialogReads = 0;
  const client = new ScriptedClient(({ method, params }) => {
    const ready = readyResponse(method);
    if (ready) return ready;
    if (method === 'tasks.task.get') return { result: { task: rawTask({ CHAT_ID: null }) } };
    if (method === 'im.chat.get') {
      assert.equal(params.ENTITY_TYPE, 'TASKS_TASK');
      return { result: { ID: '501' } };
    }
    if (method === 'im.dialog.messages.get') return { result: { messages: [] } };
    if (method === 'im.dialog.get') {
      dialogReads += 1;
      return dialogResponse();
    }
    throw new Error(`Unexpected method ${method}`);
  });

  const result = await runReadStatePreflight('123', { client });
  assert.equal(result.chat_id, '501');
  assert.equal(dialogReads, 2);
  assert.deepEqual(
    client.calls.filter((call) => call.method === 'im.chat.get').map((call) => call.params.ENTITY_TYPE),
    ['TASKS_TASK'],
  );
});

test('missing scope stops before task lookup', async () => {
  const client = new ScriptedClient(({ method }) => {
    if (method === 'profile') return { result: { ID: '42' } };
    if (method === 'scope') return { result: ['task'] };
    throw new Error(`Scope should fail before ${method}`);
  });
  await assert.rejects(runReadStatePreflight('123', { client }), { code: 'SCOPE_MISSING' });
  assert.deepEqual(client.calls.map((call) => call.method), ['profile', 'scope']);
});

test('CLI accepts one canonical task ID and exposes no method selector', () => {
  assert.equal(parseTaskIdArgv(['123']), '123');
  for (const argv of [
    [],
    ['0'],
    ['00123'],
    ['-1'],
    ['im.dialog.messages.get'],
    ['--method'],
    ['123', 'im.dialog.messages.get'],
    ['123456789012345678901'],
  ]) {
    assert.throws(() => parseTaskIdArgv(argv), { code: 'INVALID_TASK_ID' });
  }
});

test('installer deploys the operator CLI as root-owned executable and never enables the read gate', async () => {
  const installer = await readFile(
    new URL('../../services/bitrix-gateway/deploy/install.sh', import.meta.url),
    'utf8',
  );
  const preflightSource = await readFile(
    new URL('../../services/bitrix-gateway/preflight-read-state.mjs', import.meta.url),
    'utf8',
  );
  assert.match(installer, /install -o root -g root -m 0755[\s\\]+[\s\S]*preflight-read-state\.mjs/iu);
  assert.match(installer, /sudo -u iva-bitrix \/usr\/bin\/node --env-file=\/etc\/iva-bitrix\/bitrix\.env[\s\S]*<task-id>/iu);
  assert.doesNotMatch(installer, /BITRIX_CHAT_READ_VERIFIED=true/iu);
  assert.doesNotMatch(preflightSource, /BITRIX_CHAT_READ_VERIFIED/iu);
  assert.doesNotMatch(preflightSource, /listen\(|createServer|socketPath/iu);
});
