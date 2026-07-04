#!/usr/bin/env python3
"""
Spend governor — runtime protection against cost overruns.
Tracks LLM call volume, estimated spend, and detects duplicates.
Runs as an in-process singleton or standalone CLI for monitoring.

Protection targets:
- Retry storms (same prompt sent N times)
- Cron overlap (heartbeat + scheduled job = double processing)
- Cursor bugs (infinite loop hitting LLM)
- Wallet drain attacks (crafted input causing expensive calls)

Usage:
    # Record a call
    python3 spend_governor.py record --caller heartbeat --model sonnet --tokens 5000

    # Check if call is allowed
    python3 spend_governor.py check --caller heartbeat --prompt-hash abc123

    # Show current stats
    python3 spend_governor.py stats

    # Reset counters
    python3 spend_governor.py reset

State file: /tmp/spend-governor-state.json (volatile, resets on reboot)
"""

import sys
import json
import time
import hashlib
import argparse
from pathlib import Path
from typing import NamedTuple


STATE_FILE = Path('/tmp/spend-governor-state.json')

# --- Limits (configurable via env or state file) ---
DEFAULTS = {
    # Spend limits (rolling window)
    'spend_warn_usd': 5.0,        # warn at $5 in window
    'spend_hard_usd': 15.0,       # block at $15 in window
    'spend_window_sec': 300,       # 5 minute window

    # Volume limits (rolling window)
    'volume_global_limit': 200,    # max calls in window
    'volume_window_sec': 600,      # 10 minute window
    'volume_per_caller': {         # per-caller overrides
        'heartbeat': 30,
        'email': 40,
        'scanner': 50,
        'cron': 60,
        'digest': 80,
    },

    # Lifetime limit (per process run)
    'lifetime_limit': 500,

    # Duplicate detection
    'dedup_window_sec': 120,       # cache prompts for 2 minutes
}

# --- Cost estimation per model (input $/1M tokens) ---
MODEL_COSTS = {
    'haiku': 0.80,
    'sonnet': 3.00,
    'opus': 15.00,
    'flash': 0.10,
    'flash-lite': 0.04,
    'gpt-4o': 2.50,
    'gpt-4o-mini': 0.15,
    'o3-mini': 1.10,
}


class GovernorState:
    def __init__(self):
        self.calls = []          # [{ts, caller, model, tokens, cost_usd, prompt_hash}]
        self.lifetime_count = 0
        self.dedup_cache = {}    # {prompt_hash: {ts, response_summary}}
        self.blocked_since = None
        self.config = dict(DEFAULTS)
        self._load()

    def _load(self):
        if STATE_FILE.exists():
            try:
                data = json.loads(STATE_FILE.read_text())
                self.calls = data.get('calls', [])
                self.lifetime_count = data.get('lifetime_count', 0)
                self.dedup_cache = data.get('dedup_cache', {})
                self.blocked_since = data.get('blocked_since')
                if 'config' in data:
                    self.config.update(data['config'])
            except (json.JSONDecodeError, KeyError):
                pass

    def _save(self):
        # Prune old calls (keep last 15 min only)
        cutoff = time.time() - max(
            self.config['spend_window_sec'],
            self.config['volume_window_sec']
        )
        self.calls = [c for c in self.calls if c['ts'] > cutoff]

        # Prune old dedup entries
        dedup_cutoff = time.time() - self.config['dedup_window_sec']
        self.dedup_cache = {
            k: v for k, v in self.dedup_cache.items()
            if v['ts'] > dedup_cutoff
        }

        STATE_FILE.write_text(json.dumps({
            'calls': self.calls,
            'lifetime_count': self.lifetime_count,
            'dedup_cache': self.dedup_cache,
            'blocked_since': self.blocked_since,
            'config': self.config,
        }, indent=2))

    def estimate_cost(self, model: str, tokens: int) -> float:
        model_key = model.lower()
        for key, cost in MODEL_COSTS.items():
            if key in model_key:
                return (tokens / 1_000_000) * cost
        return (tokens / 1_000_000) * 3.0  # default to sonnet pricing

    def get_spend_in_window(self) -> float:
        cutoff = time.time() - self.config['spend_window_sec']
        return sum(c['cost_usd'] for c in self.calls if c['ts'] > cutoff)

    def get_volume_in_window(self, caller: str = None) -> int:
        cutoff = time.time() - self.config['volume_window_sec']
        if caller:
            return sum(1 for c in self.calls if c['ts'] > cutoff and c['caller'] == caller)
        return sum(1 for c in self.calls if c['ts'] > cutoff)

    def check_duplicate(self, prompt_hash: str) -> dict | None:
        if prompt_hash in self.dedup_cache:
            entry = self.dedup_cache[prompt_hash]
            if time.time() - entry['ts'] < self.config['dedup_window_sec']:
                return entry
        return None

    def check(self, caller: str = 'unknown', prompt_hash: str = None,
              model: str = 'sonnet', tokens: int = 1000) -> dict:
        """
        Check if a call should be allowed.
        Returns {allowed, reason, warnings, duplicate}.
        """
        result = {
            'allowed': True,
            'reason': 'ok',
            'warnings': [],
            'duplicate': None,
        }

        # Check cooldown from hard block
        if self.blocked_since:
            cooldown_end = self.blocked_since + self.config['spend_window_sec']
            if time.time() < cooldown_end:
                result['allowed'] = False
                result['reason'] = f"Hard blocked until cooldown ({int(cooldown_end - time.time())}s remaining)"
                return result
            else:
                self.blocked_since = None
                self._save()

        # Lifetime limit
        if self.lifetime_count >= self.config['lifetime_limit']:
            result['allowed'] = False
            result['reason'] = f"Lifetime limit reached: {self.lifetime_count}/{self.config['lifetime_limit']}"
            return result

        # Spend check
        current_spend = self.get_spend_in_window()
        estimated_cost = self.estimate_cost(model, tokens)

        if current_spend + estimated_cost > self.config['spend_hard_usd']:
            result['allowed'] = False
            result['reason'] = (f"Spend hard cap: ${current_spend:.2f} + ${estimated_cost:.4f} "
                               f"> ${self.config['spend_hard_usd']:.2f} "
                               f"(window: {self.config['spend_window_sec']}s)")
            self.blocked_since = time.time()
            self._save()
            return result

        if current_spend > self.config['spend_warn_usd']:
            result['warnings'].append(
                f"Spend warning: ${current_spend:.2f} > ${self.config['spend_warn_usd']:.2f}"
            )

        # Volume check (global)
        global_volume = self.get_volume_in_window()
        if global_volume >= self.config['volume_global_limit']:
            result['allowed'] = False
            result['reason'] = (f"Volume limit: {global_volume}/{self.config['volume_global_limit']} "
                               f"calls in {self.config['volume_window_sec']}s")
            return result

        # Volume check (per-caller)
        caller_limit = self.config['volume_per_caller'].get(caller)
        if caller_limit:
            caller_volume = self.get_volume_in_window(caller)
            if caller_volume >= caller_limit:
                result['allowed'] = False
                result['reason'] = (f"Caller '{caller}' volume limit: "
                                   f"{caller_volume}/{caller_limit}")
                return result

        # Duplicate check
        if prompt_hash:
            dup = self.check_duplicate(prompt_hash)
            if dup:
                result['duplicate'] = dup
                result['warnings'].append(
                    f"Duplicate prompt detected (hash: {prompt_hash[:8]}..., "
                    f"last seen: {int(time.time() - dup['ts'])}s ago)"
                )

        return result

    def record(self, caller: str, model: str, tokens: int,
               prompt_hash: str = None, response_summary: str = None):
        """Record a completed LLM call."""
        cost = self.estimate_cost(model, tokens)
        self.calls.append({
            'ts': time.time(),
            'caller': caller,
            'model': model,
            'tokens': tokens,
            'cost_usd': cost,
            'prompt_hash': prompt_hash or '',
        })
        self.lifetime_count += 1

        if prompt_hash:
            self.dedup_cache[prompt_hash] = {
                'ts': time.time(),
                'response_summary': response_summary or '',
            }

        self._save()

    def get_stats(self) -> dict:
        spend_window = self.config['spend_window_sec']
        volume_window = self.config['volume_window_sec']
        now = time.time()

        spend_cutoff = now - spend_window
        volume_cutoff = now - volume_window

        spend_calls = [c for c in self.calls if c['ts'] > spend_cutoff]
        volume_calls = [c for c in self.calls if c['ts'] > volume_cutoff]

        # Per-caller breakdown
        callers = {}
        for c in volume_calls:
            caller = c['caller']
            if caller not in callers:
                callers[caller] = {'calls': 0, 'cost_usd': 0, 'tokens': 0}
            callers[caller]['calls'] += 1
            callers[caller]['cost_usd'] += c['cost_usd']
            callers[caller]['tokens'] += c['tokens']

        return {
            'spend': {
                'current_usd': sum(c['cost_usd'] for c in spend_calls),
                'warn_usd': self.config['spend_warn_usd'],
                'hard_usd': self.config['spend_hard_usd'],
                'window_sec': spend_window,
                'calls_in_window': len(spend_calls),
            },
            'volume': {
                'current': len(volume_calls),
                'limit': self.config['volume_global_limit'],
                'window_sec': volume_window,
            },
            'lifetime': {
                'count': self.lifetime_count,
                'limit': self.config['lifetime_limit'],
            },
            'dedup_cache_size': len(self.dedup_cache),
            'blocked_since': self.blocked_since,
            'callers': callers,
        }

    def reset(self):
        self.calls = []
        self.lifetime_count = 0
        self.dedup_cache = {}
        self.blocked_since = None
        self._save()


def hash_prompt(text: str) -> str:
    """Create a short hash of a prompt for dedup."""
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def main():
    parser = argparse.ArgumentParser(description='Spend governor for LLM calls')
    sub = parser.add_subparsers(dest='command')

    # check
    p_check = sub.add_parser('check', help='Check if a call is allowed')
    p_check.add_argument('--caller', default='unknown')
    p_check.add_argument('--model', default='sonnet')
    p_check.add_argument('--tokens', type=int, default=1000)
    p_check.add_argument('--prompt-hash', help='Hash of prompt text')
    p_check.add_argument('--prompt', help='Prompt text (will be hashed)')

    # record
    p_record = sub.add_parser('record', help='Record a completed call')
    p_record.add_argument('--caller', required=True)
    p_record.add_argument('--model', required=True)
    p_record.add_argument('--tokens', type=int, required=True)
    p_record.add_argument('--prompt-hash')
    p_record.add_argument('--prompt', help='Prompt text (will be hashed)')

    # stats
    sub.add_parser('stats', help='Show current stats')

    # reset
    sub.add_parser('reset', help='Reset all counters')

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(2)

    gov = GovernorState()

    if args.command == 'check':
        prompt_hash = args.prompt_hash
        if args.prompt:
            prompt_hash = hash_prompt(args.prompt)
        result = gov.check(
            caller=args.caller, model=args.model,
            tokens=args.tokens, prompt_hash=prompt_hash,
        )
        print(json.dumps(result, indent=2))
        sys.exit(0 if result['allowed'] else 1)

    elif args.command == 'record':
        prompt_hash = args.prompt_hash
        if args.prompt:
            prompt_hash = hash_prompt(args.prompt)
        gov.record(
            caller=args.caller, model=args.model,
            tokens=args.tokens, prompt_hash=prompt_hash,
        )
        print(f"✅ Recorded: {args.caller}/{args.model}/{args.tokens} tokens "
              f"(~${gov.estimate_cost(args.model, args.tokens):.4f})")

    elif args.command == 'stats':
        stats = gov.get_stats()
        s = stats['spend']
        v = stats['volume']
        l = stats['lifetime']

        print(f"💰 Spend: ${s['current_usd']:.2f} / ${s['hard_usd']:.2f} "
              f"(warn: ${s['warn_usd']:.2f}) [{s['calls_in_window']} calls in {s['window_sec']}s]")
        print(f"📊 Volume: {v['current']}/{v['limit']} calls in {v['window_sec']}s")
        print(f"🔄 Lifetime: {l['count']}/{l['limit']}")
        print(f"🔍 Dedup cache: {stats['dedup_cache_size']} entries")

        if stats['blocked_since']:
            remaining = stats['blocked_since'] + s['window_sec'] - time.time()
            if remaining > 0:
                print(f"🚫 BLOCKED — cooldown: {int(remaining)}s remaining")

        if stats['callers']:
            print(f"\nPer-caller breakdown:")
            for caller, data in sorted(stats['callers'].items(), key=lambda x: -x[1]['cost_usd']):
                print(f"  {caller}: {data['calls']} calls, "
                      f"${data['cost_usd']:.4f}, {data['tokens']} tokens")

    elif args.command == 'reset':
        gov.reset()
        print("✅ All counters reset")


if __name__ == '__main__':
    main()
