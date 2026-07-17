import { GatewayError } from './errors.mjs';

export const REQUIRED_GROUP_ID = '97';

export class BitrixTaskPolicy {
  constructor({ groupId = REQUIRED_GROUP_ID } = {}) {
    this.groupId = String(groupId);
  }

  evaluate(task, userId) {
    const normalizedUserId = String(userId ?? '');
    if (!task?.id || !/^[1-9]\d*$/u.test(task.id)) return { allowed: false, code: 'INVALID_TASK' };
    if (!task.groupId) return { allowed: false, code: 'INCOMPLETE_POLICY_FIELDS' };
    if (task.groupId !== this.groupId) return { allowed: false, code: 'WRONG_GROUP' };
    if (!task.roleFieldsComplete || !task.responsible?.id || !Array.isArray(task.accompliceIds)) {
      return { allowed: false, code: 'INCOMPLETE_ROLE_FIELDS' };
    }
    if (!/^[1-9]\d*$/u.test(normalizedUserId)) return { allowed: false, code: 'INVALID_PROFILE' };
    if (task.responsible.id === normalizedUserId) return { allowed: true, role: 'responsible' };
    if (task.accompliceIds.includes(normalizedUserId)) return { allowed: true, role: 'accomplice' };
    return { allowed: false, code: 'NOT_PARTICIPANT' };
  }

  assert(task, userId) {
    const decision = this.evaluate(task, userId);
    if (decision.allowed) return decision;
    const errors = {
      INVALID_TASK: ['INVALID_TASK', 'Bitrix returned an invalid task.', 502],
      INCOMPLETE_POLICY_FIELDS: ['POLICY_DATA_INCOMPLETE', 'Bitrix did not return all fields required to authorize this task.', 403],
      WRONG_GROUP: ['TASK_OUTSIDE_GROUP', 'The task does not belong to the allowed Bitrix group.', 403],
      INCOMPLETE_ROLE_FIELDS: ['POLICY_DATA_INCOMPLETE', 'Bitrix did not return all role fields required to authorize this task.', 403],
      INVALID_PROFILE: ['PROFILE_INVALID', 'The Bitrix profile could not be verified.', 503],
      NOT_PARTICIPANT: ['TASK_NOT_AUTHORIZED', 'The current Bitrix user is not responsible for or an accomplice on this task.', 403],
    };
    const [code, message, status] = errors[decision.code] ?? ['POLICY_DENIED', 'The task is not authorized.', 403];
    throw new GatewayError(code, message, { status, category: 'policy_denied' });
  }
}
