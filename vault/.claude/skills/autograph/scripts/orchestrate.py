#!/usr/bin/env python3
"""
autograph orchestrate — multi-agent workflow orchestration.

Phase 0 commands (script sequencing, no LLM):
  orchestrate.py health <vault-dir>
  orchestrate.py bootstrap <vault-dir>

Data prep commands (builds input for Claude Code agent judgment):
  orchestrate.py dedup-prepare <vault-dir>
  orchestrate.py link-prepare <vault-dir>
  orchestrate.py graph-prepare <vault-dir>

All judgment calls are made by the Claude Code agent directly —
no API keys, no external LLM calls. The prep commands build
structured JSON that the agent reads, reviews, and acts on.
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
import subprocess

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import parse_frontmatter, load_schema, extract_wikilinks
from enrich import scan_vault_for_links, format_catalog, chunk_list

SCRIPTS_DIR = Path(__file__).resolve().parent


# ─── SCRIPT RUNNER ───────────────────────────────────────

def run_script(name: str, *args) -> tuple[int, str]:
    script = str(SCRIPTS_DIR / name)
    cmd = ["python3", script] + list(args)
    print(f"  > {name} {' '.join(args)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    output = result.stdout + result.stderr
    if result.returncode != 0:
        print(f"    FAIL (exit {result.returncode})")
        for line in output.strip().split('\n')[-5:]:
            print(f"    {line}")
    return result.returncode, output


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


# ═══════════════════════════════════════════════════════════
# PHASE 0: HEALTH
# ═══════════════════════════════════════════════════════════

def cmd_health(vault_dir: Path):
    vd = str(vault_dir)
    print(f"\n{'='*55}")
    print(f"  AUTOGRAPH HEALTH — {vault_dir.name}")
    print(f"{'='*55}")

    print("\n[1/5] Health check...")
    run_script('graph.py', 'health', vd)
    graph = read_json(vault_dir / '.graph' / 'vault-graph.json')
    score = graph.get('stats', {}).get('health_score', 0)
    broken = graph.get('stats', {}).get('broken_links', 0)
    orphans = graph.get('stats', {}).get('orphans', 0)
    print(f"    Score: {score}/100  broken: {broken}  orphans: {orphans}")

    if broken > 0:
        print(f"\n[2/5] Fixing {broken} broken links...")
        run_script('graph.py', 'fix', vd, '--apply')
    else:
        print("\n[2/5] No broken links.")

    print("\n[3/5] Link cleanup...")
    run_script('link_cleanup.py', vd, '--apply')

    print("\n[4/5] MOC generation + decay...")
    run_script('moc.py', 'generate', vd)
    run_script('engine.py', 'decay', vd)

    print("\n[5/5] Final health check...")
    run_script('graph.py', 'health', vd)
    graph2 = read_json(vault_dir / '.graph' / 'vault-graph.json')
    final = graph2.get('stats', {}).get('health_score', 0)
    delta = final - score

    print(f"\n  Result: {score} -> {final} ({'+' if delta >= 0 else ''}{delta})")
    print(f"  Status: {'HEALTHY' if final >= 90 else 'NEEDS ATTENTION'}")


# ═══════════════════════════════════════════════════════════
# PHASE 0: BOOTSTRAP
# ═══════════════════════════════════════════════════════════

def cmd_bootstrap(vault_dir: Path):
    vd = str(vault_dir)
    print(f"\n{'='*55}")
    print(f"  AUTOGRAPH BOOTSTRAP — {vault_dir.name}")
    print(f"{'='*55}")

    steps = [
        ("Enforce",        'enforce.py',      [vd, '--apply']),
        ("Link cleanup",   'link_cleanup.py',  [vd, '--apply']),
        ("Tag enrichment", 'enrich.py',        ['tags', vd, '--apply']),
        ("Dedup (scan)",   'dedup.py',         [vd, '--manifest',
                                                str(vault_dir / '.graph' / 'dedup-manifest.json')]),
    ]

    for i, (label, script, args) in enumerate(steps, 1):
        print(f"\n[{i}/7] {label}...")
        rc, _ = run_script(script, *args)
        if rc != 0 and 'Dedup' not in label:
            print(f"  ABORT: {label} failed")
            return

    manifest = read_json(vault_dir / '.graph' / 'dedup-manifest.json')
    clusters = manifest.get('clusters', [])
    if clusters:
        print(f"\n[5/7] Preparing dedup review ({len(clusters)} clusters)...")
        cmd_dedup_prepare(vault_dir)
        print(f"    >> Agent: review .graph/dedup-review-input.json and approve/reject clusters")
    else:
        print(f"\n[5/7] No duplicates.")

    print(f"\n[6/7] Link enrichment (swarm-links)...")
    run_script('enrich.py', 'swarm-links', vd, '--apply')

    print(f"\n[7/7] MOC + final health...")
    run_script('moc.py', 'generate', vd)
    run_script('graph.py', 'health', vd)
    graph = read_json(vault_dir / '.graph' / 'vault-graph.json')
    score = graph.get('stats', {}).get('health_score', 0)
    print(f"\n  Final health: {score}/100")


# ═══════════════════════════════════════════════════════════
# PHASE 1: DEDUP PREPARE (data for agent judgment)
# ═══════════════════════════════════════════════════════════

def cmd_dedup_prepare(vault_dir: Path):
    """Build enriched dedup manifest for agent review.

    Reads dedup manifest, adds content previews for each file,
    writes .graph/dedup-review-input.json.
    The agent reads this file, reviews clusters, and writes
    decisions to the manifest's 'approved' field.
    """
    manifest_path = vault_dir / '.graph' / 'dedup-manifest.json'

    if not manifest_path.exists():
        print("  Generating dedup manifest...")
        run_script('dedup.py', str(vault_dir), '--manifest', str(manifest_path))

    manifest = read_json(manifest_path)
    clusters = manifest.get('clusters', [])
    if not clusters:
        print("  No dedup clusters.")
        return

    enriched_clusters = []
    for cluster in clusters:
        previews = {}
        all_paths = [cluster.get('canonical', '')] + list(cluster.get('extras', []))
        for path in all_paths:
            if not path:
                continue
            full = vault_dir / path
            if not full.exists():
                continue
            content = full.read_text(errors='replace')
            fm, body, _ = parse_frontmatter(content)
            previews[path] = {
                'frontmatter': {k: v for k, v in (fm or {}).items()
                               if k in ('description', 'tags', 'status', 'type',
                                        'domain', 'source', 'potential', 'priority')},
                'body_preview': (body or '')[:500].strip(),
            }
        enriched_clusters.append({
            'id': cluster.get('id', ''),
            'action': cluster.get('action', ''),
            'risk': cluster.get('risk', ''),
            'reason': cluster.get('reason', ''),
            'canonical': cluster.get('canonical', ''),
            'extras': cluster.get('extras', []),
            'records': [{'stem': r.get('stem'), 'kind': r.get('kind'),
                         'richness': r.get('richness'), 'title': r.get('title'),
                         'status': r.get('status')} for r in cluster.get('records', [])],
            'previews': previews,
        })

    output = {
        'generated_at': datetime.now().isoformat(),
        'vault': str(vault_dir),
        'cluster_count': len(enriched_clusters),
        'clusters': enriched_clusters,
        'instructions': (
            'Review each cluster. For each, decide: merge_duplicate (safe) or manual_hold (ambiguous). '
            'Set "approved": true on safe merges. Then run: '
            'python3 dedup.py <vault> --apply-manifest <this-file>'
        ),
    }

    out_path = vault_dir / '.graph' / 'dedup-review-input.json'
    out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False) + '\n')
    print(f"  {len(enriched_clusters)} clusters prepared: {out_path}")


# ═══════════════════════════════════════════════════════════
# PHASE 2: LINK PREPARE (data for agent judgment)
# ═══════════════════════════════════════════════════════════

def cmd_link_prepare(vault_dir: Path, force: bool = False):
    """Build per-domain catalogs and file lists for agent link suggestions.

    Writes .graph/link-review-input.json with domain catalogs and
    files needing links. The agent reads this, suggests links per
    domain, and writes results to .graph/enrich/specialists/.
    """
    vault_dir = vault_dir.resolve()
    all_stems, stem_to_path, catalog, entries = scan_vault_for_links(vault_dir, force)

    print(f"  Stems: {len(all_stems)}  Domains: {len(catalog)}  Needing links: {len(entries)}")
    if not entries:
        print("  Nothing to do.")
        return

    domain_data = {}
    for e in entries:
        d = e.get('domain', '') or 'general'
        domain_data.setdefault(d, {'files': [], 'catalog': ''})
        domain_data[d]['files'].append({
            'path': e['path'],
            'type': e.get('type', ''),
            'tags': e.get('tags', [])[:10],
            'existing_links': e.get('existing_links', []),
            'summary': e.get('summary', '')[:400],
        })

    for domain in domain_data:
        domain_catalog = catalog.get(domain, [])
        cross = []
        for other_d, other_e in catalog.items():
            if other_d != domain:
                cross.extend(other_e[:30])
        domain_data[domain]['catalog'] = format_catalog(domain_catalog + cross)

    output = {
        'generated_at': datetime.now().isoformat(),
        'vault': str(vault_dir),
        'all_stems': sorted(all_stems),
        'stem_to_path': stem_to_path,
        'domains': {d: {'file_count': len(v['files']), 'catalog_lines': v['catalog'].count('\n') + 1}
                    for d, v in domain_data.items()},
        'domain_data': domain_data,
        'instructions': (
            'For each domain, review files and suggest 3-8 links from the catalog. '
            'ONLY use stems from all_stems. No self-links, no existing links. '
            'Write results as batch-NNN-results.json to .graph/enrich/specialists/. '
            'Then run: python3 enrich.py swarm-links <vault> --apply '
            'to apply from that directory.'
        ),
    }

    out_path = vault_dir / '.graph' / 'link-review-input.json'
    out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False) + '\n')
    print(f"  {len(domain_data)} domains, {len(entries)} files prepared: {out_path}")


# ═══════════════════════════════════════════════════════════
# PHASE 3: GRAPH PREPARE (data for agent analysis)
# ═══════════════════════════════════════════════════════════

def cmd_graph_prepare(vault_dir: Path):
    """Build graph analysis input for agent semantic review.

    Runs graph.py health, then builds a concise summary of the graph
    for the agent to analyze: domain distributions, orphans, broken
    links, sample nodes.
    """
    vault_dir = vault_dir.resolve()

    print("  Running health check...")
    run_script('graph.py', 'health', str(vault_dir))

    graph_path = vault_dir / '.graph' / 'vault-graph.json'
    if not graph_path.exists():
        print("  ERROR: No vault-graph.json")
        return

    graph = json.loads(graph_path.read_text())
    nodes = graph.get('nodes', {})
    stats = graph.get('stats', {})

    domain_counts: dict[str, int] = {}
    type_counts: dict[str, int] = {}
    sample_nodes = []

    for path, node in list(nodes.items()):
        d = node.get('domain', 'unknown')
        t = node.get('type', 'unknown')
        domain_counts[d] = domain_counts.get(d, 0) + 1
        type_counts[t] = type_counts.get(t, 0) + 1

        if len(sample_nodes) < 200:
            sample_nodes.append({
                'path': path,
                'type': t,
                'domain': d,
                'has_desc': node.get('has_description', False),
                'outgoing': len(node.get('outgoing', [])),
                'incoming': len(node.get('incoming', [])),
            })

    output = {
        'generated_at': datetime.now().isoformat(),
        'vault': str(vault_dir),
        'stats': stats,
        'domain_distribution': domain_counts,
        'type_distribution': type_counts,
        'orphans': graph.get('orphan_list', [])[:50],
        'broken_links': graph.get('broken_link_list', [])[:30],
        'dead_ends': graph.get('dead_end_list', [])[:30],
        'sample_nodes': sample_nodes,
        'instructions': (
            'Analyze for: contradictions (active->archived links), '
            'missing obvious links, stale hubs, isolated clusters, '
            'decay anomalies. Write findings to .graph/graph-intelligence.json.'
        ),
    }

    out_path = vault_dir / '.graph' / 'graph-analysis-input.json'
    out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False) + '\n')
    print(f"  {len(nodes)} nodes, {len(sample_nodes)} sampled: {out_path}")


# ═══════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════

def main(argv: list[str] | None = None):
    parser = argparse.ArgumentParser(
        description='autograph orchestrate — multi-agent workflows (no API keys)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Phase 0 (script sequencing):
  health           run full health workflow
  bootstrap        run full bootstrap workflow

Data prep (for Claude Code agent judgment):
  dedup-prepare    enrich manifest for agent review
  link-prepare     build domain catalogs for agent link suggestions
  graph-prepare    build graph summary for agent analysis""")

    sub = parser.add_subparsers(dest='command')

    sub.add_parser('health').add_argument('vault_dir')
    sub.add_parser('bootstrap').add_argument('vault_dir')

    sub.add_parser('dedup-prepare').add_argument('vault_dir')

    lp = sub.add_parser('link-prepare')
    lp.add_argument('vault_dir')
    lp.add_argument('--force', action='store_true')

    sub.add_parser('graph-prepare').add_argument('vault_dir')

    ns = parser.parse_args(argv)
    if not ns.command:
        parser.print_help()
        sys.exit(1)

    vault = Path(ns.vault_dir).resolve()
    if not vault.is_dir():
        print(f"ERROR: {vault} is not a directory", file=sys.stderr)
        sys.exit(1)

    cmds = {
        'health': lambda: cmd_health(vault),
        'bootstrap': lambda: cmd_bootstrap(vault),
        'dedup-prepare': lambda: cmd_dedup_prepare(vault),
        'link-prepare': lambda: cmd_link_prepare(vault, getattr(ns, 'force', False)),
        'graph-prepare': lambda: cmd_graph_prepare(vault),
    }
    cmds[ns.command]()


if __name__ == '__main__':
    main()
