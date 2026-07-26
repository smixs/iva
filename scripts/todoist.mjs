#!/usr/bin/env node
// Todoist CLI for Iva — a thin, self-contained client the agent calls over `bash`, the same way it
// calls `gws` for Google. No separate user, no service, no build: Iva runs with full host access by
// design (see docs/security.md), so Todoist lives in-process like every other tool.
//
// Auth is a personal API token (Todoist → Settings → Integrations → Developer → API token), read
// from $TODOIST_API_TOKEN or ~/.config/iva-todoist/token (0600). Never passed on the command line.
//
// Output is always a single JSON line — parse it, don't narrate the raw HTTP. Exit codes mirror gws:
//   0 ok · 1 API/network error · 2 not authorized (no token) · 3 bad arguments
//
// Mutations (add/close/reopen/delete) act immediately. Branching and confirmation before a mutation
// are the agent's job via the built-in `ask_question` tool (inline buttons in Telegram) — see the
// `todoist` skill. This CLI stays a plain executor.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

const API = "https://api.todoist.com/api/v1/";
const CONFIG_DIR = join(homedir(), ".config/iva-todoist");
const TOKEN_FILE = join(CONFIG_DIR, "token");

const EXIT = { OK: 0, API: 1, UNAUTH: 2, ARGS: 3 };

// Print one JSON line to stdout — the CLI's only output channel (callers parse it, never the raw text).
function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
// Emit an error as JSON and exit with the given code (0 ok · 1 API · 2 unauthorized · 3 bad args).
function fail(code, message, extra = {}) {
  out({ ok: false, error: message, ...extra });
  process.exit(code);
}

// Resolve the Todoist token: $TODOIST_API_TOKEN wins, else the 0600 file; null when neither is set.
function readToken() {
  const env = (process.env.TODOIST_API_TOKEN || "").trim();
  if (env) return env;
  try {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  } catch {
    /* no file */
  }
  return null;
}

// Parse `--flag value` / `--flag=value` / bare `--flag` (boolean) into an object.
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[a.slice(2)] = argv[++i];
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return flags;
}

// One authenticated Todoist API call. Builds the URL + query, sends the Bearer token, and enforces a
// timeout. 401/403 exits 2, other non-2xx exits 1; 204 → null, otherwise the parsed JSON body.
async function api(method, path, { query, body, token, timeoutMs = 15000 } = {}) {
  const url = new URL(path, API);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  let res;
  // Bound every call so a stalled Todoist request can't hang the agent's turn.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    fail(EXIT.API, e?.name === "AbortError" ? "Todoist request timed out" : `network error: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) fail(EXIT.UNAUTH, "Todoist rejected the token (401/403) — re-authorize");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    fail(EXIT.API, `Todoist API ${res.status}`, { detail: text.slice(0, 300) });
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

// Follow v1 cursor pagination ({results, next_cursor}) to a bounded number of pages.
async function listAll(path, token, query = {}) {
  const items = [];
  let cursor;
  for (let page = 0; page < 25; page++) {
    const data = await api("GET", path, { token, query: { ...query, limit: 200, cursor } });
    const results = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
    items.push(...results);
    cursor = data?.next_cursor;
    if (!cursor) break;
  }
  return items;
}

// Project → compact shape for the model (drop fields it doesn't need).
const slimProject = (p) => ({ id: p.id, name: p.name, parentId: p.parent_id ?? null, isInbox: !!p.is_inbox_project });
// Task → compact shape for the model (id, content, project, due string, priority, url).
const slimTask = (t) => ({
  id: t.id,
  content: t.content,
  projectId: t.project_id ?? null,
  due: t.due?.string ?? t.due?.date ?? null,
  priority: t.priority ?? 1,
  url: t.url,
});

// Dispatch the sub-command (auth/projects/tasks/add/close/reopen/delete/get/set-token/logout).
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  // set-token reads the token from STDIN (never argv) and stores it 0600. Used by /menu and setup.
  if (command === "set-token") {
    const token = readFileSync(0, "utf8").trim();
    if (!token) fail(EXIT.ARGS, "empty token on stdin");
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
    chmodSync(TOKEN_FILE, 0o600);
    out({ ok: true, stored: TOKEN_FILE });
    return;
  }
  if (command === "logout") {
    if (existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, "", { mode: 0o600 });
    out({ ok: true, removed: true });
    return;
  }

  const token = readToken();
  if (!token) fail(EXIT.UNAUTH, "not authorized — no Todoist token (set one via /menu or `todoist set-token`)");

  switch (command) {
    case "auth": {
      // A single lightweight call confirms the token — don't paginate the whole account (keeps the
      // menu's 2s probe fast). Any 200 means authorized; 401/403 already exits 2 inside api().
      await api("GET", "projects", { token, query: { limit: 1 } });
      out({ ok: true, authorized: true });
      return;
    }
    case "projects": {
      const projects = await listAll("projects", token);
      out({ ok: true, items: projects.map(slimProject) });
      return;
    }
    case "tasks": {
      // Two distinct endpoints: GET /tasks (optionally ?project_id=) lists a project's tasks, while
      // filter queries ("today", "overdue", "#Work") go through GET /tasks/filter?query= — the plain
      // /tasks endpoint silently ignores a filter param. Compose a project into the filter query
      // itself (e.g. --filter "#Work & today") rather than mixing the two.
      if (flags.filter && flags.project) {
        fail(EXIT.ARGS, "use either --project or --filter, not both — put the project in the filter, e.g. --filter \"#Work & today\"");
      }
      const tasks = flags.filter
        ? await listAll("tasks/filter", token, { query: String(flags.filter) })
        : await listAll("tasks", token, flags.project ? { project_id: String(flags.project) } : {});
      out({ ok: true, items: tasks.map(slimTask) });
      return;
    }
    case "add": {
      if (!flags.content) fail(EXIT.ARGS, "add needs --content");
      const body = { content: String(flags.content) };
      if (flags.due) body.due_string = String(flags.due);
      if (flags.project) body.project_id = String(flags.project);
      if (flags.priority) body.priority = Number(flags.priority); // 1 (normal) .. 4 (urgent)
      if (flags.description) body.description = String(flags.description);
      const task = await api("POST", "tasks", { token, body });
      out({ ok: true, task: task ? slimTask(task) : null });
      return;
    }
    case "close":
    case "reopen": {
      if (!flags.id) fail(EXIT.ARGS, `${command} needs --id`);
      await api("POST", `tasks/${encodeURIComponent(flags.id)}/${command}`, { token });
      out({ ok: true, id: flags.id, [command === "close" ? "closed" : "reopened"]: true });
      return;
    }
    case "delete": {
      if (!flags.id) fail(EXIT.ARGS, "delete needs --id");
      await api("DELETE", `tasks/${encodeURIComponent(flags.id)}`, { token });
      out({ ok: true, id: flags.id, deleted: true });
      return;
    }
    case "get": {
      if (!flags.id) fail(EXIT.ARGS, "get needs --id");
      const task = await api("GET", `tasks/${encodeURIComponent(flags.id)}`, { token });
      out({ ok: true, task: task ? slimTask(task) : null });
      return;
    }
    default:
      fail(EXIT.ARGS, `unknown command: ${command ?? "(none)"}`, {
        commands: ["auth", "projects", "tasks", "add", "close", "reopen", "delete", "get", "set-token", "logout"],
      });
  }
}

// Run only when invoked directly (`node scripts/todoist.mjs …`), not when imported by a test.
// Prefer import.meta.main (Node ≥24.2); fall back to a realpath comparison that tolerates relative
// argv and symlinked install paths.
function invokedDirectly() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  if (!argv[1]) return false;
  try {
    return realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  main().catch((e) => fail(EXIT.API, e?.message || String(e)));
}
