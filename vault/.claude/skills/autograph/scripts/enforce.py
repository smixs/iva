#!/usr/bin/env python3
"""
autograph enforce — validate and fix vault cards against schema.

Usage:
  python3 enforce.py <vault-dir> <schema.json>              # dry run
  python3 enforce.py <vault-dir> <schema.json> --apply       # apply fixes
  python3 enforce.py <vault-dir> <schema.json> --verbose
"""

import json
import sys
from pathlib import Path
from datetime import date
from collections import defaultdict

from common import (
    load_schema, parse_frontmatter, write_frontmatter, format_field,
    walk_vault, rel_path, infer_domain, infer_type, IGNORE_DIRS,
    get_type_aliases, get_field_fixes, get_node_types, get_status_defaults,
    collect_duplicate_groups
)


def enforce(vault_dir: Path, schema: dict, apply=False, verbose=False):
    node_types = schema['node_types']
    type_aliases = get_type_aliases(schema)
    field_fixes = get_field_fixes(schema)
    region_fixes = schema.get('region_fixes', {})

    stats = {
        'total': 0, 'valid': 0, 'fixed': 0, 'needs_review': 0,
        'no_fm': 0, 'fixes': defaultdict(int), 'review_items': []
    }
    for md in walk_vault(vault_dir):
        rp = rel_path(md, vault_dir)
        stats['total'] += 1

        try:
            content = md.read_text(errors='replace')
        except Exception:
            continue

        fields, body, orig_lines = parse_frontmatter(content)
        if fields is None:
            stats['no_fm'] += 1
            continue

        changed = False
        issues = []

        # --- TYPE ---
        t = fields.get('type', '')
        if t in type_aliases:
            fields['type'] = type_aliases[t]
            changed = True
            stats['fixes']['type_alias'] += 1
        t = fields.get('type', '')
        if not t or t not in node_types:
            fields['type'] = infer_type(rp, schema)
            changed = True
            stats['fixes']['type_inferred'] += 1
        t = fields['type']
        tdef = node_types.get(t, {})

        # --- STATUS ---
        valid_s = tdef.get('status', [])
        cur_s = fields.get('status', '')
        # Apply field_fixes for status
        status_fixes = field_fixes.get('status', {})
        if cur_s and cur_s.lower() in status_fixes:
            fields['status'] = status_fixes[cur_s.lower()]
            changed = True
            stats['fixes']['status_fix'] += 1
            cur_s = fields['status']
        # Validate
        if valid_s and cur_s and cur_s not in valid_s:
            # Fall back to first valid status for this type
            fields['status'] = valid_s[0]
            changed = True
            stats['fixes']['status_remap'] += 1
        if not cur_s and valid_s:
            # Use status_defaults from schema, or first valid status
            defaults = get_status_defaults(schema)
            fields['status'] = defaults.get(t, defaults.get('default', valid_s[0]))
            changed = True
            stats['fixes']['status_default'] += 1

        # --- PRIORITY ---
        pri = fields.get('priority', '')
        priority_fixes = field_fixes.get('priority', {})
        if pri and pri.lower() in priority_fixes:
            fields['priority'] = priority_fixes[pri.lower()]
            changed = True
            stats['fixes']['priority_fix'] += 1

        # --- POTENTIAL ---
        pot = fields.get('potential', '')
        potential_fixes = field_fixes.get('potential', {})
        if pot and pot.lower() in potential_fixes:
            fields['potential'] = potential_fixes[pot.lower()]
            changed = True
            stats['fixes']['potential_fix'] += 1

        # --- REGION ---
        reg = fields.get('region', '')
        if isinstance(reg, str) and reg in region_fixes:
            fields['region'] = region_fixes[reg]
            changed = True
            stats['fixes']['region_fix'] += 1

        # --- DOMAIN ---
        if 'domain' not in fields or not fields['domain']:
            fields['domain'] = infer_domain(rp, schema)
            changed = True
            stats['fixes']['domain_add'] += 1

        # --- DESCRIPTION ---
        desc = fields.get('description', '')
        if not desc:
            first = body.strip().split('\n')[0].strip().lstrip('#').strip() if body.strip() else ''
            if first and 10 < len(first) < 200:
                fields['description'] = first
                changed = True
                stats['fixes']['desc_inferred'] += 1
            else:
                issues.append('missing description')
        elif isinstance(desc, str) and len(desc) > 20:
            # Detect duplicated description (processor bug: same text repeated)
            half = len(desc) // 2
            first_half = desc[:half].strip()
            second_half = desc[half:].strip()
            if first_half and first_half == second_half:
                fields['description'] = first_half
                changed = True
                stats['fixes']['desc_dedup'] += 1

        # --- TAGS ---
        tags = fields.get('tags', '')
        if not tags or (isinstance(tags, list) and len(tags) == 0):
            issues.append('missing tags')

        # --- SYSTEM FIELDS ---
        today_str = date.today().isoformat()
        for sf, default in [('last_accessed', today_str), ('tier', 'warm'), ('relevance', 0.5)]:
            if sf not in fields or not fields[sf]:
                fields[sf] = default
                changed = True
                stats['fixes'][f'{sf}_add'] += 1

        # --- WRITE ---
        if changed and apply:
            new_fm = write_frontmatter(fields, orig_lines)
            md.write_text(f"---\n{new_fm}\n---\n{body}")

        if changed:
            stats['fixed'] += 1
        if issues:
            stats['needs_review'] += 1
            if verbose:
                for i in issues:
                    stats['review_items'].append(f"{rp}: {i}")
        if not changed and not issues:
            stats['valid'] += 1

    dupes = collect_duplicate_groups(vault_dir, schema)
    return stats, dupes


def health_score(stats, dupes):
    total = max(stats['total'], 1)
    fm_ok = 1 - stats['no_fm'] / total
    valid_rate = (stats['valid'] + stats['fixed']) / total
    desc_miss = stats['fixes'].get('desc_inferred', 0) + len([r for r in stats.get('review_items', []) if 'description' in r])
    tags_miss = len([r for r in stats.get('review_items', []) if 'tags' in r])
    dup_count = sum(len(p) - 1 for p in dupes.values())

    score = 100.0
    score -= (1 - fm_ok) * 10
    score -= (1 - valid_rate) * 25
    score -= (desc_miss / total) * 20
    score -= (tags_miss / total) * 15
    score -= min(dup_count, 50) * 0.3
    score -= stats['needs_review'] / total * 10
    return max(0, round(score, 1))


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print("Usage: enforce.py <vault-dir> <schema.json> [--apply] [--verbose]", file=sys.stderr)
        sys.exit(1)

    vault_dir = Path(args[0])
    schema_path = Path(args[1])
    apply = '--apply' in args
    verbose = '--verbose' in args

    schema = load_schema(schema_path)
    stats, dupes = enforce(vault_dir, schema, apply=apply, verbose=verbose)
    score = health_score(stats, dupes)

    mode = "APPLIED" if apply else "DRY RUN"
    print(f"\n{'='*55}")
    print(f"  AUTOGRAPH ENFORCE — {mode}")
    print(f"{'='*55}")
    print(f"  Total:          {stats['total']}")
    print(f"  Valid:           {stats['valid']}")
    print(f"  Auto-fixed:      {stats['fixed']}")
    print(f"  Needs review:    {stats['needs_review']}")
    print(f"  No frontmatter:  {stats['no_fm']}")
    print(f"\n  Fixes:")
    for k, v in sorted(stats['fixes'].items(), key=lambda x: -x[1]):
        print(f"    {k}: {v}")
    if dupes:
        dup_total = sum(len(p) - 1 for p in dupes.values())
        print(f"\n  Duplicates: {len(dupes)} slugs ({dup_total} extra files)")
        for (slug, domain, card_type), paths in sorted(dupes.items(), key=lambda x: -len(x[1]))[:15]:
            print(f"    {slug} [{domain}/{card_type}] ({len(paths)}x)")
    if verbose and stats.get('review_items'):
        print(f"\n  Review ({len(stats['review_items'])}):")
        for r in stats['review_items'][:20]:
            print(f"    {r}")

    print(f"\n  {'='*40}")
    print(f"  SCHEMA COMPLIANCE: {score}/100")
    print(f"  {'='*40}")

    out = vault_dir / '.graph' / 'enforce-report.json'
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({
        'score': score, 'total': stats['total'], 'valid': stats['valid'],
        'fixed': stats['fixed'], 'review': stats['needs_review'],
        'duplicates': len(dupes), 'mode': mode,
        'fixes': dict(stats['fixes']),
    }, indent=2))
    print(f"  Report: {out}")


if __name__ == '__main__':
    main()
