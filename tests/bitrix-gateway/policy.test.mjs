import assert from 'node:assert/strict';
import test from 'node:test';
import { BitrixTaskPolicy } from '../../services/bitrix-gateway/policy.mjs';
import { normalizeTask } from '../../services/bitrix-gateway/normalize.mjs';
import { rawTask } from './helpers.mjs';

const policy = new BitrixTaskPolicy();

test('policy allows current profile only as responsible or accomplice in group 97', () => {
  const responsible = normalizeTask(rawTask());
  assert.deepEqual(policy.evaluate(responsible, '42'), { allowed: true, role: 'responsible' });

  const accomplice = normalizeTask(rawTask({
    RESPONSIBLE_ID: '99',
    RESPONSIBLE: { ID: '99', NAME: 'Other' },
    ACCOMPLICE: ['42'],
    ACCOMPLICES: [{ ID: '42', NAME: 'Current' }],
  }));
  assert.deepEqual(policy.evaluate(accomplice, '42'), { allowed: true, role: 'accomplice' });
  assert.equal(policy.evaluate(accomplice, '77').code, 'NOT_PARTICIPANT');
  assert.equal(policy.evaluate(normalizeTask(rawTask({ GROUP_ID: '98' })), '42').code, 'WRONG_GROUP');
});

test('policy fails closed when any role field is missing or contradictory', () => {
  const missingAccomplices = rawTask();
  delete missingAccomplices.ACCOMPLICE;
  delete missingAccomplices.ACCOMPLICES;
  assert.equal(policy.evaluate(normalizeTask(missingAccomplices), '42').code, 'INCOMPLETE_ROLE_FIELDS');

  const missingResponsible = rawTask();
  delete missingResponsible.RESPONSIBLE_ID;
  delete missingResponsible.RESPONSIBLE;
  assert.equal(policy.evaluate(normalizeTask(missingResponsible), '43').code, 'INCOMPLETE_ROLE_FIELDS');

  const contradictory = normalizeTask(rawTask({ RESPONSIBLE: { ID: '77', NAME: 'Mismatch' } }));
  assert.equal(policy.evaluate(contradictory, '42').code, 'INCOMPLETE_ROLE_FIELDS');

  const contradictoryAccomplices = normalizeTask(rawTask({
    ACCOMPLICE: ['43'],
    ACCOMPLICES: [{ ID: '44', NAME: 'Mismatch' }],
  }));
  assert.equal(policy.evaluate(contradictoryAccomplices, '42').code, 'INCOMPLETE_ROLE_FIELDS');
});

test('task status is a stable name and realStatus is numeric for all Bitrix status codes', () => {
  const expected = [
    'new',
    'pending',
    'in_progress',
    'supposed_completed',
    'completed',
    'deferred',
    'declined',
  ];
  for (let code = 1; code <= 7; code += 1) {
    const task = normalizeTask(rawTask({ STATUS: String(code), REAL_STATUS: code }));
    assert.equal(task.status, expected[code - 1]);
    assert.equal(task.realStatus, code);
    assert.equal(task.closed, code === 5 || code === 7);
  }
  const closedByDate = normalizeTask(rawTask({
    STATUS: '3',
    REAL_STATUS: '3',
    CLOSED_DATE: '2026-07-16T12:00:00+05:00',
  }));
  assert.equal(closedByDate.status, 'in_progress');
  assert.equal(closedByDate.realStatus, 3);
  assert.equal(closedByDate.closed, true);
});
