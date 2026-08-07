/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MODEL_PROVIDER_NAMES,
  resolveModelProvider,
} from "./model-provider.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

test("model provider selection defaults to Ollama", () => {
  assert.deepEqual(resolveModelProvider({}), {
    name: "ollama",
    model: "deepseek-v4-pro",
    compatibleReasoning: true,
  });
});

test("model provider selection preserves each supported provider identity", () => {
  assert.deepEqual(
    resolveModelProvider({
      MODEL_PROVIDER: "ollama",
      OLLAMA_MODEL: "ollama-model",
    }),
    { name: "ollama", model: "ollama-model", compatibleReasoning: true },
  );
  assert.deepEqual(
    resolveModelProvider({
      MODEL_PROVIDER: "opencode",
      OPENCODE_MODEL: "opencode-go/opencode-model",
    }),
    { name: "opencode", model: "opencode-model", compatibleReasoning: true },
  );
  assert.deepEqual(
    resolveModelProvider({
      MODEL_PROVIDER: "openrouter",
      OPENROUTER_MODEL: "vendor/router-model",
    }),
    {
      name: "openrouter",
      model: "vendor/router-model",
      compatibleReasoning: false,
    },
  );
  assert.deepEqual(
    resolveModelProvider({
      MODEL_PROVIDER: "codex",
      CODEX_MODEL: "codex-model",
    }),
    { name: "codex", model: "codex-model", compatibleReasoning: false },
  );
});

test("model provider selection rejects values that would split runtime identity", () => {
  assert.deepEqual(MODEL_PROVIDER_NAMES, [
    "ollama",
    "opencode",
    "openrouter",
    "codex",
  ]);
  for (const value of ["ollmaa", " ollama", "ollama ", "OLLAMA", ""]) {
    assert.throws(
      () => resolveModelProvider({ MODEL_PROVIDER: value }),
      new RegExp(
        `Invalid MODEL_PROVIDER ${JSON.stringify(value)}; expected one of: ollama, opencode, openrouter, codex`,
      ),
    );
  }
});

test("runtime configuration and usage share the resolved provider identity", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-provider-usage-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const script = `
    const provider = await import("./agent/provider.ts");
    const usage = (await import("./agent/hooks/usage.ts")).default;
    usage.events["step.completed"](
      { data: { stepIndex: 1, turnId: "turn_1", usage: { inputTokens: 2, outputTokens: 3 } } },
      { session: { id: "session_1" }, channel: { kind: "test" } },
    );
    console.log(JSON.stringify({
      name: provider.providerName,
      model: provider.providerConfig.textModel,
      effort: provider.compatibleThinkingEffort,
    }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ASSISTANT_DATA_DIR: dataDir,
        MODEL_PROVIDER: "opencode",
        OPENCODE_MODEL: "opencode-go/test-model",
        THINKING_EFFORT: "high",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    name: "opencode",
    model: "test-model",
    effort: "high",
  });
  const usage: unknown = JSON.parse(
    readFileSync(join(dataDir, "usage.jsonl"), "utf8"),
  );
  assert.equal(isRecord(usage), true);
  if (!isRecord(usage)) return;
  assert.equal(usage.provider, "opencode");
  assert.equal(usage.model, "test-model");
});

test("runtime startup rejects an invalid provider before choosing a config", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", 'await import("./agent/provider.ts")'],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, MODEL_PROVIDER: "ollmaa" },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Invalid MODEL_PROVIDER "ollmaa"; expected one of: ollama, opencode, openrouter, codex/,
  );
});
