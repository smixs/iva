#!/usr/bin/env python3
"""
autograph engine — decay, touch, creative recall, stats.
All decay config from schema.json. No hardcoded rates or thresholds.

Commands:
  engine.py decay <vault-dir> [schema.json] [--dry-run]
  engine.py touch <filepath> [schema.json]
  engine.py creative <N> <vault-dir> [schema.json]
  engine.py stats <vault-dir> [schema.json]
  engine.py init <vault-dir> [schema.json] [--dry-run]
"""

import sys
import json
import random
from pathlib import Path
from datetime import date
from collections import defaultdict

from common import (
    load_schema, parse_frontmatter, write_frontmatter, walk_vault, rel_path,
    infer_domain, infer_type, calc_relevance, calc_tier, days_since,
    get_decay_config, get_node_types
)


def find_schema(args: list) -> Path | None:
    for a in args:
        if a.endswith('.json') and Path(a).exists():
            return Path(a)
    default = Path(__file__).parent.parent / 'schema.json'
    return default if default.exists() else None


def cmd_decay(vault_dir: Path, schema: dict, dry_run: bool = False):
    """Recalculate relevance and tier for all cards."""
    files = walk_vault(vault_dir)
    updated = 0
    today = date.today()

    for md in files:
        try:
            content = md.read_text(errors='replace')
        except Exception:
            continue

        fm, body, orig_lines = parse_frontmatter(content)
        if fm is None:
            continue

        # Skip core tier
        if fm.get('tier') == 'core':
            continue

        last = fm.get('last_accessed', fm.get('updated', fm.get('created', '')))
        d = days_since(last)

        # Domain-specific rate + access_count
        file_type = fm.get('type', '')
        try:
            access_count = int(fm.get('access_count', 1))
        except (ValueError, TypeError):
            access_count = 1

        new_rel = calc_relevance(d, schema, access_count, file_type)
        new_tier = calc_tier(d, schema, fm.get('tier', ''))

        old_rel = fm.get('relevance', '')
        old_tier = fm.get('tier', '')

        # Check if update needed
        try:
            old_rel_f = float(old_rel) if old_rel else -1
        except (ValueError, TypeError):
            old_rel_f = -1

        if abs(old_rel_f - new_rel) < 0.005 and old_tier == new_tier:
            continue

        fm['relevance'] = new_rel
        fm['tier'] = new_tier
        updated += 1

        if not dry_run:
            new_fm = write_frontmatter(fm, orig_lines)
            md.write_text(f"---\n{new_fm}\n---\n{body}")

    config = get_decay_config(schema)
    mode = "DRY RUN" if dry_run else "APPLIED"
    print(f"\n  decay — {mode}")
    print(f"  Config: rate={config.get('rate')}, floor={config.get('floor')}")
    print(f"  Cards scanned: {len(files)}")
    print(f"  Cards updated: {updated}")


def cmd_touch(filepath: str, schema: dict):
    """Touch card — graduated recall (archive→cold→warm→active) + access_count."""
    from datetime import timedelta
    fp = Path(filepath)
    if not fp.exists():
        print(f"Error: {filepath} not found", file=sys.stderr)
        sys.exit(1)

    content = fp.read_text(errors='replace')
    fm, body, orig_lines = parse_frontmatter(content)
    if fm is None:
        print(f"Error: no frontmatter in {filepath}", file=sys.stderr)
        sys.exit(1)

    # Increment access_count
    try:
        access_count = int(fm.get('access_count', 0)) + 1
    except (ValueError, TypeError):
        access_count = 1
    fm['access_count'] = access_count

    current_tier = fm.get('tier', 'archive')
    config = get_decay_config(schema)
    tiers = config.get('tiers', {'active': 7, 'warm': 21, 'cold': 60})

    if current_tier == 'core':
        # Core: just refresh timestamp
        fm['last_accessed'] = date.today().isoformat()
        fm['relevance'] = 1.0
    elif current_tier in ('active', ''):
        # Already active: refresh
        fm['last_accessed'] = date.today().isoformat()
        fm['relevance'] = 1.0
        fm['tier'] = 'active'
    else:
        # Graduated: promote one tier up
        promotion = {
            'archive': ('cold', (tiers.get('warm', 21) + tiers.get('cold', 60)) // 2),
            'cold': ('warm', (tiers.get('active', 7) + tiers.get('warm', 21)) // 2),
            'warm': ('active', tiers.get('active', 7) // 2),
        }
        new_tier, target_days = promotion.get(current_tier, ('active', 0))
        new_date = date.today() - timedelta(days=target_days)
        fm['last_accessed'] = new_date.isoformat()
        file_type = fm.get('type', '')
        fm['relevance'] = calc_relevance(target_days, schema, access_count, file_type)
        fm['tier'] = new_tier

    new_fm = write_frontmatter(fm, orig_lines)
    fp.write_text(f"---\n{new_fm}\n---\n{body}")
    new_tier = fm.get('tier', current_tier)
    print(f"  touched: {filepath} → {current_tier}→{new_tier}, "
          f"relevance={fm['relevance']}, access_count={access_count}")


def cmd_creative(n: int, vault_dir: Path, schema: dict):
    """Random sample from cold+archive tiers for serendipitous discovery."""
    files = walk_vault(vault_dir)
    cold_archive = []

    for md in files:
        try:
            content = md.read_text(errors='replace')
        except Exception:
            continue
        fm, _, _ = parse_frontmatter(content)
        if fm is None:
            continue
        tier = fm.get('tier', '')
        if tier in ('cold', 'archive'):
            desc = fm.get('description', md.stem.replace('-', ' '))
            cold_archive.append((rel_path(md, vault_dir), desc, tier))

    if not cold_archive:
        print("No cold/archive cards found.")
        return

    sample = random.sample(cold_archive, min(n, len(cold_archive)))
    print(f"\n  creative recall — {len(sample)} cards from {len(cold_archive)} cold/archive")
    print()
    for rp, desc, tier in sample:
        desc_short = desc[:80] if isinstance(desc, str) else str(desc)[:80]
        print(f"  [{tier}] {rp}")
        print(f"         {desc_short}")
        print()


def cmd_stats(vault_dir: Path, schema: dict):
    """Show tier distribution and context budget."""
    files = walk_vault(vault_dir)
    tiers = defaultdict(int)
    total_size = 0
    active_size = 0
    no_fm = 0
    stale_90 = 0

    for md in files:
        try:
            content = md.read_text(errors='replace')
            total_size += len(content)
        except Exception:
            continue
        fm, _, _ = parse_frontmatter(content)
        if fm is None:
            no_fm += 1
            tiers['unknown'] += 1
            continue
        tier = fm.get('tier', 'unknown')
        tiers[tier] += 1
        if tier in ('active', 'warm'):
            active_size += len(content)
        last = fm.get('last_accessed', '')
        if days_since(last) > 90:
            stale_90 += 1

    total = len(files)
    config = get_decay_config(schema)

    print(f"\n  memory health — {vault_dir}")
    print(f"  {'─'*40}")
    print(f"  total cards:       {total}")
    print(f"  total size:        {total_size // 1024} KB")
    print(f"  without yaml:      {no_fm}")
    print(f"  stale (>90 days):  {stale_90}")
    print(f"  decay rate:        {config.get('rate', '?')}/day")
    print(f"  {'─'*40}")
    print(f"  tier distribution:")

    tier_order = ['core', 'active', 'warm', 'cold', 'archive', 'unknown']
    max_bar = 50
    for t in tier_order:
        count = tiers.get(t, 0)
        if count == 0:
            continue
        pct = count / max(total, 1) * 100
        bar_len = int(pct / 100 * max_bar)
        bar = '█' * bar_len
        print(f"    {t:<8}: {count:>4} ({pct:>4.1f}%) {bar}")

    print(f"  {'─'*40}")
    print(f"  active context:    {active_size // 1024} KB (~{active_size // 4:,} tokens)")
    print(f"  total context:     {total_size // 1024} KB (~{total_size // 4:,} tokens)")


def cmd_init(vault_dir: Path, schema: dict, dry_run: bool = False):
    """Bootstrap frontmatter on files missing it."""
    files = walk_vault(vault_dir)
    added = 0

    for md in files:
        try:
            content = md.read_text(errors='replace')
        except Exception:
            continue
        fm, body, _ = parse_frontmatter(content)
        if fm is not None:
            continue  # already has frontmatter

        rp = rel_path(md, vault_dir)
        card_type = infer_type(rp, schema)
        domain = infer_domain(rp, schema)
        today = date.today().isoformat()

        new_fm = f"---\ntype: {card_type}\ndomain: {domain}\ntier: warm\nrelevance: 0.5\nlast_accessed: {today}\n---\n"

        if not dry_run:
            md.write_text(new_fm + content)
        added += 1

    mode = "DRY RUN" if dry_run else "APPLIED"
    print(f"\n  init — {mode}")
    print(f"  Files without frontmatter: {added}")
    if added and not dry_run:
        print(f"  Added minimal frontmatter to {added} files")


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print(__doc__)
        sys.exit(0)

    cmd = args[0]
    schema_path = find_schema(args)
    schema = load_schema(schema_path) if schema_path else {}

    if cmd == 'decay':
        vault_dir = Path(args[1]) if len(args) > 1 else None
        if not vault_dir:
            print("Usage: engine.py decay <vault-dir>", file=sys.stderr)
            sys.exit(1)
        cmd_decay(vault_dir, schema, dry_run='--dry-run' in args)

    elif cmd == 'touch':
        filepath = args[1] if len(args) > 1 else None
        if not filepath:
            print("Usage: engine.py touch <filepath>", file=sys.stderr)
            sys.exit(1)
        cmd_touch(filepath, schema)

    elif cmd == 'creative':
        n = int(args[1]) if len(args) > 1 else 5
        vault_dir = Path(args[2]) if len(args) > 2 else None
        if not vault_dir:
            print("Usage: engine.py creative <N> <vault-dir>", file=sys.stderr)
            sys.exit(1)
        cmd_creative(n, vault_dir, schema)

    elif cmd == 'stats':
        vault_dir = Path(args[1]) if len(args) > 1 else None
        if not vault_dir:
            print("Usage: engine.py stats <vault-dir>", file=sys.stderr)
            sys.exit(1)
        cmd_stats(vault_dir, schema)

    elif cmd == 'init':
        vault_dir = Path(args[1]) if len(args) > 1 else None
        if not vault_dir:
            print("Usage: engine.py init <vault-dir>", file=sys.stderr)
            sys.exit(1)
        cmd_init(vault_dir, schema, dry_run='--dry-run' in args)

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
