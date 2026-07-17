import { request } from "node:http";
import type { BitrixTaskSnapshot, BitrixTaskStatusFilter, BitrixTaskSummary } from "./types.js";

const DEFAULT_SOCKET = "/run/iva-bitrix/gateway.sock";
export const DEFAULT_GATEWAY_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

interface GatewayErrorBody {
  ok: false;
  error?: { code?: string; message?: string; retryAt?: string };
}

export class BitrixGatewayError extends Error {
  readonly code: string;
  readonly retryAt: string | null;

  constructor(code: string, message: string, retryAt?: string | null) {
    super(message);
    this.name = "BitrixGatewayError";
    this.code = code.trim().toLowerCase() || "gateway_error";
    this.retryAt = retryAt ?? null;
  }
}

function validateTaskId(value: string | number): string {
  const id = String(value);
  if (!/^[1-9]\d*$/.test(id)) {
    throw new BitrixGatewayError("invalid_task_id", "Bitrix task ID must be a positive integer");
  }
  return id;
}

export class BitrixGatewayClient {
  constructor(
    private readonly socketPath = process.env.BITRIX_GATEWAY_SOCKET || DEFAULT_SOCKET,
    private readonly timeoutMs = DEFAULT_GATEWAY_TIMEOUT_MS,
  ) {}

  async listTasks(input: {
    status: BitrixTaskStatusFilter;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ userId: string; tasks: BitrixTaskSummary[]; total: number }> {
    const limit = Math.min(100, Math.max(1, input.limit ?? 100));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const params = new URLSearchParams({ status: input.status, limit: String(limit), offset: String(offset) });
    if (input.search?.trim()) params.set("search", input.search.trim());
    const body = await this.get<{
      ok: true;
      userId: string;
      tasks: BitrixTaskSummary[];
      total: number;
    }>(`/v1/tasks?${params.toString()}`);
    return { userId: body.userId, tasks: body.tasks, total: body.total };
  }

  async listActiveTasks(): Promise<{ userId: string; tasks: BitrixTaskSummary[]; total: number }> {
    const body = await this.get<{
      ok: true;
      userId: string;
      tasks: BitrixTaskSummary[];
      total: number;
    }>("/v1/tasks/active");
    return { userId: body.userId, tasks: body.tasks, total: body.total };
  }

  async getSnapshot(taskId: string | number): Promise<BitrixTaskSnapshot> {
    const id = validateTaskId(taskId);
    const body = await this.get<{ ok: true; snapshot: BitrixTaskSnapshot }>(
      `/v1/tasks/${encodeURIComponent(id)}/snapshot`,
    );
    return body.snapshot;
  }

  async health(): Promise<{ ready: boolean; userId: string; scopes: string[] }> {
    const body = await this.get<{
      ok: true;
      ready: boolean;
      userId: string;
      scopes: string[];
    }>("/health");
    return { ready: body.ready, userId: body.userId, scopes: body.scopes };
  }

  private async get<T extends { ok: true }>(path: string): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path,
          method: "GET",
          headers: { accept: "application/json" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer | string) => {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += part.length;
            if (bytes > MAX_RESPONSE_BYTES) {
              req.destroy(new Error("gateway_response_too_large"));
              return;
            }
            chunks.push(part);
          });
          res.on("end", () => {
            let parsed: T | GatewayErrorBody;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as T | GatewayErrorBody;
            } catch {
              reject(new BitrixGatewayError("gateway_invalid_response", "Bitrix gateway returned invalid JSON"));
              return;
            }
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && parsed.ok) {
              resolve(parsed as T);
              return;
            }
            const errorBody = parsed as GatewayErrorBody;
            const errorCode = (errorBody.error?.code || "gateway_error").trim().toLowerCase();
            reject(
              new BitrixGatewayError(
                errorCode,
                errorBody.error?.message || "Bitrix gateway request failed",
                errorBody.error?.retryAt,
              ),
            );
          });
        },
      );
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error("gateway_timeout")));
      req.on("error", (error) => {
        const code = error.message === "gateway_timeout" ? "gateway_timeout" : "gateway_unavailable";
        reject(new BitrixGatewayError(code, code === "gateway_timeout" ? "Bitrix gateway timed out" : "Bitrix gateway is unavailable"));
      });
      req.end();
    });
  }
}

export { validateTaskId };
