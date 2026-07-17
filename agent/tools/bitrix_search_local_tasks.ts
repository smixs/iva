import { defineTool } from "eve/tools";
import { z } from "zod";
import { asUntrustedBitrixPayload } from "../bitrix/model-safety.js";
import { getBitrixTaskService, safeBitrixError } from "../bitrix/runtime.js";

export default defineTool({
  description:
    "Искать только в локальных папках ASSISTANT_VAULT_DIR/tasks/bitrix/<task-id>. " +
    "Возвращает ID и короткие фрагменты; перед содержательным ответом выбранную задачу нужно " +
    "прочитать через bitrix_read_task, который сначала обновит снимок.",
  inputSchema: z.object({
    query: z.string().min(1).max(500).describe("Текст поиска"),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async execute({ query, limit }) {
    try {
      const hits = await getBitrixTaskService().searchLocalTasks(query, limit);
      return { ok: true, ...asUntrustedBitrixPayload({
        count: hits.length,
        hits,
        note: "Перед ответом по найденной задаче вызови bitrix_read_task для актуализации.",
      }) };
    } catch (error) {
      return safeBitrixError(error);
    }
  },
});
