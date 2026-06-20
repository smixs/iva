#!/usr/bin/env python3
"""
autograph graph — vault graph analysis, link repair, backlinks, orphans.

Commands:
  graph.py health <vault-dir> [schema.json]        — health score + report
  graph.py fix <vault-dir> [schema.json] [--apply]  — fix broken links
  graph.py backlinks <vault-dir> <target>           — incoming links
  graph.py orphans <vault-dir>                      — files with no incoming links

All domain/type logic from schema.json. No hardcoded values.
"""

import json
import re
import sys
from pathlib import Path
from datetime import datetime
from collections import defaultdict

from common import (
    load_schema, parse_frontmatter, walk_vault, rel_path,
    extract_wikilinks, infer_domain, get_domain_map, IGNORE_DIRS,
    build_link_index, normalize_link_target, resolve_link_target, is_hub_path
)

EMBED_EXTS = {'.jpg', '.jpeg', '.png', '.gif', '.svg', '.pdf', '.mp3', '.mp4', '.webp'}


def build_graph(vault_dir: Path, schema: dict) -> dict:
    """Scan vault, build full graph structure."""
    vault_dir = Path(vault_dir)
    files = walk_vault(vault_dir)

    link_index = build_link_index(vault_dir, files)

    nodes = {}
    all_links = []      # (source, raw_target, resolved_target)
    broken_links = []   # (source, raw_target)

    for md in files:
        rp = rel_path(md, vault_dir)
        rp_noext = rp.replace('.md', '')
        try:
            content = md.read_text(errors='replace')
        except Exception:
            continue

        fm, body, _ = parse_frontmatter(content)
        if fm is None:
            fm = {}

        domain = infer_domain(rp, schema)
        has_desc = bool(fm.get('description', ''))
        card_type = fm.get('type', 'unknown')

        outgoing = []
        links = extract_wikilinks(body if body else content)
        for target, display in links:
            # Skip embeds
            if any(target.lower().endswith(ext) for ext in EMBED_EXTS):
                continue
            target_clean = normalize_link_target(target)
            resolved, _ = resolve_link_target(target_clean, link_index)
            if resolved:
                outgoing.append(resolved)
                all_links.append((rp_noext, target_clean, resolved))
            else:
                broken_links.append((rp_noext, target_clean))

        nodes[rp_noext] = {
            'domain': domain,
            'type': card_type,
            'has_description': has_desc,
            'outgoing': outgoing,
            'incoming': [],  # filled below
            'link_count': len(outgoing),
        }

    # Build incoming links
    for src, raw, resolved in all_links:
        if resolved in nodes:
            nodes[resolved]['incoming'].append(src)

    # Compute stats
    total = len(nodes)
    total_links = len(all_links)
    avg_links = total_links / max(total, 1)

    orphans = [p for p, n in nodes.items() if not n['incoming'] and not is_hub_path(p)]
    dead_ends = [p for p, n in nodes.items() if not n['outgoing'] and n['incoming']]
    desc_count = sum(1 for n in nodes.values() if n['has_description'])
    desc_ratio = desc_count / max(total, 1)

    orphan_ratio = len(orphans) / max(total, 1)
    broken_ratio = len(broken_links) / max(total, 1)

    health = 100.0
    health -= orphan_ratio * 30
    health -= broken_ratio * 30
    health -= max(0, (3 - avg_links) * 15)
    health -= (1 - desc_ratio) * 10
    health = max(0, round(health, 1))

    # Domain stats + non-standard domain detection
    valid_domains = set(get_domain_map(schema).values()) if schema else set()
    domain_stats = defaultdict(lambda: {'files': 0, 'links': 0, 'orphans': 0})
    nonstandard_domains = defaultdict(list)  # domain -> [file_paths]
    for path, node in nodes.items():
        d = node['domain']
        domain_stats[d]['files'] += 1
        domain_stats[d]['links'] += node['link_count']
        if valid_domains and d not in valid_domains:
            nonstandard_domains[d].append(path)
    for o in orphans:
        if o in nodes:
            domain_stats[nodes[o]['domain']]['orphans'] += 1

    nonstandard_count = sum(len(v) for v in nonstandard_domains.values())
    nonstandard_ratio = nonstandard_count / max(total, 1)
    health -= nonstandard_ratio * 5  # small penalty for domain inconsistency
    health = max(0, round(health, 1))

    return {
        'generated': datetime.now().isoformat(),
        'stats': {
            'total_files': total,
            'total_links': total_links,
            'avg_links': round(avg_links, 2),
            'orphans': len(orphans),
            'dead_ends': len(dead_ends),
            'broken_links': len(broken_links),
            'desc_coverage': round(desc_ratio * 100, 1),
            'nonstandard_domains': nonstandard_count,
            'health_score': health,
        },
        'domains': dict(domain_stats),
        'nonstandard_domain_list': {k: v[:10] for k, v in nonstandard_domains.items()},
        'orphan_list': sorted(orphans),
        'dead_end_list': sorted(dead_ends),
        'broken_link_list': [{'source': s, 'target': t} for s, t in broken_links],
        'nodes': {k: {'domain': v['domain'], 'type': v['type'], 'has_description': v['has_description'],
                       'outgoing': v['outgoing'], 'incoming': v['incoming']}
                  for k, v in nodes.items()},
    }


def resolve_link(target: str, path_index: dict) -> str | None:
    """Backward-compatible wrapper around deterministic resolver."""
    if 'exact' in path_index and 'unique_stem' in path_index:
        return resolve_link_target(target, path_index)[0]

    target = normalize_link_target(target)
    if not target:
        return None
    if target in path_index:
        return path_index[target]
    stem = target.split('/')[-1]
    if stem in path_index:
        return path_index[stem]
    return None


def generate_report(stats: dict, domains: dict) -> str:
    """Generate markdown health report."""
    s = stats
    lines = [
        f"# Vault Health Report",
        f"",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Health Score | **{s['health_score']}/100** |",
        f"| Total files | {s['total_files']} |",
        f"| Total links | {s['total_links']} |",
        f"| Avg links/file | {s['avg_links']} |",
        f"| Orphans | {s['orphans']} |",
        f"| Dead-ends | {s['dead_ends']} |",
        f"| Broken links | {s['broken_links']} |",
        f"| Desc coverage | {s['desc_coverage']}% |",
        f"",
        f"## Domains",
        f"",
    ]
    for domain, ds in sorted(domains.items()):
        lines.append(f"- **{domain}**: {ds['files']} files, {ds['links']} links, {ds['orphans']} orphans")
    return '\n'.join(lines)


def update_history(vault_dir: Path, stats: dict):
    """Append to health-history.json (max 90 entries)."""
    hist_path = vault_dir / '.graph' / 'health-history.json'
    history = []
    if hist_path.exists():
        try:
            history = json.loads(hist_path.read_text())
        except Exception:
            history = []
    history.append({
        'date': datetime.now().strftime('%Y-%m-%d'),
        **stats
    })
    history = history[-90:]  # keep last 90
    hist_path.write_text(json.dumps(history, indent=2))


# ─── FIX BROKEN LINKS ─────────────────────────────────────
def fix_broken_links(vault_dir: Path, graph: dict, apply: bool = False) -> list:
    """Suggest and optionally apply fixes for broken links."""
    link_index = build_link_index(vault_dir)

    fixes = []
    for bl in graph['broken_link_list']:
        src = bl['source']
        target = bl['target']
        resolved, strategy = resolve_link_target(target, link_index)
        if resolved and strategy in ('unique_suffix', 'unique_stem'):
            fixes.append({
                'source': src,
                'old': target,
                'new': resolved,
                'strategy': strategy
            })

    if apply:
        applied = 0
        for fix in fixes:
            src_path = vault_dir / (fix['source'] + '.md')
            if not src_path.exists():
                continue
            content = src_path.read_text(errors='replace')
            pattern = re.compile(
                r'\[\[' + re.escape(normalize_link_target(fix['old'])) + r'(?P<anchor>#[^\]|]+)?(?P<alias>\|[^\]]+)?\]\]'
            )
            if pattern.search(content):
                content = pattern.sub(
                    lambda m: f"[[{fix['new']}{m.group('anchor') or ''}{m.group('alias') or ''}]]",
                    content
                )
                src_path.write_text(content)
                applied += 1
        return fixes, applied
    return fixes, 0


# ─── BACKLINKS ─────────────────────────────────────────────
def find_text_mentions(vault_dir: Path, target: str, wikilink_sources: set) -> list:
    """Find plain-text mentions of target stem (not wikilinks) in vault files."""
    stem = target.replace('.md', '').split('/')[-1]
    # Build search variants: stem as-is and with spaces instead of hyphens
    variants = {stem.lower()}
    if '-' in stem:
        variants.add(stem.replace('-', ' ').lower())
        # Also add concatenated form: "foobar" from "foo-bar"
        variants.add(stem.replace('-', '').lower())

    mentions = []
    wikilink_pat = re.compile(r'\[\[[^\]]*\]\]')

    for md in walk_vault(vault_dir):
        rp = rel_path(md, vault_dir).replace('.md', '')
        if rp in wikilink_sources or rp == target.replace('.md', ''):
            continue  # skip files already found via wikilinks
        try:
            content = md.read_text(errors='replace').lower()
        except Exception:
            continue
        # Strip wikilinks so we only find plain-text mentions
        content_no_wl = wikilink_pat.sub('', content)
        for v in variants:
            if v in content_no_wl:
                mentions.append(rp)
                break

    return sorted(set(mentions))


def find_backlinks(graph: dict, target: str, vault_dir: Path = None) -> tuple[list, list]:
    """Find all files linking to target.
    Returns: (wikilink_backlinks, text_mentions) if vault_dir given,
             else (wikilink_backlinks, []) for backward compat."""
    # Normalize target
    target_clean = target.replace('.md', '')
    results = []

    if target_clean in graph['nodes']:
        for src in graph['nodes'][target_clean].get('incoming', []):
            results.append(src)
    else:
        # Fuzzy: check if target is a stem
        stem = target_clean.split('/')[-1]
        for path, node in graph['nodes'].items():
            if path.endswith(stem):
                for src in node.get('incoming', []):
                    results.append(src)

    wikilinks = sorted(set(results))

    # Text mentions (optional, needs vault_dir)
    text_mentions = []
    if vault_dir:
        text_mentions = find_text_mentions(vault_dir, target_clean, set(wikilinks))

    return wikilinks, text_mentions


# ─── CLI ───────────────────────────────────────────────────
def find_schema(args: list) -> Path | None:
    """Find schema.json in args or default location."""
    for a in args:
        if a.endswith('.json') and Path(a).exists():
            return Path(a)
    default = Path(__file__).parent.parent / 'schema.json'
    if default.exists():
        return default
    return None


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print(__doc__)
        sys.exit(0)

    cmd = args[0]
    vault_dir = Path(args[1]) if len(args) > 1 else None

    if not vault_dir or not vault_dir.is_dir():
        print(f"Error: vault directory required", file=sys.stderr)
        sys.exit(1)

    schema_path = find_schema(args)
    schema = load_schema(schema_path) if schema_path else {}

    if cmd == 'health':
        graph = build_graph(vault_dir, schema)
        stats = graph['stats']

        # Save outputs
        out_dir = vault_dir / '.graph'
        out_dir.mkdir(exist_ok=True)
        (out_dir / 'vault-graph.json').write_text(
            json.dumps(graph, indent=2, ensure_ascii=False, default=str))
        (out_dir / 'report.md').write_text(
            generate_report(stats, graph['domains']))
        update_history(vault_dir, stats)

        print(f"\n{'='*50}")
        print(f"Health Score:     {stats['health_score']}/100")
        print(f"Total files:      {stats['total_files']}")
        print(f"Total links:      {stats['total_links']}")
        print(f"Avg links/file:   {stats['avg_links']}")
        print(f"Orphan files:     {stats['orphans']}")
        print(f"Dead-ends:        {stats['dead_ends']}")
        print(f"Broken links:     {stats['broken_links']}")
        print(f"Desc coverage:    {stats['desc_coverage']}%")
        ns_count = stats.get('nonstandard_domains', 0)
        if ns_count > 0:
            print(f"Bad domains:      {ns_count}")
        print(f"{'='*50}")
        for d, ds in sorted(graph['domains'].items()):
            print(f"  {d}: {ds['files']} files, {ds['links']} links, {ds['orphans']} orphans")
        ns_list = graph.get('nonstandard_domain_list', {})
        if ns_list:
            print(f"\n  Non-standard domains ({ns_count} files):")
            for domain, files in sorted(ns_list.items()):
                print(f"    '{domain}' ({len(files)} files): {', '.join(files[:5])}")

    elif cmd == 'fix':
        graph = build_graph(vault_dir, schema)
        apply = '--apply' in args
        fixes, applied = fix_broken_links(vault_dir, graph, apply=apply)
        mode = 'APPLIED' if apply else 'DRY RUN'
        print(f"\n  Broken links: {len(graph['broken_link_list'])}")
        print(f"  Fixable:      {len(fixes)}")
        if apply:
            print(f"  Applied:      {applied}")
        for f in fixes[:20]:
            print(f"    {f['source']}: {f['old']} → {f['new']}")

    elif cmd == 'backlinks':
        target = args[2] if len(args) > 2 else None
        if not target:
            print("Usage: graph.py backlinks <vault> <target>", file=sys.stderr)
            sys.exit(1)
        graph = build_graph(vault_dir, schema)
        wikilinks, mentions = find_backlinks(graph, target, vault_dir)
        print(f"Backlinks to '{target}': {len(wikilinks)} wikilinks, {len(mentions)} text mentions")
        if wikilinks:
            print(f"\n  Wikilinks ({len(wikilinks)}):")
            for b in wikilinks:
                print(f"    ← {b}")
        if mentions:
            print(f"\n  Text mentions ({len(mentions)}):")
            for m in mentions:
                print(f"    ~ {m}")

    elif cmd == 'orphans':
        graph = build_graph(vault_dir, schema)
        orphans = graph['orphan_list']
        print(f"Orphans: {len(orphans)}")
        for o in orphans:
            print(f"  {o}")

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
