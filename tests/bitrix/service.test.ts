import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BitrixGatewayClient,
  BitrixGatewayError,
  DEFAULT_GATEWAY_TIMEOUT_MS,
} from "../../agent/bitrix/gateway-client.js";
import { BitrixTaskRepository } from "../../agent/bitrix/repository.js";
import { BitrixTaskService, isTransientBitrixError } from "../../agent/bitrix/service.js";
import { safeBitrixError } from "../../agent/bitrix/runtime.js";
import type { BitrixTaskSnapshot } from "../../agent/bitrix/types.js";

const snapshot: BitrixTaskSnapshot = {
  task: {
    id: "42",
    title: "Test",
    description: "Data only",
    groupId: "97",
    url: "https://b24.example/task/42/",
    status: "in_progress",
    realStatus: 3,
    closed: false,
    creator: { id: "1", name: "Creator" },
    responsible: { id: "1274", name: "Owner" },
    accomplices: [],
    deadline: null,
    changedAt: null,
    closedAt: null,
    checklist: [],
  },
  discussion: { source: "none", messages: [] },
};

test("the production install contains the TypeScript runner", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const packageLock = JSON.parse(
    await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"),
  ) as {
    packages: Record<string, { dependencies?: Record<string, string>; dev?: boolean }>;
  };

  assert.equal(packageJson.dependencies?.tsx, "4.20.6");
  assert.equal(packageJson.devDependencies?.tsx, undefined);
  assert.equal(packageLock.packages[""].dependencies?.tsx, "4.20.6");
  for (const packagePath of [
    "node_modules/tsx",
    "node_modules/esbuild",
    "node_modules/get-tsconfig",
    "node_modules/resolve-pkg-maps",
  ]) {
    assert.equal(packageLock.packages[packagePath]?.dev, undefined, `${packagePath} is runtime`);
  }
});

test("read falls back to a dated snapshot only for transient failures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iva-bitrix-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new BitrixTaskRepository(join(root, "vault"), join(root, "data"));
  let error: BitrixGatewayError | null = null;
  const gateway = {
    getSnapshot: async () => {
      if (error) throw error;
      return structuredClone(snapshot);
    },
    listTasks: async () => ({ userId: "1274", tasks: [], total: 0 }),
    health: async () => ({ ready: true, userId: "1274", scopes: ["task", "im"] }),
  } as unknown as BitrixGatewayClient;
  const service = new BitrixTaskService(gateway, repository);
  await service.syncTask(42);

  error = new BitrixGatewayError("BITRIX_UNAVAILABLE", "offline");
  const stale = await service.readTask(42);
  assert.equal(stale.stale, true);
  assert.ok(stale.snapshotDate);

  for (const code of ["POLICY_DATA_INCOMPLETE", "SCOPE_MISSING", "CHAT_READ_STATE_UNVERIFIED"]) {
    error = new BitrixGatewayError(code, "blocked");
    await assert.rejects(service.readTask(42), (caught) => caught === error);
  }
});

test("only sidecar unavailability and rate limits are transient", () => {
  assert.equal(isTransientBitrixError(new BitrixGatewayError("BITRIX_UNAVAILABLE", "offline")), true);
  assert.equal(isTransientBitrixError(new BitrixGatewayError("BITRIX_RATE_LIMITED", "limited")), true);
  assert.equal(isTransientBitrixError(new BitrixGatewayError("BITRIX_OVERLOAD_LIMIT", "busy")), true);
  for (const code of [
    "BITRIX_ACCESS_DENIED",
    "TASK_OUTSIDE_GROUP",
    "POLICY_DATA_INCOMPLETE",
    "SCOPE_MISSING",
    "CHAT_READ_STATE_UNVERIFIED",
  ]) {
    assert.equal(isTransientBitrixError(new BitrixGatewayError(code, "blocked")), false);
  }
});

test("invalid task id is rejected before any gateway call", async () => {
  let calls = 0;
  const gateway = { getSnapshot: async () => (calls++, snapshot) } as unknown as BitrixGatewayClient;
  const service = new BitrixTaskService(gateway, new BitrixTaskRepository("vault", "data"));
  await assert.rejects(service.syncTask("../42"), /positive integer/);
  assert.equal(calls, 0);
});

test("gateway IPC timeout leaves room for bounded sidecar retries", () => {
  assert.equal(DEFAULT_GATEWAY_TIMEOUT_MS, 90_000);
});

test("persisted future backoff skips gateway while expired and invalid timestamps proceed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iva-bitrix-backoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new BitrixTaskRepository(join(root, "vault"), join(root, "data"));
  await repository.sync(snapshot);
  let gatewayCalls = 0;
  const gateway = {
    getSnapshot: async () => {
      gatewayCalls += 1;
      return structuredClone(snapshot);
    },
  } as unknown as BitrixGatewayClient;
  const service = new BitrixTaskService(gateway, repository);

  const future = new Date(Date.now() + 60_000).toISOString();
  await repository.recordFailure("42", "bitrix_rate_limited", future);
  await assert.rejects(service.syncTask("42"), (error) => (
    error instanceof BitrixGatewayError
    && error.code === "bitrix_rate_limited"
    && error.retryAt === future
  ));
  assert.equal(gatewayCalls, 0);

  await repository.recordFailure("42", "bitrix_rate_limited", new Date(Date.now() - 1_000).toISOString());
  await service.syncTask("42");
  assert.equal(gatewayCalls, 1);

  await repository.recordFailure("42", "bitrix_rate_limited", "not-a-timestamp");
  await service.syncTask("42");
  assert.equal(gatewayCalls, 2);
});

test("sidecar error codes are lowercased and mapped to safe public messages", () => {
  const codes = [
    "CHAT_READ_STATE_UNVERIFIED",
    "TASK_OUTSIDE_GROUP",
    "TASK_NOT_AUTHORIZED",
    "POLICY_DATA_INCOMPLETE",
    "SCOPE_MISSING",
    "BITRIX_RATE_LIMITED",
    "BITRIX_UNAVAILABLE",
    "BITRIX_NETWORK_ERROR",
    "BITRIX_TIMEOUT",
  ];
  for (const code of codes) {
    const normalized = code.toLowerCase();
    const error = new BitrixGatewayError(code, "unsafe upstream detail");
    assert.equal(error.code, normalized);
    const publicError = safeBitrixError(error);
    assert.equal(publicError.error.code, normalized);
    assert.notEqual(publicError.error.message, "Не удалось прочитать данные Bitrix безопасным способом.");
    assert.doesNotMatch(publicError.error.message, /unsafe upstream detail/u);
  }
});

test("daily sync finalizes declined and closedAt tasks once and skips newly discovered closed tasks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iva-bitrix-daily-closed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new BitrixTaskRepository(join(root, "vault"), join(root, "data"));

  const taskSnapshot = (
    id: string,
    task: Partial<BitrixTaskSnapshot["task"]> = {},
  ): BitrixTaskSnapshot => {
    const value = structuredClone(snapshot);
    Object.assign(value.task, {
      id,
      url: `https://b24.example/task/${id}/`,
      ...task,
    });
    return value;
  };

  await repository.sync(taskSnapshot("43"));
  await repository.sync(taskSnapshot("44"));
  await repository.sync(taskSnapshot("46"));
  await repository.sync(taskSnapshot("47", { status: "declined", realStatus: 7, closed: true }));

  const current = new Map<string, BitrixTaskSnapshot>([
    ["42", taskSnapshot("42")],
    ["43", taskSnapshot("43", { status: "declined", realStatus: 7, closed: true })],
    ["44", taskSnapshot("44", {
      status: "in_progress",
      realStatus: 3,
      closedAt: "2026-07-16T12:00:00+05:00",
      closed: true,
    })],
    ["45", taskSnapshot("45", { status: "declined", realStatus: 7, closed: true })],
    ["46", taskSnapshot("46")],
    ["47", taskSnapshot("47", { status: "declined", realStatus: 7, closed: true })],
  ]);
  const summaries = [current.get("42")!].map(({ task }) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    realStatus: task.realStatus,
    closed: task.closed,
    deadline: task.deadline,
    role: "responsible" as const,
    changedAt: task.changedAt,
  }));
  const snapshotCalls: string[] = [];
  let activeListCalls = 0;
  const gateway = {
    listActiveTasks: async () => {
      activeListCalls += 1;
      return { userId: "1274", tasks: summaries, total: summaries.length };
    },
    listTasks: async () => {
      throw new Error("daily sync must not use the paged public list");
    },
    getSnapshot: async (taskId: string | number) => {
      const id = String(taskId);
      snapshotCalls.push(id);
      const value = current.get(id);
      if (!value) throw new Error("missing fixture");
      return structuredClone(value);
    },
    health: async () => ({ ready: true, userId: "1274", scopes: ["task", "im"] }),
  } as unknown as BitrixGatewayClient;
  const service = new BitrixTaskService(gateway, repository);

  const first = await service.syncDaily(2);
  assert.equal(first.totalEligible, 4);
  assert.equal(activeListCalls, 1);
  assert.deepEqual([...snapshotCalls].sort(), ["42", "43", "44", "46"]);
  assert.equal((await repository.readState("43"))?.closed, true);
  assert.equal((await repository.readState("44"))?.closed, true);
  assert.equal((await repository.readState("46"))?.closed, false);
  assert.equal((await repository.readState("47"))?.closed, true);
  assert.equal(await repository.readState("45"), null);

  snapshotCalls.length = 0;
  const second = await service.syncDaily(2);
  assert.equal(second.totalEligible, 2);
  assert.equal(activeListCalls, 2);
  assert.deepEqual([...snapshotCalls].sort(), ["42", "46"]);
  assert.equal(await repository.readState("45"), null);
});
