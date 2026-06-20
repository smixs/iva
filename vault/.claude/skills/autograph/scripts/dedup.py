#!/usr/bin/env python3
"""
autograph dedup — find duplicate entities and write reproducible cleanup
manifests before any destructive-ish move.

Usage:
  python3 dedup.py <vault-dir> [schema.json]                         # report only
  python3 dedup.py <vault-dir> [schema.json] --manifest /tmp/m.json   # write dry-run manifest
  python3 dedup.py <vault-dir> [schema.json] --apply-manifest m.json  # apply approved entries
  python3 dedup.py <vault-dir> [schema.json] --apply                  # legacy apply, blocked by policy schemas

Safety:
  - NEVER deletes files. Moves extras to <vault>/.trash/dedup-YYYY-MM-DD/
  - Merges unique content from extras INTO canonical before moving
  - Logs every action to <vault>/.graph/dedup-log.jsonl
  - Policy schemas require manifest approval before apply
"""

import argparse
import re
import sys
import json
from pathlib import Path
from collections import defaultdict
from datetime import datetime

from common import (
    parse_frontmatter, walk_vault, rel_path,
    load_schema, get_richness_fields, collect_duplicate_groups,
    write_frontmatter, infer_domain, infer_type
)


def content_richness(content: str, bonus_fields: list | None = None) -> int:
    """Score content by information density. PRIMARY signal for canonical pick."""
    fm, body, _ = parse_frontmatter(content)
    if fm is None:
        fm = {}
    score = 0
    # Body length (main signal)
    score += len(body.strip())
    # Description quality
    desc = fm.get('description', '')
    if isinstance(desc, str):
        score += len(desc) * 2
    # Tags
    tags = fm.get('tags', [])
    if isinstance(tags, list):
        score += len(tags) * 10
    # Status presence
    if fm.get('status'):
        score += 20
    # Rich fields from schema
    for field in (bonus_fields or []):
        if fm.get(field):
            score += 15
    return score


def pick_canonical(paths: list[str], vault_dir: Path, bonus_fields: list | None = None) -> tuple[str, list[str]]:
    """Pick richest file as canonical. Content richness = primary, folder depth = tiebreaker."""
    scored = []
    for p in paths:
        try:
            content = (vault_dir / p).read_text(errors='replace')
        except Exception:
            content = ''
        richness = content_richness(content, bonus_fields)
        # Tiebreaker: shallower paths preferred (fewer '/' = more canonical location)
        depth_score = -p.count('/')
        scored.append((richness, depth_score, p))

    scored.sort(key=lambda x: (-x[0], -x[1]))
    canonical = scored[0][2]
    extras = [s[2] for s in scored[1:]]
    return canonical, extras


def dedup_policy(schema: dict) -> dict:
    """Return optional policy config from schema."""
    return schema.get('dedup_policy', {}) or {}


def is_policy_schema(schema: dict) -> bool:
    return bool(dedup_policy(schema).get('path_rules'))


def ignored_by_policy(path: str, policy: dict) -> bool:
    """Skip known inactive namespaces such as ignored backup folders."""
    for prefix in policy.get('ignored_path_prefixes', []):
        if path.startswith(prefix):
            return True
    return False


def path_rule_for(path: str, policy: dict) -> dict:
    """Find the first ontology rule matching a relative vault path."""
    for rule in policy.get('path_rules', []):
        if path.startswith(rule.get('prefix', '')):
            return rule
    return {}


def policy_kind(path: str, domain: str, card_type: str, policy: dict) -> str:
    rule = path_rule_for(path, policy)
    return str(rule.get('kind') or f'{domain}/{card_type}')


def policy_domain(path: str, fallback: str, policy: dict) -> str:
    rule = path_rule_for(path, policy)
    return str(rule.get('domain') or fallback)


def policy_type(path: str, fallback: str, policy: dict) -> str:
    rule = path_rule_for(path, policy)
    return str(rule.get('type') or fallback)


def policy_canonical(
    records: list[dict],
    vault_dir: Path,
    bonus_fields: list | None,
    policy: dict
) -> tuple[str, list[str]]:
    """Pick canonical by ontology priority first, richness second."""
    priority = policy.get('canonical_priority', [])
    ranked = []
    for rec in records:
        path = rec['path']
        prefix_rank = len(priority)
        for idx, prefix in enumerate(priority):
            if path.startswith(prefix):
                prefix_rank = idx
                break
        try:
            content = (vault_dir / path).read_text(errors='replace')
        except Exception:
            content = ''
        ranked.append((prefix_rank, -content_richness(content, bonus_fields), path))
    ranked.sort()
    canonical = ranked[0][2]
    extras = [item[2] for item in ranked[1:]]
    return canonical, extras


def file_record(vault_dir: Path, path: str, schema: dict, policy: dict, bonus_fields: list | None) -> dict:
    """Build a manifest record for one markdown file."""
    full = vault_dir / path
    try:
        content = full.read_text(errors='replace')
    except Exception:
        content = ''
    fm, body, _ = parse_frontmatter(content)
    fm = fm or {}
    inferred_domain = str(fm.get('domain') or infer_domain(path, schema))
    inferred_type = str(fm.get('type') or infer_type(path, schema))
    domain = policy_domain(path, inferred_domain, policy)
    card_type = policy_type(path, inferred_type, policy)
    return {
        'path': path,
        'stem': Path(path).stem,
        'domain': domain,
        'type': card_type,
        'kind': policy_kind(path, domain, card_type, policy),
        'richness': content_richness(content, bonus_fields),
        'title': first_heading(body) or Path(path).stem,
        'status': fm.get('status', ''),
        'source': fm.get('source', ''),
    }


def first_heading(body: str) -> str:
    m = re.search(r'^#\s+(.+)$', body, re.MULTILINE)
    return m.group(1).strip() if m else ''


def same_title(records: list[dict]) -> bool:
    titles = {str(r.get('title') or '').casefold() for r in records if r.get('title')}
    return len(titles) <= 1


def classify_policy_cluster(records: list[dict], policy: dict) -> tuple[str, str, str]:
    """Return (action, risk, reason) for a same-stem cluster."""
    stems = {r['stem'] for r in records}
    kinds = {r['kind'] for r in records}
    paths = [r['path'] for r in records]
    manual_stems = set(policy.get('manual_hold_stems', []))
    high_risk_stems = set(policy.get('high_risk_stems', []))

    if stems & manual_stems:
        return 'manual_hold', 'high', 'stem is in manual_hold_stems'
    if stems & high_risk_stems:
        return 'manual_hold', 'high', 'stem is in high_risk_stems'
    if len({p.casefold() for p in paths}) != len(paths):
        return 'manual_hold', 'high', 'case-only path collision'
    if not same_title(records):
        return 'manual_hold', 'high', 'same stem but different headings'

    if len(kinds) == 1:
        return 'merge_duplicate', 'low', 'same stem and same ontology kind'

    crm_kinds = set(policy.get('crm_overlay_kinds', ['crm']))
    non_crm = kinds - crm_kinds
    if non_crm and crm_kinds & kinds:
        return 'thin_crm_overlay', 'medium', 'crm overlay duplicates canonical ontology layers'

    return 'keep_linked_layers', 'medium', 'same stem spans multiple ontology layers'


def build_manifest(vault_dir: Path, schema: dict, schema_path: Path | None = None) -> dict:
    """Build dry-run manifest without changing vault content."""
    policy = dedup_policy(schema)
    bonus_fields = get_richness_fields(schema)
    by_stem = defaultdict(list)

    for md in walk_vault(vault_dir):
        path = rel_path(md, vault_dir)
        if ignored_by_policy(path, policy):
            continue
        if md.stem in {'_index', 'MEMORY'}:
            continue
        by_stem[md.stem].append(file_record(vault_dir, path, schema, policy, bonus_fields))

    clusters = []
    for slug, records in sorted(by_stem.items()):
        if len(records) < 2:
            continue
        action, risk, reason = classify_policy_cluster(records, policy)
        canonical = ''
        extras = []
        if action == 'merge_duplicate':
            canonical, extras = policy_canonical(records, vault_dir, bonus_fields, policy)
        elif action == 'thin_crm_overlay':
            crm_kinds = set(policy.get('crm_overlay_kinds', ['crm']))
            non_crm_records = [r for r in records if r['kind'] not in crm_kinds]
            canonical, _ = policy_canonical(non_crm_records, vault_dir, bonus_fields, policy)
            extras = [r['path'] for r in records if r['kind'] in crm_kinds]
        clusters.append({
            'id': slug,
            'slug': slug,
            'action': action,
            'risk': risk,
            'reason': reason,
            'canonical': canonical,
            'extras': extras,
            'approved': False,
            'records': records,
        })

    return {
        'generated_at': datetime.now().isoformat(),
        'vault': str(vault_dir),
        'schema': str(schema_path) if schema_path else '',
        'mode': 'policy',
        'clusters': clusters,
        'summary': summarize_manifest(clusters),
    }


def summarize_manifest(clusters: list[dict]) -> dict:
    actions = defaultdict(int)
    risks = defaultdict(int)
    extras = 0
    for cluster in clusters:
        actions[cluster['action']] += 1
        risks[cluster['risk']] += 1
        extras += len(cluster.get('extras', []))
    return {
        'clusters': len(clusters),
        'extra_files': extras,
        'actions': dict(sorted(actions.items())),
        'risks': dict(sorted(risks.items())),
    }


def merge_content(canonical_path: Path, extra_paths: list[Path]) -> bool:
    """Merge unique info from extras into canonical. Returns True if changed."""
    canon_content = canonical_path.read_text(errors='replace')
    canon_fm, canon_body, canon_lines = parse_frontmatter(canon_content)
    if canon_fm is None:
        canon_fm = {}
    changed = False

    for extra_path in extra_paths:
        try:
            extra_content = extra_path.read_text(errors='replace')
        except Exception:
            continue
        extra_fm, extra_body, _ = parse_frontmatter(extra_content)
        if extra_fm is None:
            extra_fm = {}

        # Merge frontmatter: take richer/non-empty values
        for key, val in extra_fm.items():
            canon_val = canon_fm.get(key, '')
            if not canon_val and val:
                canon_fm[key] = val
                changed = True
            elif isinstance(val, str) and isinstance(canon_val, str) and len(val) > len(canon_val) * 1.5:
                canon_fm[key] = val
                changed = True
            elif isinstance(val, list) and isinstance(canon_val, list) and len(val) > len(canon_val):
                merged = list(dict.fromkeys(canon_val + val))
                if merged != canon_val:
                    canon_fm[key] = merged
                    changed = True

        # Merge unique body sections
        extra_sections = set(re.findall(r'^## (.+)$', extra_body, re.MULTILINE))
        canon_sections = set(re.findall(r'^## (.+)$', canon_body, re.MULTILINE))
        for section_name in extra_sections - canon_sections:
            pattern = rf'^## {re.escape(section_name)}\n(.*?)(?=\n## |\Z)'
            m = re.search(pattern, extra_body, re.MULTILINE | re.DOTALL)
            if m:
                canon_body = canon_body.rstrip() + '\n\n' + m.group(0).strip() + '\n'
                changed = True

    if changed:
        new_fm = write_frontmatter(canon_fm, canon_lines)
        canonical_path.write_text(f"---\n{new_fm}\n---\n{canon_body}")

    return changed


def redirect_links(vault_dir: Path, old_paths: list[str], canonical: str) -> int:
    """Update wikilinks pointing to old paths → canonical."""
    canonical_noext = canonical.replace('.md', '')

    old_refs = set()
    for old in old_paths:
        old_noext = old.replace('.md', '')
        old_refs.add(old_noext)
        old_refs.add(Path(old).stem)
        parts = old_noext.split('/')
        for i in range(len(parts)):
            old_refs.add('/'.join(parts[i:]))

    # Don't redirect canonical references
    canon_parts = canonical_noext.split('/')
    for i in range(len(canon_parts)):
        old_refs.discard('/'.join(canon_parts[i:]))
    old_refs.discard(Path(canonical).stem)

    if not old_refs:
        return 0

    count = 0
    for md in walk_vault(vault_dir):
        try:
            content = md.read_text(errors='replace')
        except Exception:
            continue

        new_content = content
        for old_ref in old_refs:
            pattern = re.compile(r'\[\[' + re.escape(old_ref) + r'(\|[^\]]+)?\]\]')
            if pattern.search(new_content):
                new_content = pattern.sub(
                    lambda m: f'[[{canonical_noext}{m.group(1) or ""}]]',
                    new_content
                )
                count += 1

        if new_content != content:
            md.write_text(new_content)

    return count


def thin_crm_overlay(
    vault_dir: Path, crm_path: str, canonical: str, schema: dict | None = None
) -> bool:
    """Replace a CRM duplicate body with a compact status overlay."""
    full = vault_dir / crm_path
    if not full.exists():
        return False
    content = full.read_text(errors='replace')
    fm, body, fm_lines = parse_frontmatter(content)
    fm = fm or {}
    canonical_noext = canonical.replace('.md', '')
    title = first_heading(body) or Path(crm_path).stem
    fm['canonical'] = f'[[{canonical_noext}]]'
    fm['type'] = 'crm'
    # Domain comes from the schema's domain_inference — never hardcoded.
    domain = infer_domain(crm_path, schema) if schema else ''
    if domain:
        fm['domain'] = domain
    new_fm = write_frontmatter(fm, fm_lines)
    status = fm.get('status', 'active')
    new_body = (
        f"# {title}\n\n"
        "## CRM Overlay\n"
        f"- Canonical: [[{canonical_noext}]]\n"
        f"- Status: {status}\n"
    )
    new_content = f"---\n{new_fm}\n---\n{new_body}"
    if new_content == content:
        return False
    full.write_text(new_content)
    return True


def apply_manifest(
    vault_dir: Path, manifest_path: Path, verbose=False, schema: dict | None = None
) -> dict:
    """Apply only entries explicitly marked approved in a manifest."""
    manifest = json.loads(manifest_path.read_text())
    today = datetime.now().strftime('%Y-%m-%d')
    trash_dir = vault_dir / '.trash' / f'dedup-{today}'
    log_path = vault_dir / '.graph' / 'dedup-log.jsonl'
    log_path.parent.mkdir(exist_ok=True)

    applied = {
        'approved': 0,
        'merged': 0,
        'thinned': 0,
        'moved': 0,
        'links_redirected': 0,
        'skipped': 0,
    }

    with open(log_path, 'a') as log_file:
        for cluster in manifest.get('clusters', []):
            if not cluster.get('approved'):
                continue
            applied['approved'] += 1
            action = cluster.get('action')
            canonical = cluster.get('canonical')
            extras = list(cluster.get('extras') or [])
            if not canonical:
                applied['skipped'] += 1
                continue

            if action == 'merge_duplicate':
                trash_dir.mkdir(parents=True, exist_ok=True)
                extra_full = [vault_dir / e for e in extras]
                merge_content(vault_dir / canonical, extra_full)
                lr = redirect_links(vault_dir, extras, canonical)
                moved = []
                for extra in extras:
                    src = vault_dir / extra
                    if not src.exists():
                        continue
                    dest = trash_dir / extra
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    src.rename(dest)
                    moved.append(extra)
                applied['merged'] += 1
                applied['moved'] += len(moved)
                applied['links_redirected'] += lr
                log_entry = {
                    'ts': datetime.now().isoformat(),
                    'action': action,
                    'slug': cluster.get('slug'),
                    'canonical': canonical,
                    'moved': moved,
                    'links_redirected': lr,
                    'manifest': str(manifest_path),
                }
                log_file.write(json.dumps(log_entry, ensure_ascii=False) + '\n')
                if verbose:
                    print(f"MERGED {cluster.get('slug')}: {len(moved)} moved")

            elif action == 'thin_crm_overlay':
                # build_manifest puts only overlay-kind paths (crm_overlay_kinds)
                # into extras, so trust the approved manifest — no path hardcode.
                crm_paths = list(extras)
                if not crm_paths:
                    applied['skipped'] += 1
                    continue
                changed = 0
                for crm_path in crm_paths:
                    if thin_crm_overlay(vault_dir, crm_path, canonical, schema):
                        changed += 1
                applied['thinned'] += changed
                log_entry = {
                    'ts': datetime.now().isoformat(),
                    'action': action,
                    'slug': cluster.get('slug'),
                    'canonical': canonical,
                    'thinned': crm_paths,
                    'manifest': str(manifest_path),
                }
                log_file.write(json.dumps(log_entry, ensure_ascii=False) + '\n')
                if verbose:
                    print(f"THINNED {cluster.get('slug')}: {changed} overlays")
            else:
                applied['skipped'] += 1

    out = vault_dir / '.graph' / 'dedup-apply-report.json'
    out.write_text(json.dumps({
        'date': today,
        'manifest': str(manifest_path),
        **applied,
    }, indent=2, ensure_ascii=False))
    return applied


def write_manifest(path: Path, manifest: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))


def print_policy_manifest(manifest: dict, verbose=False) -> None:
    summary = manifest['summary']
    print(f"\n{'='*55}")
    print("  AUTOGRAPH DEDUP - POLICY DRY RUN")
    print(f"{'='*55}")
    print(f"  Duplicate clusters: {summary['clusters']}")
    print(f"  Extra files:        {summary['extra_files']}")
    print(f"  Actions:            {summary['actions']}")
    print(f"  Risks:              {summary['risks']}")
    if verbose:
        for cluster in manifest['clusters']:
            print(f"\n  {cluster['slug']} [{cluster['action']}/{cluster['risk']}]:")
            if cluster.get('canonical'):
                print(f"    CANONICAL: {cluster['canonical']}")
            for rec in cluster.get('records', []):
                marker = '    '
                if rec['path'] == cluster.get('canonical'):
                    marker = '  * '
                print(f"{marker}{rec['path']} ({rec['kind']}, richness={rec['richness']})")
            if cluster.get('extras'):
                print(f"    EXTRAS: {', '.join(cluster['extras'])}")
            print(f"    REASON: {cluster['reason']}")


def dedup(vault_dir: Path, schema_path: Path | None = None, apply=False,
          verbose=False, manifest_path: Path | None = None,
          apply_manifest_path: Path | None = None):
    today = datetime.now().strftime('%Y-%m-%d')
    trash_dir = vault_dir / '.trash' / f'dedup-{today}'
    log_path = vault_dir / '.graph' / 'dedup-log.jsonl'

    try:
        schema = load_schema(schema_path)
    except FileNotFoundError:
        schema = {}

    if apply_manifest_path:
        result = apply_manifest(vault_dir, apply_manifest_path, verbose, schema=schema)
        print(f"Applied manifest: {result}")
        return

    if is_policy_schema(schema):
        if apply:
            print("ERROR: policy schema requires --apply-manifest with approved entries.", file=sys.stderr)
            sys.exit(2)
        manifest = build_manifest(vault_dir, schema, schema_path)
        print_policy_manifest(manifest, verbose)
        if manifest_path:
            write_manifest(manifest_path, manifest)
            print(f"    Manifest:           {manifest_path}")
        out = vault_dir / '.graph' / 'dedup-report.json'
        out.parent.mkdir(exist_ok=True)
        summary = manifest['summary']
        out.write_text(json.dumps({
            'date': today,
            'mode': 'policy',
            'duplicates': summary['clusters'],
            'extra_files': summary['extra_files'],
            'actions': summary['actions'],
            'risks': summary['risks'],
            'manifest': str(manifest_path) if manifest_path else '',
        }, indent=2, ensure_ascii=False))
        print(f"    Report:             {out}")
        return

    bonus_fields = get_richness_fields(schema)

    # Find only safe duplicates: same stem + domain + type
    dupes = collect_duplicate_groups(vault_dir, schema)

    if not dupes:
        print("No duplicates found.")
        return

    total_extra = sum(len(paths) - 1 for paths in dupes.values())

    print(f"\n{'='*55}")
    print(f"  AUTOGRAPH DEDUP — {'APPLY' if apply else 'DRY RUN'}")
    print(f"{'='*55}")
    print(f"  Duplicate groups: {len(dupes)}")
    print(f"  Extra files:      {total_extra}")

    log_file = None
    if apply:
        trash_dir.mkdir(parents=True, exist_ok=True)
        log_path.parent.mkdir(exist_ok=True)
        log_file = open(log_path, 'a')

    merged_count = 0
    content_merged = 0
    links_redirected = 0
    moved_count = 0

    for (slug, domain, card_type), paths in sorted(dupes.items(), key=lambda x: (-len(x[1]), x[0])):
        canonical, extras = pick_canonical(paths, vault_dir, bonus_fields)

        if verbose:
            canon_rich = content_richness((vault_dir / canonical).read_text(errors='replace'), bonus_fields)
            print(f"\n  {slug} [{domain}/{card_type}] ({len(paths)}x):")
            print(f"    KEEP: {canonical} (richness={canon_rich})")
            for e in extras:
                e_rich = content_richness((vault_dir / e).read_text(errors='replace'), bonus_fields)
                print(f"    MOVE: {e} (richness={e_rich})")

        if apply:
            extra_full = [vault_dir / e for e in extras]
            did_merge = merge_content(vault_dir / canonical, extra_full)
            if did_merge:
                content_merged += 1

            lr = redirect_links(vault_dir, extras, canonical)
            links_redirected += lr

            for extra in extras:
                src = vault_dir / extra
                dest = trash_dir / extra
                dest.parent.mkdir(parents=True, exist_ok=True)
                src.rename(dest)
                moved_count += 1

            if log_file:
                log_file.write(json.dumps({
                    'ts': datetime.now().isoformat(), 'slug': slug,
                    'domain': domain, 'type': card_type,
                    'canonical': canonical, 'moved': extras,
                    'content_merged': did_merge, 'links_redirected': lr,
                }, ensure_ascii=False) + '\n')

        merged_count += 1

    if log_file:
        log_file.close()

    print(f"\n  Results:")
    print(f"    Slugs processed:    {merged_count}")
    if apply:
        print(f"    Content merged:     {content_merged}")
        print(f"    Links redirected:   {links_redirected}")
        print(f"    Files moved:        {moved_count} → {trash_dir}")
        print(f"    Log:                {log_path}")
    else:
        print(f"    Would move:         {total_extra} files to .trash/")

    out = vault_dir / '.graph' / 'dedup-report.json'
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({
        'date': today, 'duplicates': len(dupes), 'extra_files': total_extra,
        'merged': merged_count, 'moved': moved_count if apply else 0,
        'content_merged': content_merged if apply else 0,
    }, indent=2, ensure_ascii=False))
    print(f"    Report:             {out}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='autograph dedup')
    parser.add_argument('vault_dir')
    parser.add_argument('schema_path', nargs='?')
    parser.add_argument('--dry-run', action='store_true', help='explicit no-op dry run')
    parser.add_argument('--apply', action='store_true', help='legacy apply; blocked for policy schemas')
    parser.add_argument('--verbose', action='store_true')
    parser.add_argument('--manifest', help='write dry-run manifest JSON')
    parser.add_argument('--apply-manifest', help='apply approved entries from manifest JSON')
    return parser.parse_args(argv)


if __name__ == '__main__':
    ns = parse_args(sys.argv[1:])
    dedup(
        Path(ns.vault_dir),
        Path(ns.schema_path) if ns.schema_path else None,
        apply=ns.apply,
        verbose=ns.verbose,
        manifest_path=Path(ns.manifest) if ns.manifest else None,
        apply_manifest_path=Path(ns.apply_manifest) if ns.apply_manifest else None,
    )
