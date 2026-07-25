import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAuthChallenge, extractCallbackQuery } from "./gws-auth.mjs";

test("parseAuthChallenge extracts the Google URL and loopback port", () => {
  const log = [
    "Open this URL in your browser to authenticate:",
    "",
    "  https://accounts.google.com/o/oauth2/auth?scope=x&redirect_uri=http://localhost:44369&response_type=code&client_id=abc",
    "",
  ].join("\n");
  const r = parseAuthChallenge(log);
  assert.equal(r.port, 44369);
  assert.ok(r.url.startsWith("https://accounts.google.com/o/oauth2/auth?"));
  assert.ok(r.url.includes("redirect_uri=http://localhost:44369"));
});

test("parseAuthChallenge accepts 127.0.0.1 loopback", () => {
  const log = "go: https://accounts.google.com/o/oauth2/auth?redirect_uri=http://127.0.0.1:51000&x=1";
  const r = parseAuthChallenge(log);
  assert.equal(r.port, 51000);
});

test("parseAuthChallenge returns null when the URL is not printed yet", () => {
  assert.equal(parseAuthChallenge("starting auth..."), null);
  assert.equal(parseAuthChallenge(""), null);
});

test("extractCallbackQuery pulls the query from a full redirect URL", () => {
  const q = extractCallbackQuery("http://localhost:44369/?code=4/0ABC_def-123&scope=email%20profile&authuser=0");
  assert.equal(q, "code=4/0ABC_def-123&scope=email%20profile&authuser=0");
});

test("extractCallbackQuery tolerates surrounding whitespace/newlines", () => {
  const q = extractCallbackQuery("  http://localhost:1/?code=4/0X&state=y \n");
  assert.equal(q, "code=4/0X&state=y");
});

test("extractCallbackQuery accepts a bare query string", () => {
  assert.equal(extractCallbackQuery("code=4/0X&scope=y"), "code=4/0X&scope=y");
});

test("extractCallbackQuery accepts a bare authorization code", () => {
  assert.equal(extractCallbackQuery("4/0AXEQabc-DEF_123"), "code=4/0AXEQabc-DEF_123");
});

test("extractCallbackQuery returns null when there is no code", () => {
  assert.equal(extractCallbackQuery("hello there"), null);
  assert.equal(extractCallbackQuery("http://localhost:1/?scope=y"), null);
  assert.equal(extractCallbackQuery(""), null);
});
