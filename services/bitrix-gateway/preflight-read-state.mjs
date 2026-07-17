#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { BitrixHttpClient } from './client.mjs';
import { GatewayError } from './errors.mjs';
import {
  extractChatId,
  hasField,
  idString,
  normalizeTask,
  pick,
  unwrapResult,
} from './normalize.mjs';
import { BitrixTaskPolicy } from './policy.mjs';

const READ_STATE_CONTEXT = Object.freeze({ purpose: 'read_state_preflight' });
const TASK_SELECT = Object.freeze([
  'ID',
  'GROUP_ID',
  'RESPONSIBLE_ID',
  'RESPONSIBLE',
  'ACCOMPLICE',
  'ACCOMPLICES',
  'CHAT_ID',
]);
const STATE_FIELDS = Object.freeze([
  'counter',
  'unread_id',
  'last_id',
  'last_message_id',
]);

function canonicalTaskId(value) {
  const taskId = String(value ?? '');
  if (!/^[1-9]\d*$/u.test(taskId) || taskId.length > 20) {
    throw new GatewayError('INVALID_TASK_ID', 'Task ID must be a positive numeric Bitrix ID.', {
      status: 400,
      category: 'invalid_request',
    });
  }
  return taskId;
}

export function parseTaskIdArgv(argv) {
  if (!Array.isArray(argv) || argv.length !== 1) return canonicalTaskId('');
  return canonicalTaskId(argv[0]);
}

function profileId(response) {
  return idString(pick(unwrapResult(response), 'ID', 'USER_ID'));
}

function normalizedScopes(response) {
  const result = unwrapResult(response);
  const raw = Array.isArray(result) ? result : (pick(result, 'SCOPE', 'SCOPES') ?? []);
  const scopes = Array.isArray(raw) ? raw : String(raw).split(',');
  return [...new Set(scopes.map((scope) => String(scope).trim().toLowerCase()).filter(Boolean))];
}

function hasRequiredScopes(scopes) {
  return (scopes.includes('task') || scopes.includes('tasks')) && scopes.includes('im');
}

function taskFromGet(response) {
  const result = unwrapResult(response);
  return pick(result, 'TASK') ?? result;
}

function positiveId(value) {
  const normalized = idString(value);
  return normalized && /^[1-9]\d*$/u.test(normalized) ? normalized : null;
}

function stateCounter(dialog) {
  if (!hasField(dialog, 'COUNTER')) return { value: null, valid: false };
  const value = pick(dialog, 'COUNTER');
  if (typeof value === 'number') {
    const valid = Number.isSafeInteger(value) && value >= 0;
    return { value: valid ? value : null, valid };
  }
  const text = String(value ?? '').trim();
  if (!/^\d+$/u.test(text)) return { value: null, valid: false };
  const parsed = Number(text);
  const valid = Number.isSafeInteger(parsed) && parsed >= 0;
  return { value: valid ? parsed : null, valid };
}

function stateId(dialog, field, { nullable = false } = {}) {
  if (!hasField(dialog, field)) return { value: null, valid: false };
  const raw = pick(dialog, field);
  if (nullable && raw === null) return { value: null, valid: true };
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { value: null, valid: false };
  }
  const value = idString(raw);
  return { value, valid: value !== null };
}

function dialogEvidence(response) {
  const result = unwrapResult(response);
  const dialog = pick(result, 'DIALOG') ?? result;
  const counter = stateCounter(dialog);
  const unreadId = stateId(dialog, 'UNREAD_ID', { nullable: true });
  const lastId = stateId(dialog, 'LAST_ID');
  const lastMessageId = stateId(dialog, 'LAST_MESSAGE_ID');
  return {
    state: {
      counter: counter.value,
      unread_id: unreadId.value,
      last_id: lastId.value,
      last_message_id: lastMessageId.value,
    },
    complete: counter.valid && unreadId.valid && lastId.valid && lastMessageId.valid,
  };
}

function stateChanged(before, after) {
  return STATE_FIELDS.some((field) => before[field] !== after[field]);
}
function hasDiscriminatingUnreadBaseline(evidence) {
  return Boolean(
    evidence.complete
    && Number.isSafeInteger(evidence.state.counter)
    && evidence.state.counter > 0
    && typeof evidence.state.unread_id === 'string'
    && /^[1-9]\d*$/u.test(evidence.state.unread_id),
  );
}


export async function runReadStatePreflight(taskId, {
  client = new BitrixHttpClient(),
  policy = new BitrixTaskPolicy(),
} = {}) {
  const normalizedTaskId = canonicalTaskId(taskId);

  const profile = await client.request('profile');
  const userId = positiveId(profileId(profile));
  if (!userId) {
    throw new GatewayError('PROFILE_INVALID', 'The Bitrix profile did not return a valid user ID.', {
      status: 503,
      category: 'preflight_failed',
    });
  }

  const scope = await client.request('scope', {}, READ_STATE_CONTEXT);
  if (!hasRequiredScopes(normalizedScopes(scope))) {
    throw new GatewayError('SCOPE_MISSING', 'The Bitrix webhook lacks one or more required read scopes.', {
      status: 503,
      category: 'preflight_failed',
    });
  }

  const taskResponse = await client.request('tasks.task.get', {
    taskId: normalizedTaskId,
    select: TASK_SELECT,
  });
  const task = normalizeTask(taskFromGet(taskResponse), { portalOrigin: client.portalOrigin });
  if (task.id !== normalizedTaskId) {
    throw new GatewayError('TASK_ID_MISMATCH', 'Bitrix returned a different task than requested.', {
      status: 502,
      category: 'invalid_response',
    });
  }
  policy.assert(task, userId);

  let chatId = positiveId(task.chatId);
  if (!chatId) {
    const tasksTask = await client.request('im.chat.get', {
      ENTITY_TYPE: 'TASKS_TASK',
      ENTITY_ID: normalizedTaskId,
    });
    chatId = positiveId(extractChatId(tasksTask));
  }
  if (!chatId) {
    const tasks = await client.request('im.chat.get', {
      ENTITY_TYPE: 'TASKS',
      ENTITY_ID: normalizedTaskId,
    });
    chatId = positiveId(extractChatId(tasks));
  }

  if (!chatId) {
    return {
      ok: true,
      result: 'no_task_chat',
      task_id: normalizedTaskId,
      user_id: userId,
      chat_id: null,
      evidence_complete: false,
      probe_discriminating: false,
      read_state_changed: false,
    };
  }

  const dialogId = `chat${chatId}`;
  const beforeEvidence = dialogEvidence(await client.request(
    'im.dialog.get',
    { DIALOG_ID: dialogId },
    READ_STATE_CONTEXT,
  ));
  const probeDiscriminating = hasDiscriminatingUnreadBaseline(beforeEvidence);
  if (!probeDiscriminating) {
    return {
      ok: true,
      result: 'baseline_not_discriminating',
      task_id: normalizedTaskId,
      user_id: userId,
      chat_id: chatId,
      evidence_complete: beforeEvidence.complete,
      probe_discriminating: false,
      read_state_changed: false,
      before: beforeEvidence.state,
    };
  }
  await client.request(
    'im.dialog.messages.get',
    { DIALOG_ID: dialogId, LIMIT: 1 },
    READ_STATE_CONTEXT,
  );
  const afterEvidence = dialogEvidence(await client.request(
    'im.dialog.get',
    { DIALOG_ID: dialogId },
    READ_STATE_CONTEXT,
  ));
  const before = beforeEvidence.state;
  const after = afterEvidence.state;

  return {
    ok: true,
    result: 'observed',
    task_id: normalizedTaskId,
    user_id: userId,
    chat_id: chatId,
    evidence_complete: beforeEvidence.complete && afterEvidence.complete,
    read_state_changed: stateChanged(before, after),
    probe_discriminating: true,
    before,
    after,
  };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await runReadStatePreflight(parseTaskIdArgv(argv));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const errorCode = error instanceof GatewayError ? error.code : 'INTERNAL_ERROR';
    process.stdout.write(`${JSON.stringify({ ok: false, result: 'error', error_code: errorCode })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
