#!/usr/bin/env python3
"""
autograph discover — Phase 1: scan vault, extract natural enums.
Finds all frontmatter values, wikilink patterns, folder structures.
Outputs discovered schema candidates to stdout as JSON.

Usage: python3 discover.py <vault-dir> [--verbose]
"""

import re
import json
import sys
from pathlib import Path
from collections import defaultdict, Counter
from datetime import datetime

from common import parse_frontmatter, walk_vault, rel_path, extract_wikilinks


def scan_vault(vault_dir: Path, verbose=False):
    """Scan entire vault, collect all metadata patterns."""

    field_values = defaultdict(Counter)
    field_presence = Counter()
    folder_patterns = Counter()
    wikilink_patterns = defaultdict(Counter)
    edge_contexts = []
    section_headers = Counter()
    tag_frequency = Counter()
    file_count = 0
    no_frontmatter = 0
    missing_required = defaultdict(int)

    for md_file in walk_vault(vault_dir):
        file_count += 1
        rp = rel_path(md_file, vault_dir)
        parts = Path(rp).parts
        folder = str(Path(rp).parent) if len(parts) > 1 else 'root'
        top_folder = parts[0] if len(parts) > 1 else 'root'

        folder_patterns[folder] += 1

        try:
            content = md_file.read_text(errors='replace')
        except Exception:
            continue

        fm, body, _ = parse_frontmatter(content)
        if fm is None:
            no_frontmatter += 1
            continue

        for key, val in fm.items():
            field_presence[key] += 1
            if isinstance(val, list):
                for item in val:
                    if isinstance(item, str):
                        field_values[key][item.lower()] += 1
                        if key == 'tags':
                            tag_frequency[item.lower()] += 1
            elif isinstance(val, str) and len(val) < 100:
                field_values[key][val.lower()] += 1

        for req in ['type', 'description', 'tags', 'status']:
            if req not in fm:
                missing_required[req] += 1

        source_type = fm.get('type', 'unknown')
        for target, _ in extract_wikilinks(body):
            target_top = target.split('/')[0] if '/' in target else 'self'
            wikilink_patterns[top_folder][target_top] += 1

            if verbose and len(edge_contexts) < 200:
                edge_contexts.append({
                    'source_type': source_type,
                    'source_file': rp,
                    'target': target,
                })

        for h in re.findall(r'^## (.+)$', body, re.MULTILINE):
            section_headers[h.strip().lower()] += 1

    # Build discovered schema
    discovered = {
        'meta': {
            'vault_dir': str(vault_dir),
            'total_files': file_count,
            'no_frontmatter': no_frontmatter,
            'frontmatter_coverage': round((file_count - no_frontmatter) / max(file_count, 1) * 100, 1),
            'scanned_at': datetime.now().isoformat(),
        },
        'enums': {},
        'missing_required': dict(missing_required),
        'folder_structure': {},
        'edge_patterns': {},
        'top_tags': [],
        'section_headers': [],
    }

    for field, values in sorted(field_values.items()):
        unique = len(values)
        total = sum(values.values())
        if unique <= 30 and total >= 3:
            top_vals = values.most_common(30)
            discovered['enums'][field] = {
                'unique_values': unique,
                'total_occurrences': total,
                'coverage': round(total / max(file_count, 1) * 100, 1),
                'values': {v: c for v, c in top_vals}
            }

    folder_groups = defaultdict(int)
    for folder, count in folder_patterns.most_common():
        top = folder.split('/')[0]
        folder_groups[top] += count
    discovered['folder_structure'] = dict(sorted(folder_groups.items(), key=lambda x: -x[1])[:20])

    for src, targets in wikilink_patterns.items():
        top_targets = targets.most_common(10)
        if top_targets:
            discovered['edge_patterns'][src] = {t: c for t, c in top_targets}

    discovered['top_tags'] = [{'tag': t, 'count': c} for t, c in tag_frequency.most_common(30)]
    discovered['section_headers'] = [{'header': h, 'count': c} for h, c in section_headers.most_common(20)]
    discovered['field_presence'] = {
        k: {'count': v, 'coverage': round(v / max(file_count, 1) * 100, 1)}
        for k, v in field_presence.most_common(30)
    }

    if verbose:
        discovered['edge_samples'] = edge_contexts[:50]

    return discovered


def main():
    if len(sys.argv) < 2:
        print("Usage: discover.py <vault-dir> [--verbose]", file=sys.stderr)
        sys.exit(1)

    vault_dir = Path(sys.argv[1])
    verbose = '--verbose' in sys.argv

    if not vault_dir.is_dir():
        print(f"Error: {vault_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    result = scan_vault(vault_dir, verbose=verbose)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
