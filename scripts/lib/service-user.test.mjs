import { test } from "node:test";
import assert from "node:assert/strict";
import { pickServiceUserName, userExists } from "./service-user.mjs";

test("pickServiceUserName: returns the base name when it's free", () => {
  assert.equal(pickServiceUserName("iva", () => false), "iva");
});

test("pickServiceUserName: falls back to zero-padded numbered variant", () => {
  const taken = new Set(["iva"]);
  assert.equal(pickServiceUserName("iva", (n) => taken.has(n)), "iva_001");
});

test("pickServiceUserName: skips consecutive taken variants", () => {
  const taken = new Set(["iva", "iva_001", "iva_002"]);
  assert.equal(pickServiceUserName("iva", (n) => taken.has(n)), "iva_003");
});

test("pickServiceUserName: throws when the numbered space is exhausted", () => {
  assert.throws(() => pickServiceUserName("iva", () => true, { max: 3 }), /No free iva_NNN/);
});

test("userExists: true when getent exits 0", () => {
  assert.equal(userExists("iva", (cmd) => (cmd === "getent" ? { status: 0 } : { status: 1 })), true);
});

test("userExists: false when getent exits non-zero", () => {
  assert.equal(userExists("nope", (cmd) => (cmd === "getent" ? { status: 2 } : { status: 0 })), false);
});

test("userExists: falls back to id when getent is unavailable", () => {
  const run = (cmd) => (cmd === "getent" ? { status: undefined } : { status: 0 }); // id -> exists
  assert.equal(userExists("iva", run), true);
});
