import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeChecklist, normalizeTask } from '../../services/bitrix-gateway/normalize.mjs';

test('canonical numeric IDs sort safely above Number.MAX_SAFE_INTEGER', () => {
  const firstLarge = '9007199254740993';
  const secondLarge = '9007199254740994';
  const task = normalizeTask({
    ID: '1',
    TITLE: 'Large ID ordering',
    DESCRIPTION: 'owner@example.test +7 912 123-45-67',
    GROUP_ID: '97',
    RESPONSIBLE_ID: '42',
    RESPONSIBLE: { ID: '42', NAME: 'Owner' },
    ACCOMPLICE: [secondLarge, '9', firstLarge],
    ACCOMPLICES: [
      { ID: secondLarge, NAME: 'Second large' },
      { ID: firstLarge, NAME: 'First large' },
      { ID: '9', NAME: 'Small' },
    ],
    CREATED_BY: '42',
    CREATOR: { ID: '42', NAME: 'Owner' },
    STATUS: '3',
    REAL_STATUS: '3',
  });
  const checklist = normalizeChecklist({
    result: [
      { ID: secondLarge, TITLE: 'Second' },
      { ID: '9', TITLE: 'Small' },
      { ID: firstLarge, TITLE: 'First' },
    ],
  });

  assert.deepEqual(task.accompliceIds, ['9', firstLarge, secondLarge]);
  assert.deepEqual(task.accomplices.map(({ id }) => id), ['9', firstLarge, secondLarge]);
  assert.deepEqual(checklist.map(({ id }) => id), ['9', firstLarge, secondLarge]);
  assert.match(task.description, /owner@example\.test/u);
  assert.match(task.description, /912/u);
});

test('normalizes actual Bitrix camelCase policy fields', () => {
  const task = normalizeTask({
    id: '394930',
    groupId: '97',
    responsibleId: '1274',
    responsible: { id: '1274', name: 'Current user' },
    accomplices: ['181'],
    status: '2',
  });

  assert.equal(task.id, '394930');
  assert.equal(task.groupId, '97');
  assert.equal(task.responsible.id, '1274');
  assert.deepEqual(task.accompliceIds, ['181']);
  assert.equal(task.roleFieldsComplete, true);
});
