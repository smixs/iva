import test from "node:test";
import assert from "node:assert/strict";
import { classifyDeliverStatus } from "./deliver-policy.mjs";

test("сетевые и серверные сбои ретраятся быстро: 5xx, 408, 425, 429", () => {
  for (const s of [500, 502, 503, 529, 408, 425, 429]) {
    assert.equal(classifyDeliverStatus(s), "retry", `status ${s}`);
  }
});

test("401/403/404 — сломанная конфигурация: ретрай с длинным бэкоффом, не дроп", () => {
  for (const s of [401, 403, 404]) {
    assert.equal(classifyDeliverStatus(s), "config", `status ${s}`);
  }
});

test("постоянные клиентские ошибки дропаются: прочие 4xx", () => {
  for (const s of [400, 413, 422]) {
    assert.equal(classifyDeliverStatus(s), "drop", `status ${s}`);
  }
});

test("503 acceptance-роута — ограниченный dispatch-дроп, а не вечный 5xx-ретрай", () => {
  assert.equal(classifyDeliverStatus(503), "retry");
  assert.equal(classifyDeliverStatus(503, { acceptance: true }), "drop");
  assert.equal(classifyDeliverStatus(502, { acceptance: true }), "retry");
  assert.equal(classifyDeliverStatus(401, { acceptance: true }), "config");
});
