import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATALOG,
  FALLBACK_EFFORTS,
  fetchModelOptions,
} from "./model-catalog.mjs";

test("Codex network/malformed failure falls back to models with low/medium/high", async () => {
  const options = await fetchModelOptions("codex", undefined, {
    listCodexCatalog: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(options.map((option) => option.id), CATALOG.codex.models);
  assert.ok(options.every((option) => JSON.stringify(option.reasoningLevels) === JSON.stringify(FALLBACK_EFFORTS)));
});

test("Ollama Cloud and OpenCode Go expose their OpenAI-compatible reasoning contract", async () => {
  for (const provider of ["ollama", "opencode"]) {
    const options = await fetchModelOptions(provider, "test", {
      fetchFn: async () => new Response(JSON.stringify({
        data: [{ id: "reasoning-model" }],
      }), { status: 200 }),
    });
    assert.deepEqual(options, [{
      id: "reasoning-model",
      reasoningLevels: [...FALLBACK_EFFORTS],
    }]);
  }
});

test("heterogeneous OpenRouter catalog does not invent reasoning choices", async () => {
  const options = await fetchModelOptions("openrouter", "unused");
  assert.ok(options.length > 0);
  assert.ok(options.every((option) => option.reasoningLevels.length === 0));
});
