const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+/giu;
const DOWNLOAD_URL_MARKERS = /(?:\/download(?:\/|\?|$)|\/upload\/|\/disk\/|\/files?\/|attachment|download=|file[_-]?id=|auth=|token=)/iu;
const BITRIX_WEBHOOK_PATH = /\/rest\/\d+\/[A-Za-z0-9_-]+(?:\/|$|\?)/iu;
const STATUS_NAMES = Object.freeze({
  1: 'new',
  2: 'pending',
  3: 'in_progress',
  4: 'supposed_completed',
  5: 'completed',
  6: 'deferred',
  7: 'declined',
});
const STATUS_ALIASES = new Map(Object.entries(STATUS_NAMES).map(([code, name]) => [name, Number(code)]));
STATUS_ALIASES.set('review', 4);

function fieldKey(value) {
  return String(value).replace(/[^A-Za-z0-9]/gu, '').toUpperCase();
}

function fieldMap(object) {
  const mapped = new Map();
  if (!object || typeof object !== 'object') return mapped;
  for (const [key, value] of Object.entries(object)) mapped.set(fieldKey(key), value);
  return mapped;
}

export function pick(object, ...names) {
  const mapped = fieldMap(object);
  for (const name of names) {
    const key = fieldKey(name);
    if (mapped.has(key)) return mapped.get(key);
  }
  return undefined;
}

export function hasField(object, ...names) {
  const mapped = fieldMap(object);
  return names.some((name) => mapped.has(fieldKey(name)));
}

export function idString(value) {
  if (value && typeof value === 'object') value = pick(value, 'ID', 'USER_ID', 'id', 'userId');
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d+$/u.test(trimmed) ? trimmed.replace(/^0+(?=\d)/u, '') : null;
}

function compareCanonicalIds(left, right) {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  if (leftId < rightId) return -1;
  return leftId > rightId ? 1 : 0;
}

export function safeText(value) {
  if (value === null || value === undefined) return '';
  let text = String(value).replace(/\u0000/gu, '');
  text = text.replace(URL_PATTERN, (url) => {
    if (BITRIX_WEBHOOK_PATH.test(url)) return '[webhook-url-omitted]';
    if (DOWNLOAD_URL_MARKERS.test(url)) return '[attachment-url-omitted]';
    return url;
  });
  return text;
}

function personName(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const explicit = pick(raw, 'NAME', 'FULL_NAME', 'DISPLAY_NAME');
  if (explicit) return safeText(explicit);
  return safeText([pick(raw, 'FIRST_NAME'), pick(raw, 'LAST_NAME')].filter(Boolean).join(' '));
}

export function normalizePerson(raw, fallbackId = null, fallbackName = '') {
  if (raw === null || raw === undefined) {
    return fallbackId ? { id: fallbackId, name: safeText(fallbackName) } : null;
  }
  if (typeof raw !== 'object') {
    const id = idString(raw) ?? fallbackId;
    return id ? { id, name: safeText(fallbackName) } : null;
  }
  const id = idString(raw) ?? fallbackId;
  return id ? { id, name: personName(raw) || safeText(fallbackName) } : null;
}

function normalizePersonList(raw) {
  if (!Array.isArray(raw)) return [];
  const byId = new Map();
  for (const item of raw) {
    const person = normalizePerson(item);
    if (person) byId.set(person.id, person);
  }
  return [...byId.values()].sort((a, b) => compareCanonicalIds(a.id, b.id));
}

function normalizeIdList(raw) {
  const values = Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw]);
  return [...new Set(values.map(idString).filter(Boolean))].sort(compareCanonicalIds);
}

function sameIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function scalarConflict(raw, scalarNames, objectNames) {
  if (!hasField(raw, ...scalarNames) || !hasField(raw, ...objectNames)) return false;
  const scalar = idString(pick(raw, ...scalarNames));
  const object = idString(pick(raw, ...objectNames));
  return !scalar || !object || scalar !== object;
}

function normalizeStatusCode(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7) return value;
  const text = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/gu, '_');
  if (/^[1-7]$/u.test(text)) return Number(text);
  return STATUS_ALIASES.get(text) ?? 0;
}

export function normalizeTask(raw, { portalOrigin = '' } = {}) {
  const id = idString(pick(raw, 'ID', 'TASK_ID'));
  const rawResponsibleId = idString(pick(raw, 'RESPONSIBLE_ID'));
  const responsibleObject = pick(raw, 'RESPONSIBLE');
  const responsible = normalizePerson(responsibleObject, rawResponsibleId, pick(raw, 'RESPONSIBLE_NAME'));

  const rawAccompliceIdsPresent = hasField(raw, 'ACCOMPLICE', 'ACCOMPLICE_IDS');
  const rawAccompliceIds = normalizeIdList(pick(raw, 'ACCOMPLICE', 'ACCOMPLICE_IDS'));
  const accompliceObjectsPresent = hasField(raw, 'ACCOMPLICES');
  const accompliceObjects = normalizePersonList(pick(raw, 'ACCOMPLICES'));
  const objectAccompliceIds = accompliceObjects.map((person) => person.id);
  const accompliceIds = rawAccompliceIdsPresent ? rawAccompliceIds : objectAccompliceIds;
  const accompliceNames = new Map(accompliceObjects.map((person) => [person.id, person.name]));
  const accomplices = accompliceIds.map((personId) => ({ id: personId, name: accompliceNames.get(personId) ?? '' }));

  const creatorId = idString(pick(raw, 'CREATED_BY', 'CREATED_BY_ID'));
  const creator = normalizePerson(pick(raw, 'CREATOR', 'CREATED_BY_USER'), creatorId, pick(raw, 'CREATED_BY_NAME'));
  const groupId = idString(pick(raw, 'GROUP_ID'));
  const commentsCountValue = pick(raw, 'COMMENTS_COUNT', 'COMMENTSCOUNT', 'COMMENTS');
  const parsedCommentsCount = Number.parseInt(String(commentsCountValue ?? '0'), 10);
  const chatId = idString(pick(raw, 'CHAT_ID', 'CHATID'));
  const statusCode = normalizeStatusCode(pick(raw, 'STATUS'));
  const realStatusCode = normalizeStatusCode(pick(raw, 'REAL_STATUS', 'REALSTATUS')) || statusCode;
  const closedAt = nullableText(pick(raw, 'CLOSED_DATE', 'CLOSED_AT'));
  const closed = realStatusCode === 5 || realStatusCode === 7 || Boolean(closedAt);

  const roleFieldsComplete = (
    hasField(raw, 'RESPONSIBLE_ID', 'RESPONSIBLE')
    && Boolean(responsible?.id)
    && (rawAccompliceIdsPresent || accompliceObjectsPresent)
    && !scalarConflict(raw, ['RESPONSIBLE_ID'], ['RESPONSIBLE'])
    && !(rawAccompliceIdsPresent && accompliceObjectsPresent && !sameIds(rawAccompliceIds, objectAccompliceIds))
  );

  let url = '';
  if (portalOrigin && id) {
    try {
      url = new URL(`/workgroups/group/97/tasks/task/view/${id}/`, portalOrigin).href;
    } catch {
      url = '';
    }
  }

  return {
    id,
    title: safeText(pick(raw, 'TITLE')),
    description: safeText(pick(raw, 'DESCRIPTION')),
    groupId,
    url,
    status: STATUS_NAMES[statusCode] ?? 'unknown',
    realStatus: realStatusCode,
    creator,
    responsible,
    accomplices,
    accompliceIds,
    deadline: nullableText(pick(raw, 'DEADLINE')),
    changedAt: nullableText(pick(raw, 'CHANGED_DATE', 'CHANGED_AT')),
    closedAt,
    closed,
    chatId,
    commentsCount: Number.isFinite(parsedCommentsCount) && parsedCommentsCount > 0 ? parsedCommentsCount : 0,
    roleFieldsComplete,
  };
}

export function normalizeChecklist(rawResponse) {
  const result = unwrapResult(rawResponse);
  const rows = Array.isArray(result) ? result : (pick(result, 'ITEMS', 'CHECKLIST') ?? []);
  if (!Array.isArray(rows)) return [];
  const normalized = [];
  for (const row of rows) {
    const id = idString(pick(row, 'ID'));
    if (!id) continue;
    const completedRaw = pick(row, 'IS_COMPLETE', 'COMPLETED');
    normalized.push({
      id,
      title: safeText(pick(row, 'TITLE')),
      completed: completedRaw === true || completedRaw === 1 || /^(?:1|Y|YES|TRUE)$/iu.test(String(completedRaw ?? '')),
      parentId: idString(pick(row, 'PARENT_ID')),
    });
  }
  return normalized.sort((a, b) => compareCanonicalIds(a.id, b.id));
}

export function unwrapResult(response) {
  if (!response || typeof response !== 'object') return response;
  return Object.prototype.hasOwnProperty.call(response, 'result') ? response.result : response;
}

export function responseRows(response, ...keys) {
  const result = unwrapResult(response);
  if (Array.isArray(result)) return result;
  for (const key of keys) {
    const rows = pick(result, key);
    if (Array.isArray(rows)) return rows;
  }
  return [];
}

export function responseNext(response) {
  const topLevel = pick(response, 'NEXT');
  if (topLevel !== undefined && topLevel !== null && topLevel !== '') return topLevel;
  const result = unwrapResult(response);
  const nested = pick(result, 'NEXT');
  return nested === undefined || nested === null || nested === '' ? null : nested;
}

export function extractChatId(response) {
  const result = unwrapResult(response);
  return idString(pick(result, 'CHAT_ID', 'CHATID', 'ID'));
}

function nullableText(value) {
  if (value === null || value === undefined || value === '') return null;
  return safeText(value);
}

function countAttachments(message) {
  const params = pick(message, 'PARAMS') ?? {};
  const candidates = [
    pick(message, 'FILES'),
    pick(message, 'ATTACHMENTS'),
    pick(message, 'ATTACHED_OBJECTS'),
    pick(params, 'FILES'),
    pick(params, 'FILE_ID'),
    pick(params, 'ATTACHMENTS'),
    pick(params, 'ATTACHED_OBJECTS'),
  ];
  let total = 0;
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) total += candidate.length;
    else if (candidate && typeof candidate === 'object') total += Object.keys(candidate).length;
    else if (candidate !== null && candidate !== undefined && candidate !== '') total += 1;
  }
  return total;
}

function usersById(response) {
  const result = unwrapResult(response);
  const users = pick(result, 'USERS') ?? pick(response, 'USERS') ?? [];
  const mapped = new Map();
  if (Array.isArray(users)) {
    for (const user of users) {
      const person = normalizePerson(user);
      if (person) mapped.set(person.id, person);
    }
  } else if (users && typeof users === 'object') {
    for (const [key, user] of Object.entries(users)) {
      const person = normalizePerson(user, idString(key));
      if (person) mapped.set(person.id, person);
    }
  }
  return mapped;
}

export function normalizeChatMessages(response) {
  const rows = responseRows(response, 'MESSAGES');
  const users = usersById(response);
  const normalized = [];
  for (const row of rows) {
    const id = idString(pick(row, 'ID', 'MESSAGE_ID'));
    if (!id) continue;
    const authorId = idString(pick(row, 'AUTHOR_ID', 'USER_ID'));
    const author = users.get(authorId) ?? normalizePerson(pick(row, 'AUTHOR'), authorId, pick(row, 'AUTHOR_NAME'));
    normalized.push({
      id,
      author: author ?? { id: authorId ?? '0', name: '' },
      createdAt: safeText(pick(row, 'DATE_CREATE', 'CREATED_AT', 'DATE')),
      updatedAt: nullableText(pick(row, 'DATE_MODIFY', 'UPDATED_AT')),
      text: safeText(pick(row, 'MESSAGE', 'TEXT', 'POST_MESSAGE')),
      attachmentCount: countAttachments(row),
    });
  }
  return normalized;
}

export function normalizeLegacyComments(response) {
  const rows = responseRows(response, 'COMMENTS', 'ITEMS');
  return rows.flatMap((row) => {
    const id = idString(pick(row, 'ID'));
    if (!id) return [];
    const authorId = idString(pick(row, 'AUTHOR_ID')) ?? '0';
    return [{
      id,
      author: normalizePerson(pick(row, 'AUTHOR'), authorId, pick(row, 'AUTHOR_NAME')) ?? { id: authorId, name: '' },
      createdAt: safeText(pick(row, 'POST_DATE', 'CREATED_AT')),
      updatedAt: nullableText(pick(row, 'UPDATED_AT', 'EDIT_DATE')),
      text: safeText(pick(row, 'POST_MESSAGE', 'TEXT')),
      attachmentCount: countAttachments(row),
    }];
  });
}

export function dedupeAndSortMessages(messages) {
  const byId = new Map();
  for (const message of messages) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => {
    const dateOrder = String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
    if (dateOrder !== 0) return dateOrder;
    const leftId = BigInt(left.id);
    const rightId = BigInt(right.id);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

export function publicTask(task, checklist) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    groupId: task.groupId,
    url: task.url,
    status: task.status,
    realStatus: task.realStatus,
    creator: task.creator ?? { id: '0', name: '' },
    responsible: task.responsible ?? { id: '0', name: '' },
    accomplices: task.accomplices,
    deadline: task.deadline,
    changedAt: task.changedAt,
    closedAt: task.closedAt,
    closed: task.closed,
    checklist,
  };
}
