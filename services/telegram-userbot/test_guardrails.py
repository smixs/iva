"""Runnable self-check for the anti-ban guardrails. No framework: `python test_guardrails.py`.

Covers the two load-bearing behaviors:
  1. FloodWaitError → wait seconds*1.3 then retry once (and the retry's result is returned).
  2. Three FloodWaits in 24h trip the circuit-breaker → further sends raise GuardrailTripped.
"""
import asyncio

from telethon.errors import FloodWaitError

from guardrails import AccountHealth, GuardrailTripped, _wrap, _FLOOD_BUFFER, _MAX_FLOODS_PER_DAY


def _flood(seconds):
    return FloodWaitError(request=None, capture=seconds)


async def _run():
    # 1) FloodWait compliance: wait seconds*1.3, retry once, return retry result.
    slept: list[float] = []

    async def fake_sleep(d):
        slept.append(d)

    calls = {"n": 0}

    async def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise _flood(10)
        return "sent"

    health = AccountHealth()
    wrapped = _wrap(flaky, health, sleep=fake_sleep, rand=lambda a, b: 0.0)
    result = await wrapped("chat", "hi")
    assert result == "sent", result
    assert calls["n"] == 2, "should retry exactly once"
    assert 10 * _FLOOD_BUFFER in slept, f"expected {10*_FLOOD_BUFFER}s flood wait, got {slept}"
    assert health.sends == 1

    # 2) Circuit-breaker: 3 FloodWaits in a fixed 24h window → paused → next send raises.
    h2 = AccountHealth()
    t0 = 1_000_000.0
    for i in range(_MAX_FLOODS_PER_DAY):
        h2.record_flood(now=t0 + i)
    assert h2.should_stop(now=t0 + 100), "3 floods must open the breaker"
    assert not h2.should_stop(now=t0 + 24 * 3600 + 10), "breaker must lift after 24h"

    async def never(*a, **k):
        raise AssertionError("original must not run while breaker is open")

    # Pre-trip a fresh health so the wrapper sees the open breaker (uses real time.time,
    # and paused_until is set far in the future by record_flood at real 'now').
    h3 = AccountHealth()
    for _ in range(_MAX_FLOODS_PER_DAY):
        h3.record_flood()
    tripped = _wrap(never, h3, sleep=fake_sleep, rand=lambda a, b: 0.0)
    try:
        await tripped("chat", "hi")
        raise AssertionError("expected GuardrailTripped")
    except GuardrailTripped:
        pass

    print("test_guardrails: PASS")


if __name__ == "__main__":
    asyncio.run(_run())
