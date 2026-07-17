#!/usr/bin/env node
import { BitrixGatewayError } from "../agent/bitrix/gateway-client.js";
import { BitrixTaskService } from "../agent/bitrix/service.js";

const args = process.argv.slice(2);
const service = new BitrixTaskService();

function valueAfter(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  if (args.includes("--health")) {
    const health = await service.health();
    console.log(JSON.stringify({ operation: "health", ...health }));
    return;
  }
  const taskId = valueAfter("--task");
  if (taskId) {
    const result = await service.syncTask(taskId);
    console.log(
      JSON.stringify({ operation: "sync_task", taskId: result.taskId, result: result.outcome, syncedAt: result.syncedAt }),
    );
    return;
  }
  if (args.includes("--daily")) {
    const result = await service.syncDaily(3);
    console.log(JSON.stringify({ operation: "daily_sync", ...result }));
    if (result.failed.length > 0) process.exitCode = 1;
    return;
  }
  console.error("Usage: bitrix-sync.ts --health | --task <id> | --daily");
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  const code = error instanceof BitrixGatewayError ? error.code : "unexpected_error";
  console.error(JSON.stringify({ operation: "bitrix_sync", result: "failed", code }));
  process.exitCode = 1;
});
