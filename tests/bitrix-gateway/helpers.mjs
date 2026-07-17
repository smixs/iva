export function fakeWebhook() {
  const path = ['rest', '7', 'unit-test-token'].join('/');
  return new URL('/' + path + '/', 'https://bitrix.invalid').href;
}

export function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  const normalizedHeaders = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => normalizedHeaders.get(String(name).toLowerCase()) ?? null },
    async json() { return payload; },
  };
}

export function rawTask(overrides = {}) {
  return {
    ID: '123',
    TITLE: 'Safe task',
    DESCRIPTION: 'Task description',
    GROUP_ID: '97',
    STATUS: '3',
    REAL_STATUS: '2',
    CREATED_BY: '5',
    CREATOR: { ID: '5', NAME: 'Creator' },
    RESPONSIBLE_ID: '42',
    RESPONSIBLE: { ID: '42', NAME: 'Owner' },
    ACCOMPLICE: ['43'],
    ACCOMPLICES: [{ ID: '43', NAME: 'Helper' }],
    DEADLINE: null,
    CHANGED_DATE: '2026-07-16T10:00:00+05:00',
    CLOSED_DATE: null,
    CHAT_ID: '500',
    COMMENTS_COUNT: '2',
    ...overrides,
  };
}

export class ScriptedClient {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
    this.portalOrigin = 'https://bitrix.invalid';
    this.webhookUrl = fakeWebhook();
    this.chatReadVerified = false;
  }

  async request(method, params = {}, context = {}) {
    this.calls.push({ kind: 'request', method, params, context });
    return this.handler({ kind: 'request', method, params, context, calls: this.calls });
  }

  async getLegacyComments(params, resolution) {
    this.calls.push({ kind: 'legacy', method: 'task.commentitem.getlist', params, resolution });
    return this.handler({
      kind: 'legacy',
      method: 'task.commentitem.getlist',
      params,
      resolution,
      calls: this.calls,
    });
  }
}
