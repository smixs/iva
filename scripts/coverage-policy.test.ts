/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXPECTED_PRODUCTION_COUNT = 178;
const EXPECTED_INVENTORY_SHA256 =
  "31571ec85a16445fbdf67a2423c803ce832b8021668edd2930053083f27e296f";

// Node's native include globs filter loaded modules; they do not load untouched files.
// This test pins the exact production path inventory and a separately measured 26-path
// blind-spot snapshot. It does not determine what the current import graph loads, claim
// that the other paths are reported, or notice import-graph changes without path changes.
// Measured again for this inventory: the web inbound-gate round added `agent/lib/web-gate.ts`
// and `agent/tools/web_fetch.ts`, both reported, and gave `agent/tools/web_search.ts` its
// first loading test - so the blind spot dropped from 26 paths to 25. The subagent slots
// `agent/subagents/planner/tools/web_fetch.ts` and `web_search.ts` came next, both reported
// at 100% by scripts/web-surface-gate.test.ts, so the blind spot stays at 25. The per-node
// sandbox pin `agent/subagents/planner/sandbox.ts` came after it: measured unreported, like
// the root `agent/sandbox.ts` it re-exports - no test loads either - so the blind spot is 26.
// The notice policy module `scripts/lib/notice-policy.ts` and the `/menu` screen that switches
// the reports, `scripts/lib/menu/notices.ts`, came next - both loaded by their own tests and
// reported, so the blind spot stays at 26.
const MEASURED_UNREPORTED_BY_CATEGORY = {
  frameworkBoundaries: [
    "agent/agent.ts",
    "agent/channels/eve.ts",
    "agent/connections/telegram-userbot.ts",
    "agent/hooks/transcript.ts",
    "agent/hooks/usage.ts",
    "agent/instructions/05-language.ts",
    "agent/instructions/20-core.ts",
    "agent/instructions/25-persona.ts",
    "agent/instructions/now.ts",
    "agent/sandbox.ts",
    "agent/subagents/planner/agent.ts",
    "agent/subagents/planner/sandbox.ts",
  ],
  thinAgentTools: [
    "agent/tools/glob.ts",
    "agent/tools/grep.ts",
    "agent/tools/tasks.ts",
  ],
  standaloneOperations: [
    "scripts/build.ts",
    "scripts/check-bash-cwd.ts",
    "scripts/check-reasoning-strip.ts",
    "scripts/daily-digest.ts",
    "scripts/memory/brain.ts",
    "scripts/memory/embed-index.ts",
    "scripts/memory/rollup.ts",
    // A one-shot data migration, run out of the version that introduced it.
    "scripts/migrations/001-iva-port.ts",
    "scripts/replica-smoke.ts",
    "scripts/setup/main.ts",
    // Runs as its own process, spawned by the version being installed.
    "scripts/update-finish.ts",
  ],
} as const;

const EXPECTED_COVERAGE_COMMAND =
  'node --test --test-concurrency=4 --experimental-test-coverage --test-coverage-include="agent/**/*.ts" --test-coverage-include="scripts/**/*.ts" --test-coverage-exclude="**/*.test.ts" --test-coverage-exclude="scripts/fixtures/**/*.ts" --test-coverage-lines=75 --test-coverage-branches=77 --test-coverage-functions=71';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function productionTypeScriptFiles(): string[] {
  const files: string[] = [];

  function visit(relativeDirectory: string): void {
    for (const entry of readdirSync(join(ROOT, relativeDirectory), {
      withFileTypes: true,
    })) {
      const relativePath = posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (relativePath !== "scripts/fixtures") visit(relativePath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        files.push(relativePath);
      }
    }
  }

  visit("agent");
  visit("scripts");
  return files.sort();
}

function digest(paths: readonly string[]): string {
  return createHash("sha256").update(paths.join("\n")).digest("hex");
}

function assertProductionPathInventory(
  productionFiles: readonly string[],
): void {
  assert.equal(
    productionFiles.length,
    EXPECTED_PRODUCTION_COUNT,
    "production TypeScript inventory changed; rerun scoped coverage and classify the changed files",
  );
  assert.equal(
    digest(productionFiles),
    EXPECTED_INVENTORY_SHA256,
    "production TypeScript paths changed; rerun scoped coverage before updating the inventory ratchet",
  );

  const measuredUnreported = Object.values(MEASURED_UNREPORTED_BY_CATEGORY)
    .flat()
    .sort();
  assert.equal(measuredUnreported.length, 26);
  assert.equal(new Set(measuredUnreported).size, measuredUnreported.length);
  assert.deepEqual(
    measuredUnreported.filter((path) => !productionFiles.includes(path)),
    [],
    "the measured coverage blind-spot snapshot contains a missing production file",
  );
}

test("coverage policy pins production paths and the measured blind-spot snapshot", () => {
  const productionFiles = productionTypeScriptFiles();
  assertProductionPathInventory(productionFiles);

  assert.throws(
    () =>
      assertProductionPathInventory(
        [...productionFiles, "agent/lib/unclassified-production.ts"].sort(),
      ),
    /production TypeScript inventory changed/u,
  );
});

test("coverage command is the exact cross-platform production policy", () => {
  const parsed: unknown = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  assert.ok(isRecord(parsed));
  assert.ok(isRecord(parsed.scripts));
  const command = parsed.scripts["test:coverage"];
  if (typeof command !== "string") {
    throw new TypeError("test:coverage must be a package script");
  }
  assert.equal(command, EXPECTED_COVERAGE_COMMAND);
});
