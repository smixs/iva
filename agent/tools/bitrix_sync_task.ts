import { defineTool } from "eve/tools";
import { z } from "zod";
import { asUntrustedBitrixPayload } from "../bitrix/model-safety.js";
import { getBitrixTaskService, safeBitrixError } from "../bitrix/runtime.js";

export default defineTool({
  description:
    "Безопасно синхронизировать одну задачу Bitrix24 по числовому ID. Gateway повторно проверяет " +
    "группу 97 и роль ответственного/соисполнителя до чтения обсуждения и записи локальных файлов. " +
    "Никаких write-операций в Bitrix этот инструмент не имеет.",
  inputSchema: z.object({
    taskId: z.number().int().positive().describe("Числовой ID задачи Bitrix24"),
  }),
  async execute({ taskId }) {
    try {
      const result = await getBitrixTaskService().syncTask(taskId);
      return {
        ok: true,
        ...asUntrustedBitrixPayload({
          status: result.outcome,
          taskId: result.taskId,
          syncedAt: result.syncedAt,
        }),
      };
    } catch (error) {
      return safeBitrixError(error);
    }
  },
});
