import test from "node:test";
import assert from "node:assert/strict";
import { SEARCH_CATALOG, checkSearchKey } from "./search-catalog.mjs";

// checkSearchKey читает глобальный fetch в рантайме (без DI), поэтому пробу перехватываем
// подменой globalThis.fetch на время одного вызова; оригинал возвращаем в finally.
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("каталог перечисляет все 4 провайдера с label/keyVar/url", () => {
  assert.deepEqual(Object.keys(SEARCH_CATALOG), ["tavily", "brave", "exa", "parallel"]);
  for (const spec of Object.values(SEARCH_CATALOG)) {
    assert.ok(spec.label && spec.keyVar && spec.url);
  }
});

test("401 → причина отказа", async () => {
  await withFetch(async () => ({ status: 401 }), async () => {
    const reason = await checkSearchKey("tavily", "secret-key");
    assert.equal(typeof reason, "string");
    assert.match(reason, /401/);
  });
});

test("403 → причина отказа", async () => {
  await withFetch(async () => ({ status: 403 }), async () => {
    assert.match(await checkSearchKey("brave", "secret-key"), /403/);
  });
});

test("сетевой сбой → null (мягкая политика: ключ принят)", async () => {
  await withFetch(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    async () => {
      assert.equal(await checkSearchKey("exa", "secret-key"), null);
    },
  );
});

test("200 → null (ключ рабочий)", async () => {
  await withFetch(async () => ({ status: 200 }), async () => {
    assert.equal(await checkSearchKey("parallel", "secret-key"), null);
  });
});

test("неизвестный провайдер → null без сетевого вызова", async () => {
  let called = false;
  await withFetch(
    async () => {
      called = true;
      return { status: 401 };
    },
    async () => {
      assert.equal(await checkSearchKey("bogus", "secret-key"), null);
    },
  );
  assert.equal(called, false);
});

test("проба несёт ключ в запросе, но причина отказа его не разглашает", async () => {
  let seen;
  await withFetch(
    async (url, opts) => {
      seen = { url, opts };
      return { status: 401 };
    },
    async () => {
      const reason = await checkSearchKey("exa", "top-secret-value");
      assert.equal(seen.opts.headers["x-api-key"], "top-secret-value"); // ключ ушёл в заголовок
      assert.doesNotMatch(reason, /top-secret-value/); // но не в текст причины
    },
  );
});
