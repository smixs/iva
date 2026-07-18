// Surgical .env editor for the Telegram bridge (/model, /think).
// Unlike setup.mjs's writeEnv (full rewrite in a fixed key order, drops comments),
// this edits lines in place: comments, blank lines, unknown keys and order survive.
import { readFile, writeFile, rename, stat, chmod } from "node:fs/promises";

// Lazy value capture + trailing \s*: tolerates CRLF files (a greedy .* would keep the \r).
const LINE_RE = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/;

/** Parse .env text → {KEY: value}; surrounding quotes stripped (same regex as setup.mjs). */
export function parseEnvText(text) {
  const env = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(LINE_RE);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

/** Read .env into {KEY: value}; {} when the file is missing. */
export async function readEnvValues(path) {
  try {
    return parseEnvText(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

// Upsert keys in .env: updates = {KEY: string | null} (null ⇒ drop the line).
// First matching line is replaced in place, duplicates are dropped, missing keys are
// appended at the end. Values must be single-line — a multiline paste (e.g. a mangled
// API key) must fail loudly here, not corrupt .env. Write is atomic (tmp + rename),
// preserving the existing file mode (0600 for a brand-new file — .env holds secrets).
export async function upsertEnv(path, updates) {
  for (const [k, v] of Object.entries(updates)) {
    if (v != null && /[\n\r]/.test(String(v))) throw new Error(`env value for ${k} contains a newline`);
  }
  let text = "";
  let mode = 0o600;
  try {
    text = await readFile(path, "utf8");
    mode = (await stat(path)).mode & 0o777;
  } catch {
    /* no file yet — create from scratch */
  }
  const lines = text.length ? text.split("\n") : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing newline re-added below
  const pending = new Map(Object.entries(updates).map(([k, v]) => [k, v == null ? null : String(v).trim()]));
  const out = [];
  for (const line of lines) {
    const m = line.match(LINE_RE);
    const k = m?.[1];
    if (k && pending.has(k)) {
      const v = pending.get(k);
      pending.delete(k); // duplicates of the same key are dropped
      if (v !== null) out.push(`${k}=${v}`);
      continue;
    }
    // A later duplicate of an already-handled deleted/replaced key: pending no longer has it — drop.
    if (k && k in updates && !pending.has(k)) continue;
    out.push(line);
  }
  for (const [k, v] of pending) if (v !== null) out.push(`${k}=${v}`);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, out.join("\n") + "\n", { encoding: "utf8", mode });
  await chmod(tmp, mode); // writeFile mode is ignored when the tmp file already exists
  await rename(tmp, path);
}
