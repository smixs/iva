import test from "node:test";
import assert from "node:assert/strict";
import { humanizeProviderError } from "./error-humanizer.ts";

const REAL_LIMIT_ERROR =
  "AI_RetryError: Failed after 3 attempts. Last error: AI_APICallError: 5-hour usage limit reached. Resets in 3hr 59min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_.../go";
const REAL_UPSTREAM_ERROR =
  "AI_APICallError: Error from provider (Console Go): Upstream request failed";

test("humanizes the production usage-limit error and preserves its reset interval", () => {
  assert.deepEqual(humanizeProviderError({ message: REAL_LIMIT_ERROR }), {
    en: "Provider limit exhausted - resets in 3hr 59min; wait or switch models: /model",
    ru: "Лимит провайдера исчерпан - сброс через 3hr 59min; подожди или смени модель: /model",
  });
});

test("humanizes the production upstream failure", () => {
  assert.deepEqual(humanizeProviderError({ message: REAL_UPSTREAM_ERROR }), {
    en: "Provider-side failure - try again in a couple of minutes",
    ru: "Сбой на стороне провайдера - попробуй через пару минут",
  });
});

test("recognizes limits from prose, structured statusCode details and reset text", () => {
  assert.equal(
    humanizeProviderError({
      message: "Request rejected",
      details: { statusCode: 429, upstreamMessage: "Rate limit. Resets in 12 min" },
    }).ru,
    "Лимит провайдера исчерпан - сброс через 12 min; подожди или смени модель: /model",
  );
  assert.equal(
    humanizeProviderError({ message: "rate_limit_exceeded" }).en,
    "Provider limit exhausted - wait or switch models: /model",
  );
});

test("recognizes exhausted balance or plan", () => {
  for (const input of [
    { message: "insufficient credits" },
    { message: "Account billing is inactive" },
    { message: "Request failed", details: { statusCode: 402 } },
  ]) {
    assert.deepEqual(humanizeProviderError(input), {
      en: "Provider balance/plan exhausted - top up or switch models: /model",
      ru: "Баланс/тариф провайдера исчерпан - пополни или смени модель: /model",
    });
  }
});

test("recognizes invalid provider credentials", () => {
  for (const input of [
    { message: "Invalid API key" },
    { message: "Unauthorized" },
    { message: "Request rejected", details: '{"statusCode":403}' },
  ]) {
    assert.deepEqual(humanizeProviderError(input), {
      en: "Provider key does not work - check it in /menu",
      ru: "Ключ провайдера не работает - проверь его в /menu",
    });
  }
});

test("recognizes provider-side failures", () => {
  for (const input of [
    { message: "The service is overloaded" },
    { message: "Internal Server Error" },
    { message: "Provider returned a 5xx response" },
    { message: "Request failed", details: { upstreamStatusCode: 503 } },
  ]) {
    assert.deepEqual(humanizeProviderError(input), {
      en: "Provider-side failure - try again in a couple of minutes",
      ru: "Сбой на стороне провайдера - попробуй через пару минут",
    });
  }
});

test("recognizes provider transport and timeout failures", () => {
  for (const message of [
    "Request timeout",
    "read ECONNRESET",
    "connect ETIMEDOUT",
    "TypeError: fetch failed",
    "The response stream was aborted",
  ]) {
    assert.deepEqual(humanizeProviderError({ message }), {
      en: "Provider is not responding - try again later",
      ru: "Провайдер не отвечает - попробуй позже",
    });
  }
});

test("uses the former generic text only for context-overflow errors", () => {
  for (const message of [
    "context length exceeded",
    "too many tokens in prompt",
    "maximum context window reached",
  ]) {
    assert.deepEqual(humanizeProviderError({ message }), {
      en: "The turn failed (the context may have overflowed). Commands: /new — start over, /restart — restart.",
      ru: "Ход не удался (возможно, переполнился контекст). Команды: /new — начать заново, /restart — перезапустить.",
    });
  }
});

test("strips the retry wrapper before building the default gist", () => {
  assert.deepEqual(
    humanizeProviderError({
      message:
        "AI_RetryError: Failed after 2 attempts. Last error: Provider returned a strange response",
    }),
    {
      en: "Turn failed: Provider returned a strange response",
      ru: "Ход упал: Provider returned a strange response",
    },
  );
});

test("masks the configured Telegram bot token in a default gist", () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "123456:secret-token";
  try {
    const result = humanizeProviderError({
      message: "Request URL https://api.telegram.org/bot123456:secret-token/getMe failed",
    });
    assert.equal(
      result.ru,
      "Ход упал: Request URL https://api.telegram.org/bot***/getMe failed",
    );
    assert.equal(result.ru.includes("123456:secret-token"), false);
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});

test("keeps only the first line and truncates the default gist to about 120 characters", () => {
  const longLine = `Unexpected provider response ${"x".repeat(180)}`;
  const result = humanizeProviderError({
    message: `${longLine}\nsecret diagnostic second line`,
    details: { diagnostic: "must not be shown" },
  });
  const gist = result.en.slice("Turn failed: ".length);

  assert.equal(gist.length, 120);
  assert.equal(gist.endsWith("…"), true);
  assert.equal(result.en.includes("second line"), false);
  assert.equal(result.en.includes("must not be shown"), false);
});
