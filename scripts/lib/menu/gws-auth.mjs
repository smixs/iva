// Headless OAuth relay for the `gws` (Google Workspace) CLI.
//
// `gws auth login` only supports the loopback flow: it starts a local HTTP server on
// http://localhost:<random-port> and waits for Google to redirect the browser there with the
// authorization code. On a headless server the user's browser is on a different machine, so the
// redirect never reaches the server's listener and the flow can never complete.
//
// This module drives the same flow from the bot: start gws (capturing its auth URL + loopback
// port), hand the URL to the user over Telegram, and when the user pastes the failed redirect URL
// back, replay it against the loopback listener locally on the server so gws finishes and stores
// the token. Pure parsers are separated for unit testing.
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// --- Pure parsers (unit-tested in gws-auth.test.mjs) ---

// From gws stdout, pull the Google consent URL and the loopback port it registered.
// Returns { url, port } once gws has printed them, else null.
export function parseAuthChallenge(logText) {
  const text = String(logText ?? "");
  const url = text.match(/https:\/\/accounts\.google\.com\/[^\s]+/)?.[0];
  const port = text.match(/redirect_uri=http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/)?.[1];
  if (!url || !port) return null;
  return { url, port: Number(port) };
}

// Normalize whatever the user pasted back into the raw callback query string (must carry `code`).
// Accepts a full redirect URL, a bare `code=...&...` query, or a bare `4/...` authorization code.
export function extractCallbackQuery(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;

  let query = null;
  const urlMatch = text.match(/https?:\/\/\S+/);
  if (urlMatch) {
    const qi = urlMatch[0].indexOf("?");
    if (qi >= 0) query = urlMatch[0].slice(qi + 1);
  } else if (text.includes("=")) {
    query = text.replace(/^\?/, "");
  } else if (/^4\/[\w-]+$/.test(text)) {
    return `code=${text}`;
  }

  if (!query) return null;
  query = query.split(/\s/)[0];
  if (!new URLSearchParams(query).get("code")) return null;
  return query;
}

// --- Environment: resolve gws + node without relying on the service PATH ---
// The systemd unit's PATH does not include the nvm bin dir, so `gws` is not on PATH and gws's own
// `#!/usr/bin/env node` shebang cannot find node. Resolve gws next to the running node and inject
// that dir into the child PATH so both are found.
const NODE_BIN_DIR = dirname(process.execPath);

export function gwsBin() {
  const p = join(NODE_BIN_DIR, "gws");
  return existsSync(p) ? p : "gws";
}

export function childEnv() {
  const path = process.env.PATH ? `${NODE_BIN_DIR}:${process.env.PATH}` : NODE_BIN_DIR;
  return { ...process.env, PATH: path };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Start `gws auth login` detached, capturing stdout to a temp log. Poll the log until gws prints
// the consent URL + loopback port, then return { pid, port, url, logPath }. Returns null if gws
// never printed the challenge (died early / timed out) — the child is killed in that case.
export async function startAuth({ services = "gmail,calendar,drive", timeoutMs = 6000 } = {}) {
  const logPath = join(tmpdir(), `iva-gws-auth-${process.pid}-${Date.now()}.log`);
  const fd = openSync(logPath, "a");
  let child;
  try {
    child = spawn(gwsBin(), ["auth", "login", "-s", services], {
      env: childEnv(),
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    let logText = "";
    try {
      logText = await readFile(logPath, "utf8");
    } catch {
      /* not written yet */
    }
    const parsed = parseAuthChallenge(logText);
    if (parsed) return { pid: child.pid, logPath, ...parsed };
    if (child.exitCode !== null || child.signalCode !== null) break; // died before printing
  }
  try {
    if (child.pid) process.kill(child.pid);
  } catch {
    /* already gone */
  }
  return null;
}

// Replay the callback query against the loopback listener on the server, completing the flow gws
// is waiting on. Returns { ok, status }.
export function relayCode(port, query, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: `/?${query}`, method: "GET", timeout: timeoutMs },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0 });
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.end();
  });
}
