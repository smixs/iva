import { BitrixGatewayError } from "./gateway-client.js";
import { BitrixTaskService } from "./service.js";

let singleton: BitrixTaskService | null = null;

export function getBitrixTaskService(): BitrixTaskService {
  singleton ??= new BitrixTaskService();
  return singleton;
}

const MESSAGES: Record<string, string> = {
  invalid_task_id: "ID задачи Bitrix должен быть положительным целым числом.",
  task_unavailable: "Задача недоступна текущему пользователю Bitrix.",
  task_not_found: "Задача недоступна текущему пользователю Bitrix.",
  wrong_group: "Задача не относится к группе 97.",
  not_participant: "Вы не являетесь исполнителем или соисполнителем этой задачи.",
  policy_incomplete: "Bitrix вернул неполные данные; доступ отклонён безопасным образом.",
  missing_task_scope: "У webhook нет права читать задачи.",
  missing_im_scope: "У webhook нет права читать обсуждение задачи.",
  discussion_unavailable: "Обсуждение задачи недоступно через разрешённые read-only методы.",
  gateway_unavailable: "Локальный read-only шлюз Bitrix недоступен.",
  gateway_timeout: "Bitrix временно недоступен: превышено время ожидания.",
  bitrix_temporarily_unavailable: "Bitrix временно недоступен.",
  network_error: "Bitrix временно недоступен из-за сетевой ошибки.",
  rate_limited: "Bitrix временно ограничил частоту запросов.",
  query_limit_exceeded: "Bitrix временно ограничил частоту запросов.",
  chat_read_state_unverified: "Чтение чата задачи отключено до подтверждения, что API не меняет состояние прочитанности.",
  task_outside_group: "Задача не относится к группе 97.",
  task_not_authorized: "Вы не являетесь исполнителем или соисполнителем этой задачи.",
  policy_data_incomplete: "Bitrix вернул неполные данные; доступ отклонён безопасным образом.",
  scope_missing: "У webhook нет необходимых прав для безопасного чтения задач и обсуждений.",
  bitrix_rate_limited: "Bitrix временно ограничил частоту запросов.",
  bitrix_overload_limit: "Bitrix временно ограничил нагрузку; использую последний снимок.",
  bitrix_unavailable: "Bitrix временно недоступен.",
  bitrix_network_error: "Bitrix временно недоступен из-за сетевой ошибки.",
  bitrix_timeout: "Bitrix временно недоступен: превышено время ожидания.",
};

export function safeBitrixError(error: unknown): {
  ok: false;
  error: { code: string; message: string; retryAt?: string };
} {
  if (error instanceof BitrixGatewayError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: MESSAGES[error.code] || "Не удалось прочитать данные Bitrix безопасным способом.",
        ...(error.retryAt ? { retryAt: error.retryAt } : {}),
      },
    };
  }
  const code = error instanceof Error && error.message === "bitrix_sync_busy" ? "sync_busy" : "unexpected_error";
  return {
    ok: false,
    error: {
      code,
      message: code === "sync_busy" ? "Эта задача уже синхронизируется; повторите позже." : "Неожиданная безопасная ошибка Bitrix-интеграции.",
    },
  };
}
