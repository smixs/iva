#!/usr/bin/env python3
"""
autograph daily — extract entities from daily memory files.
No hardcoded project/company names. Pattern-based extraction only.

Commands:
  daily.py extract <memory-dir> <vault-dir> [date|full]
"""

import re
import sys
import json
from pathlib import Path
from datetime import datetime, date
from collections import defaultdict

from common import (
    load_schema, parse_frontmatter, walk_vault, rel_path,
    extract_wikilinks, IGNORE_DIRS, get_entity_extraction_config,
    build_link_index, resolve_link_target, infer_type, infer_domain
)

LEGACY_ENTITY_BUCKETS = {
    'projects': 'project',
    'companies': 'company',
}


def build_output_meta() -> dict:
    """Expose migration hints for legacy daily entity buckets."""
    return {
        'primary_entity_field': 'entities.linked_entities',
        'deprecated_fields': [
            'entities.projects',
            'entities.companies',
        ],
    }


def resolve_vault_entity(target: str, vault_index: dict) -> dict | None:
    """Resolve a wikilink target to a typed vault entity."""
    if not vault_index:
        return None
    resolved, _ = resolve_link_target(target, vault_index.get('link_index', {}))
    if not resolved:
        return None
    return vault_index.get('entities', {}).get(resolved)


def derive_legacy_buckets(linked_entities: list[dict]) -> dict:
    """Build legacy buckets from the canonical linked_entities list."""
    buckets = {bucket: [] for bucket in LEGACY_ENTITY_BUCKETS}
    for entity in linked_entities:
        for bucket, entity_type in LEGACY_ENTITY_BUCKETS.items():
            if entity.get('type') == entity_type:
                buckets[bucket].append({
                    'name': entity.get('name', ''),
                    'link': entity.get('link', ''),
                })
    return buckets


def extract_entities(text: str, vault_index: dict, noise_words: set | None = None) -> dict:
    """Extract entities from daily file text. No hardcoded names."""
    entities = {
        'people': [],
        'companies': [],
        'projects': [],
        'linked_entities': [],
        'wikilinks': [],
        'financial': [],
        'events': [],
        'decisions': [],
    }

    # @mentions (filter common bots dynamically — just skip @-refs < 3 chars)
    for m in re.finditer(r'@([A-Za-z_]\w{2,})', text):
        handle = m.group(1)
        if len(handle) >= 3:
            entities['people'].append({'handle': f'@{handle}', 'type': 'mention'})

    # **Bold Names** (Cyrillic + Latin, 2-4 words starting with uppercase)
    noise = noise_words or set()
    for m in re.finditer(r'\*\*([A-ZА-ЯЁ][a-zа-яё]+(?:\s+[A-ZА-ЯЁ][a-zа-яё]+){0,3})\*\*', text):
        name = m.group(1)
        if name.split()[0] not in noise and len(name) > 4:
            entities['people'].append({'name': name, 'type': 'bold'})

    # [[wikilinks]] — resolve against vault index
    for target, display in extract_wikilinks(text):
        entities['wikilinks'].append({'target': target, 'display': display})
        entity = resolve_vault_entity(target, vault_index)
        if entity:
            linked = {
                'name': display,
                'link': entity['path'],
                'type': entity['type'],
                'domain': entity['domain'],
            }
            entities['linked_entities'].append(linked)

    # $amounts
    for m in re.finditer(r'\$[\d,]+(?:\.\d+)?(?:\s*[KkМм])?', text):
        entities['financial'].append({'amount': m.group(0), 'context': text[max(0,m.start()-40):m.end()+40].strip()})

    # Emoji events (🚀🔥💀✅❌🎂🎉⚠️)
    for m in re.finditer(r'[🚀🔥💀✅❌🎂🎉⚠️]\s*(.+?)(?:\n|$)', text):
        entities['events'].append(m.group(0).strip()[:150])

    # Decisions (✅ lines, "решено", "approved", "decided")
    for line in text.split('\n'):
        line_lower = line.strip().lower()
        if any(kw in line_lower for kw in ['✅', 'решено', 'approved', 'decided', 'договорились']):
            if len(line.strip()) > 5:
                entities['decisions'].append(line.strip()[:200])

    entities.update(derive_legacy_buckets(entities['linked_entities']))
    return entities


def build_vault_index(vault_dir: Path, schema: dict | None = None) -> dict:
    """Build deterministic typed index for vault entity resolution."""
    index = {'link_index': {}, 'entities': {}}
    if not vault_dir.is_dir():
        return index
    schema = schema or {}
    files = walk_vault(vault_dir)
    index['link_index'] = build_link_index(vault_dir, files)
    for md in files:
        rp = rel_path(md, vault_dir)
        rp_noext = rp.replace('.md', '')
        try:
            content = md.read_text(errors='replace')
        except Exception:
            content = ''
        fm, _, _ = parse_frontmatter(content)
        if fm is None:
            fm = {}
        index['entities'][rp_noext] = {
            'path': rp_noext,
            'type': fm.get('type') or infer_type(rp, schema),
            'domain': fm.get('domain') or infer_domain(rp, schema),
        }
    return index


def build_relationships(entities: dict) -> list:
    """Find co-mentions (entities appearing in same file = related)."""
    relationships = []
    all_entities = []
    for person in entities.get('people', []):
        name = person.get('handle') or person.get('name', '')
        if name:
            all_entities.append(('person', name))
    for linked in entities.get('linked_entities', []):
        name = linked.get('name', '')
        if name:
            all_entities.append((linked.get('type', 'entity'), name))

    # Co-mention pairs
    seen = set()
    for i, (t1, n1) in enumerate(all_entities):
        for j, (t2, n2) in enumerate(all_entities):
            if i >= j:
                continue
            pair = tuple(sorted([n1, n2]))
            if pair not in seen:
                seen.add(pair)
                relationships.append({
                    'from': n1, 'from_type': t1,
                    'to': n2, 'to_type': t2,
                    'type': 'co_mentioned'
                })
    return relationships


def process_date(memory_dir: Path, vault_index: dict, date_str: str, noise_words: set | None = None) -> dict:
    """Process a single daily file."""
    md_file = memory_dir / f"{date_str}.md"
    if not md_file.exists():
        return {'date': date_str, 'status': 'not_found'}

    content = md_file.read_text(errors='replace')
    entities = extract_entities(content, vault_index, noise_words)
    relationships = build_relationships(entities)

    return {
        'date': date_str,
        'status': 'ok',
        '_meta': build_output_meta(),
        'entities': entities,
        'relationships': relationships,
        'summary': {
            'people': len(entities['people']),
            'companies': len(entities['companies']),
            'projects': len(entities['projects']),
            'linked_entities': len(entities['linked_entities']),
            'wikilinks': len(entities['wikilinks']),
            'financial': len(entities['financial']),
            'events': len(entities['events']),
            'decisions': len(entities['decisions']),
            'relationships': len(relationships),
        }
    }


def process_full(memory_dir: Path, vault_index: dict, noise_words: set | None = None) -> list:
    """Process all daily files."""
    results = []
    for md in sorted(memory_dir.glob('????-??-??.md')):
        date_str = md.stem
        result = process_date(memory_dir, vault_index, date_str, noise_words)
        if result['status'] == 'ok':
            results.append(result)
    return results


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print(__doc__)
        sys.exit(0)

    cmd = args[0]
    if cmd != 'extract':
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)

    memory_dir = Path(args[1]) if len(args) > 1 else None
    vault_dir = Path(args[2]) if len(args) > 2 else None
    mode = args[3] if len(args) > 3 else 'today'

    if not memory_dir or not memory_dir.is_dir():
        print("Error: memory directory required", file=sys.stderr)
        sys.exit(1)

    # Load schema once for both type inference and noise words
    try:
        schema = load_schema()
        ee_config = get_entity_extraction_config(schema)
        noise_words = set(ee_config.get('noise_words', []))
    except FileNotFoundError:
        schema = {}
        noise_words = set()

    vault_index = build_vault_index(vault_dir, schema) if vault_dir and vault_dir.is_dir() else {}

    if mode == 'full':
        results = process_full(memory_dir, vault_index, noise_words)
        # Save all extracts
        if vault_dir:
            out_dir = vault_dir / '.graph'
            out_dir.mkdir(parents=True, exist_ok=True)
            for r in results:
                out_file = out_dir / f"daily-extract-{r['date']}.json"
                out_file.write_text(json.dumps(r, indent=2, ensure_ascii=False))

        # Summary
        total_people = sum(r['summary']['people'] for r in results)
        total_financial = sum(r['summary']['financial'] for r in results)
        total_events = sum(r['summary']['events'] for r in results)
        print(f"\n  daily extract — full mode")
        print(f"  Files processed: {len(results)}")
        print(f"  People found:    {total_people}")
        print(f"  Financial:       {total_financial}")
        print(f"  Events:          {total_events}")
    else:
        # Single date
        if mode == 'today':
            mode = date.today().isoformat()
        result = process_date(memory_dir, vault_index, mode, noise_words)

        if vault_dir:
            out_dir = vault_dir / '.graph'
            out_dir.mkdir(parents=True, exist_ok=True)
            out_file = out_dir / f"daily-extract-{mode}.json"
            out_file.write_text(json.dumps(result, indent=2, ensure_ascii=False))

        print(json.dumps(result.get('summary', result), indent=2))


if __name__ == '__main__':
    main()
