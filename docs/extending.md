# Extending

Everything Iva does is a file in `agent/`. Drop a new one, rebuild, restart — eve picks it up. No plugin API, no registry. On the server every change ships the same way: `npm run build`, then `iva restart` ([cli.md](./cli.md)).

## Adding a skill

Skills are markdown procedures in `agent/skills/` that the model loads on demand. The frontmatter `description` is the only part the model sees before loading — write it as a trigger condition ("Use when…"), not a summary. Two shapes work: a flat `<name>.md`, or a `<name>/` directory with a `SKILL.md` plus supporting files. The four bundled skills are your templates, simplest first:

- 📋 **morning-digest.md** — one tool call (`tasks`), grouping rules, output format. Copy this for any "call a tool, format the result" job.
- 🔎 **web-research.md** — a 4-step chain: `web_search` → pick 2–4 sources → `web_fetch` each → synthesize with links.
- 🌐 **agent-browser/** — directory skill wrapping a CLI the model drives through `bash`.
- 🛡 **security-defense/** — the full shape: `SKILL.md`, bundled scripts, a patterns file.

If Iva should reach for your skill unprompted, name it in `agent/instructions.md` — that's how all four above get triggered.

## MCP connections

Drop `agent/connections/<name>.ts` — the filename becomes the connection name. `example.ts.txt` in that folder is the inert template (the `.txt` suffix keeps eve from loading it half-configured):

```ts
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.example.com/sse", // Streamable HTTP or SSE endpoint
  description: "What this server does — the model reads this.",
  auth: { getToken: async () => ({ token: process.env.EXAMPLE_MCP_TOKEN ?? "" }) },
  // tools: { allow: ["search", "get_item"] },  // optional: restrict, add approval
});
```

The model discovers the server's tools through the built-in `connection_search` and calls them as `connection__<name>__<tool>`. The URL and token stay on the runtime side: keys live in `.env` and are never visible to the model.

## Subagents

A subagent is `agent/subagents/<name>/` with an `agent.ts` and its own `instructions.md`. The bundled `planner` is the pattern: its `description` tells the main agent when to delegate ("break a large goal into steps"), and a zod `outputSchema` forces a structured, validated reply instead of prose:

```ts
outputSchema: z.object({
  goal: z.string(),
  steps: z.array(z.object({
    title: z.string(), detail: z.string(), priority: z.enum(["low", "med", "high"]),
  })),
}),
```

A subagent brings its own provider and model: the planner pins Ollama Cloud (`OLLAMA_API_KEY` / `OLLAMA_MODEL`) in its `agent.ts`, independent of the main agent's `MODEL_PROVIDER` — so a cheap model for a narrow job costs nothing extra to wire.

## Changing the character

Iva's voice lives in exactly one file: `agent/instructions.md` — tone, rules, tool preferences, hard limits. Edit it directly. It is deliberately language-neutral: the reply language comes from `AGENT_LANGUAGE` in `.env`, read at startup by `agent/instructions/05-language.ts` (changing it needs a rebuild + restart). The other files in `agent/instructions/` are machinery, not character — `10-map.md` (memory protocol), `20-core.ts` (injects the vault's CORE.md), `now.ts` (date/time). One rule if you touch `05-language.ts`: keep it importing only `eve/instructions` and `process.env` — pulling in another authored module trips the eve 0.11.4 bug below.

What Iva knows about *you* is memory, not code — that's `CORE.md` in the vault ([memory.md](./memory.md)).

## Local development

```bash
npm ci        # postinstall applies patches/eve+0.11.4.patch
npm run dev   # eve dev TUI, server on http://127.0.0.1:2000
npm exec -- eve dev --no-ui --logs all   # headless
```

The TUI is a full chat — skills, tools and subagents all work without Telegram. To smoke-test the tool loop from a script, drive the dev server with `eve/client`:

```js
import { Client } from "eve/client";
const session = new Client({ host: "http://127.0.0.1:2000" }).session();
const res = await session.send("Add a task: buy coffee, high priority.");
console.log((await res.result()).message);
```

Two gotchas, both eve 0.11.4:

- ⚠️ **Schedule crash** — `eve dev` crashes if a schedule handler in `agent/` imports another authored module (a channel, for instance). That's why the repo ships no `agent/schedules/*.ts`: on a VPS `defineSchedule` never fires anyway, systemd timers do that job ([deploy.md](./deploy.md)).
- 🩹 **patch-package** — `patches/eve+0.11.4.patch` makes deterministic model-call errors (invalid prompt, unknown tool) fail fast instead of retrying forever. If you bump eve, re-check the patch or drop it and retest.
