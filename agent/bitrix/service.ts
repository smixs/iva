import { BitrixGatewayClient, BitrixGatewayError, validateTaskId } from "./gateway-client.js";
import { BitrixTaskRepository, type RepositorySyncResult } from "./repository.js";
import type { BitrixLocalSearchHit, BitrixTaskStatusFilter, BitrixTaskSummary } from "./types.js";

const TRANSIENT_CODES = new Set([
  "gateway_unavailable",
  "gateway_timeout",
  "bitrix_temporarily_unavailable",
  "bitrix_unavailable",
  "bitrix_rate_limited",
  "bitrix_overload_limit",
  "network_error",
  "rate_limited",
  "query_limit_exceeded",
  "upstream_5xx",
]);

const PERMANENT_FINAL_CANDIDATE_CODES = new Set([
  "task_outside_group",
  "task_not_authorized",
  "policy_data_incomplete",
  "bitrix_access_denied",
  "task_not_found",
  "bitrix_task_not_found",
  "bitrix_request_not_found",
  "request_not_found",
]);

export function isTransientBitrixError(error: unknown): boolean {
  return error instanceof BitrixGatewayError && TRANSIENT_CODES.has(error.code.toLowerCase());
}

export class BitrixTaskService {
  constructor(
    private readonly gateway = new BitrixGatewayClient(),
    private readonly repository = new BitrixTaskRepository(),
  ) {}

  async listMyTasks(input: {
    status?: BitrixTaskStatusFilter;
    search?: string;
    limit?: number;
  }): Promise<{ tasks: BitrixTaskSummary[]; total: number }> {
    const result = await this.gateway.listTasks({
      status: input.status ?? "active",
      search: input.search,
      limit: Math.min(100, Math.max(1, input.limit ?? 100)),
    });
    return { tasks: result.tasks, total: result.total };
  }

  async syncTask(taskIdValue: string | number): Promise<RepositorySyncResult> {
    const taskId = validateTaskId(taskIdValue);
    return await this.repository.runExclusiveTask(taskId, async (transaction) => {
      const persistedRetryAt = transaction.state?.nextAllowedAttemptAt ?? null;
      const persistedRetryAtMs = persistedRetryAt ? Date.parse(persistedRetryAt) : Number.NaN;
      if (persistedRetryAt && Number.isFinite(persistedRetryAtMs) && persistedRetryAtMs > Date.now()) {
        throw new BitrixGatewayError(
          "bitrix_rate_limited",
          "Bitrix request is deferred by the persisted rate-limit window",
          persistedRetryAt,
        );
      }
      try {
        const snapshot = await this.gateway.getSnapshot(taskId);
        return await transaction.sync(snapshot);
      } catch (error) {
        if (error instanceof BitrixGatewayError) {
          await transaction.recordFailure(error.code, error.retryAt);
        }
        throw error;
      }
    });
  }

  async readTask(taskIdValue: string | number): Promise<{
    sync: RepositorySyncResult | null;
    stale: boolean;
    staleReason: string | null;
    taskId: string;
    task: string;
    comments: string;
    history: string;
    truncated: boolean;
    snapshotDate: string | null;
    untrustedContent: true;
  }> {
    const taskId = validateTaskId(taskIdValue);
    let sync: RepositorySyncResult | null = null;
    let staleReason: string | null = null;
    try {
      sync = await this.syncTask(taskId);
    } catch (error) {
      if (!isTransientBitrixError(error)) throw error;
      staleReason = error instanceof BitrixGatewayError ? error.code : "bitrix_temporarily_unavailable";
    }

    let local;
    try {
      local = await this.repository.read(taskId);
    } catch (error) {
      if (staleReason) throw new BitrixGatewayError(staleReason, "Bitrix is unavailable and no local snapshot exists");
      throw error;
    }
    return {
      sync,
      stale: Boolean(staleReason),
      staleReason,
      taskId,
      task: local.task,
      comments: local.comments,
      history: local.history,
      truncated: local.truncated,
      snapshotDate: local.lastSuccessfulAt,
      untrustedContent: true,
    };
  }

  async searchLocalTasks(query: string, limit = 20): Promise<BitrixLocalSearchHit[]> {
    return await this.repository.search(query, limit);
  }

  async syncDaily(concurrency = 3): Promise<{
    totalEligible: number;
    attempted: number;
    created: number;
    updated: number;
    unchanged: number;
    failed: Array<{ taskId: string; code: string }>;
  }> {
    const activeSummaries = (await this.gateway.listActiveTasks()).tasks;
    const states = new Map((await this.repository.listStates()).map((state) => [state.taskId, state]));
    const activeIds = new Set(activeSummaries.map((task) => task.id));
    const finalCandidateIds = [...states.values()]
      .filter((state) => !state.closed && !state.dailyFinalized && !activeIds.has(state.taskId))
      .map((state) => state.taskId);
    const finalCandidateSet = new Set(finalCandidateIds);
    const eligibleTaskIds = [...activeSummaries.map((task) => task.id), ...finalCandidateIds];
    const results = await mapConcurrent(eligibleTaskIds, Math.min(5, Math.max(1, concurrency)), async (taskId) => {
      try {
        const synced = await this.syncTask(taskId);
        return { taskId, outcome: synced.outcome as "created" | "updated" | "unchanged" };
      } catch (error) {
        const code = error instanceof BitrixGatewayError ? error.code : "unexpected_error";
        if (finalCandidateSet.has(taskId) && PERMANENT_FINAL_CANDIDATE_CODES.has(code.toLowerCase())) {
          await this.repository.markDailyFinalized(taskId);
        }
        return { taskId, outcome: "failed" as const, code };
      }
    });
    return {
      totalEligible: eligibleTaskIds.length,
      attempted: results.length,
      created: results.filter((result) => result.outcome === "created").length,
      updated: results.filter((result) => result.outcome === "updated").length,
      unchanged: results.filter((result) => result.outcome === "unchanged").length,
      failed: results
        .filter((result): result is { taskId: string; outcome: "failed"; code: string } => result.outcome === "failed")
        .map(({ taskId, code }) => ({ taskId, code })),
    };
  }

  async health(): Promise<{ ready: boolean; userId: string; scopes: string[] }> {
    return await this.gateway.health();
  }

}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return output;
}
