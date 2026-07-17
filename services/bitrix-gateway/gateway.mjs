import { GatewayError } from './errors.mjs';
import {
  dedupeAndSortMessages,
  extractChatId,
  idString,
  normalizeChatMessages,
  normalizeChecklist,
  normalizeLegacyComments,
  normalizeTask,
  pick,
  publicTask,
  responseNext,
  responseRows,
  unwrapResult,
} from './normalize.mjs';
import { BitrixTaskPolicy, REQUIRED_GROUP_ID } from './policy.mjs';

const TASK_SELECT = Object.freeze([
  'ID', 'TITLE', 'DESCRIPTION', 'GROUP_ID', 'STATUS', 'REAL_STATUS',
  'CREATED_BY', 'CREATOR', 'RESPONSIBLE_ID', 'RESPONSIBLE',
  'ACCOMPLICE', 'ACCOMPLICES', 'DEADLINE', 'CHANGED_DATE', 'CLOSED_DATE',
  'CHAT_ID', 'COMMENTS_COUNT',
]);

const LIST_SELECT = Object.freeze([
  'ID', 'TITLE', 'GROUP_ID', 'STATUS', 'REAL_STATUS', 'RESPONSIBLE_ID',
  'RESPONSIBLE', 'ACCOMPLICE', 'ACCOMPLICES', 'DEADLINE', 'CHANGED_DATE', 'CLOSED_DATE',
]);

function profileId(response) {
  return idString(pick(unwrapResult(response), 'ID', 'USER_ID'));
}

function normalizedScopes(response) {
  const result = unwrapResult(response);
  const raw = Array.isArray(result) ? result : (pick(result, 'SCOPE', 'SCOPES') ?? []);
  const scopes = Array.isArray(raw) ? raw : String(raw).split(',');
  return [...new Set(scopes.map((scope) => String(scope).trim().toLowerCase()).filter(Boolean))].sort();
}

function hasRequiredScopes(scopes) {
  return (scopes.includes('task') || scopes.includes('tasks'))
    && scopes.includes('im');
}

function taskFromGet(response) {
  const result = unwrapResult(response);
  return pick(result, 'TASK') ?? result;
}

function isClosed(task) {
  return task.closed === true;
}

function summary(task, role) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    realStatus: task.realStatus,
    closed: task.closed,
    deadline: task.deadline,
    role,
    changedAt: task.changedAt,
  };
}

function parseListOptions(options = {}) {
  const status = String(options.status ?? 'active').toLowerCase();
  if (!['active', 'completed', 'all'].includes(status)) {
    throw new GatewayError('INVALID_QUERY', 'status must be active, completed, or all.', {
      status: 400,
      category: 'invalid_request',
    });
  }
  const rawLimit = String(options.limit ?? '50');
  const limit = Number.parseInt(rawLimit, 10);
  if (!/^\d+$/u.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new GatewayError('INVALID_QUERY', 'limit must be an integer from 1 to 100.', {
      status: 400,
      category: 'invalid_request',
    });
  }
  const rawOffset = String(options.offset ?? '0');
  const offset = Number.parseInt(rawOffset, 10);
  if (!/^\d+$/u.test(rawOffset) || !Number.isSafeInteger(offset) || offset < 0) {
    throw new GatewayError('INVALID_QUERY', 'offset must be a nonnegative integer.', {
      status: 400,
      category: 'invalid_request',
    });
  }
  const search = String(options.search ?? '').trim();
  if (search.length > 200) {
    throw new GatewayError('INVALID_QUERY', 'search must contain at most 200 characters.', {
      status: 400,
      category: 'invalid_request',
    });
  }
  return { status, limit, offset, search };
}

export class BitrixReadOnlyGateway {
  constructor({ client, policy = new BitrixTaskPolicy(), maxPages = 100 } = {}) {
    if (!client) throw new TypeError('client is required');
    this.client = client;
    this.policy = policy;
    this.maxPages = Math.max(1, Math.min(Number(maxPages) || 100, 100));
    this.readyPromise = null;
  }

  async health() {
    const state = await this.#ready();
    return { ok: true, ready: true, userId: state.userId, scopes: state.scopes };
  }

  async listTasks(options = {}) {
    const query = parseListOptions(options);
    const { userId, tasks } = await this.#authorizedTasks(query);
    return {
      ok: true,
      userId,
      tasks: tasks.slice(query.offset, query.offset + query.limit),
      total: tasks.length,
    };
  }

  async listActiveTasks() {
    const { userId, tasks } = await this.#authorizedTasks({ status: 'active', search: '' });
    return { ok: true, userId, tasks, total: tasks.length };
  }

  async #authorizedTasks(query) {
    const { userId } = await this.#ready();
    const [responsibleRows, accompliceRows] = await Promise.all([
      this.#listRole('RESPONSIBLE_ID', userId, query.search, query.status),
      this.#listRole('ACCOMPLICE', userId, query.search, query.status),
    ]);

    const tasksById = new Map();
    for (const raw of [...responsibleRows, ...accompliceRows]) {
      const task = normalizeTask(raw, { portalOrigin: this.client.portalOrigin });
      if (task.id) tasksById.set(task.id, task);
    }

    const tasks = [];
    for (const task of tasksById.values()) {
      const decision = this.policy.evaluate(task, userId);
      if (!decision.allowed) continue;
      if (query.search && !task.title.toLocaleLowerCase().includes(query.search.toLocaleLowerCase())) continue;
      // The public completed filter name is retained for compatibility; its
      // semantics are all terminal/closed tasks, including declined tasks.
      const closed = isClosed(task);
      if (query.status === 'active' && closed) continue;
      if (query.status === 'completed' && !closed) continue;
      tasks.push(summary(task, decision.role));
    }
    tasks.sort((left, right) => String(right.changedAt ?? '').localeCompare(String(left.changedAt ?? '')) || Number(right.id) - Number(left.id));
    return { userId, tasks };
  }

  async taskSnapshot(taskId) {
    const normalizedTaskId = this.#assertTaskId(taskId);
    const { userId } = await this.#ready();
    const rawResponse = await this.client.request('tasks.task.get', {
      taskId: normalizedTaskId,
      select: TASK_SELECT,
    });
    const task = normalizeTask(taskFromGet(rawResponse), { portalOrigin: this.client.portalOrigin });
    if (task.id !== normalizedTaskId) {
      throw new GatewayError('TASK_ID_MISMATCH', 'Bitrix returned a different task than requested.', {
        status: 502,
        category: 'invalid_response',
      });
    }
    this.policy.assert(task, userId);

    const checklistResponse = await this.client.request('task.checklistitem.getlist', {
      TASKID: normalizedTaskId,
      order: { SORT_INDEX: 'ASC', ID: 'ASC' },
    });
    const checklist = normalizeChecklist(checklistResponse);
    const discussion = await this.#discussion(task);

    return {
      ok: true,
      snapshot: {
        task: publicTask(task, checklist),
        discussion,
      },
    };
  }

  async #ready() {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const [profile, scope] = await Promise.all([
          this.client.request('profile'),
          this.client.request('scope', {}, { purpose: 'preflight' }),
        ]);
        const userId = profileId(profile);
        const scopes = normalizedScopes(scope);
        if (!userId || !/^[1-9]\d*$/u.test(userId)) {
          throw new GatewayError('PROFILE_INVALID', 'The Bitrix profile did not return a valid user ID.', {
            status: 503,
            category: 'preflight_failed',
          });
        }
        if (!hasRequiredScopes(scopes)) {
          throw new GatewayError('SCOPE_MISSING', 'The Bitrix webhook lacks one or more required read scopes.', {
            status: 503,
            category: 'preflight_failed',
          });
        }
        return { userId, scopes };
      })().catch((error) => {
        this.readyPromise = null;
        throw error;
      });
    }
    return this.readyPromise;
  }

  async #listRole(field, userId, search, status) {
    const rows = [];
    let start = 0;
    const seenStarts = new Set();
    for (let page = 0; page < this.maxPages; page += 1) {
      const startKey = String(start);
      if (seenStarts.has(startKey)) {
        throw new GatewayError('BITRIX_PAGINATION_INVALID', 'Bitrix returned a repeated task-list cursor.', {
          status: 502,
          category: 'invalid_response',
        });
      }
      seenStarts.add(startKey);
      const filter = { GROUP_ID: REQUIRED_GROUP_ID, [field]: userId };
      if (search) filter['%TITLE'] = search;
      if (status === 'active') {
        filter['!REAL_STATUS'] = [5, 7];
        filter.CLOSED_DATE = false;
      }
      const response = await this.client.request('tasks.task.list', {
        filter,
        select: LIST_SELECT,
        order: { CHANGED_DATE: 'DESC', ID: 'DESC' },
        start,
      });
      rows.push(...responseRows(response, 'TASKS'));
      const next = responseNext(response);
      if (next === null) return rows;
      start = next;
    }
    throw new GatewayError('BITRIX_PAGINATION_LIMIT', 'The Bitrix task list exceeded the pagination safety limit.', {
      status: 502,
      category: 'invalid_response',
    });
  }

  async #discussion(task) {
    const resolution = {
      taskChatIdNull: task.chatId === null,
      tasksTaskNull: false,
      tasksNull: false,
      commentsIndicated: task.commentsCount > 0,
    };
    let chatId = task.chatId;

    if (!chatId) {
      const tasksTask = await this.client.request('im.chat.get', {
        ENTITY_TYPE: 'TASKS_TASK',
        ENTITY_ID: task.id,
      });
      chatId = extractChatId(tasksTask);
      resolution.tasksTaskNull = chatId === null;
    }
    if (!chatId) {
      const tasks = await this.client.request('im.chat.get', {
        ENTITY_TYPE: 'TASKS',
        ENTITY_ID: task.id,
      });
      chatId = extractChatId(tasks);
      resolution.tasksNull = chatId === null;
    }

    if (chatId) {
      return { source: 'chat', messages: await this.#chatMessages(chatId) };
    }
    if (!task.commentsCount) return { source: 'none', messages: [] };

    return { source: 'legacy_comments', messages: await this.#legacyComments(task.id, resolution) };
  }

  async #chatMessages(chatId) {
    const messages = [];
    let lastId = null;
    const seenCursors = new Set();
    for (let page = 0; page < this.maxPages; page += 1) {
      const cursorKey = lastId ?? 'FIRST_PAGE';
      if (seenCursors.has(cursorKey)) {
        throw new GatewayError('BITRIX_PAGINATION_INVALID', 'Bitrix returned a repeated discussion cursor.', {
          status: 502,
          category: 'invalid_response',
        });
      }
      seenCursors.add(cursorKey);
      const params = {
        DIALOG_ID: `chat${chatId}`,
        LIMIT: 50,
      };
      if (lastId !== null) params.LAST_ID = lastId;
      const response = await this.client.request('im.dialog.messages.get', params);
      const pageMessages = normalizeChatMessages(response);
      const rawPageSize = responseRows(response, 'MESSAGES').length;
      messages.push(...pageMessages);
      if (rawPageSize < 50) return dedupeAndSortMessages(messages);
      if (pageMessages.length === 0) {
        throw new GatewayError('BITRIX_PAGINATION_INVALID', 'Bitrix returned a full discussion page without valid message IDs.', {
          status: 502,
          category: 'invalid_response',
        });
      }
      const ids = pageMessages.map((message) => BigInt(message.id));
      lastId = String(ids.reduce((minimum, value) => value < minimum ? value : minimum));
    }
    throw new GatewayError('BITRIX_PAGINATION_LIMIT', 'The Bitrix discussion exceeded the pagination safety limit.', {
      status: 502,
      category: 'invalid_response',
    });
  }

  async #legacyComments(taskId, resolution) {
    const legacyTaskId = Number(taskId);
    if (!Number.isSafeInteger(legacyTaskId) || legacyTaskId < 1) {
      throw new GatewayError('LEGACY_TASK_ID_UNSUPPORTED', 'The legacy Bitrix comment API requires a safe integer task ID.', {
        status: 502,
        category: 'invalid_response',
      });
    }
    const response = await this.client.getLegacyComments({ TASKID: legacyTaskId }, resolution);
    return dedupeAndSortMessages(normalizeLegacyComments(response));
  }

  #assertTaskId(taskId) {
    const value = String(taskId ?? '');
    if (!/^[1-9]\d*$/u.test(value) || value.length > 20) {
      throw new GatewayError('INVALID_TASK_ID', 'Task ID must be a positive numeric Bitrix ID.', {
        status: 400,
        category: 'invalid_request',
      });
    }
    return value;
  }
}
