#!/usr/bin/env python3
"""
autograph generate_schema — turn discovery JSON into a draft schema.json.

Usage: python3 generate_schema.py <discovery.json> [output.json]
       cat discovery.json | python3 generate_schema.py -
"""

import json, sys
from pathlib import Path

_CANONICAL_ALIASES = {
    'blog-post': 'note', 'blog_post': 'note', 'blogpost': 'note',
    'article': 'note', 'post': 'note', 'page': 'note', 'idea': 'note',
    'person': 'contact', 'people': 'contact',
    'task': 'project', 'initiative': 'project',
    'ref': 'reference', 'resource': 'reference',
}
_STATUS_ORDER = {
    'active': 0, 'prospect': 1, 'negotiation': 2, 'won': 3, 'standby': 4,
    'pending': 5, 'lost': 6, 'inactive': 7, 'done': 8, 'draft': 9,
    'paused': 10, 'cancelled': 11, 'archived': 12,
}
_SYSTEM_FIELDS = {
    'type', 'status', 'tags', 'description', 'title', 'date',
    'last_accessed', 'tier', 'relevance', 'domain', 'priority',
    'created', 'updated', 'aliases',
}
_DOMAIN_KW = [
    (['project', 'work', 'client'], 'work'),
    (['note', 'zettel', 'knowledge', 'wiki'], 'knowledge'),
    (['personal', 'journal', 'diary', 'daily'], 'personal'),
    (['ai', 'prompt', 'tool'], 'tech'),
    (['clip', 'bookmark', 'save', 'read'], 'reference'),
    (['import', 'onenote', 'apple', 'notion'], 'import'),
]

def _edit_dist(a: str, b: str) -> int:
    if len(a) < len(b): return _edit_dist(b, a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr = [i + 1]
        for j, cb in enumerate(b):
            curr.append(min(prev[j] + (ca != cb), prev[j + 1] + 1, curr[j] + 1))
        prev = curr
    return prev[-1]

def _similar(a: str, b: str) -> bool:
    mx = max(len(a), len(b))
    return a != b and mx > 0 and _edit_dist(a, b) / mx <= 0.3

def _get_vals(enums: dict, field: str) -> dict:
    return enums.get(field, {}).get('values', {})

def _find_aliases(vals: dict) -> dict:
    """Map known aliases and typos to canonical forms (high-frequency first)."""
    by_count = sorted(vals, key=lambda v: -vals[v])
    canonical, aliases = set(), {}
    for v in by_count:
        if v in _CANONICAL_ALIASES:
            target = _CANONICAL_ALIASES[v]
            if target in vals or target in canonical:
                aliases[v] = target; continue
        matched = False
        for c in canonical:
            if _similar(v, c):
                aliases[v] = c; matched = True; break
        if not matched:
            canonical.add(v)
    return aliases

def build_node_types(enums: dict, exclude: set = None) -> dict:
    vals = _get_vals(enums, 'type')
    if not vals:
        return {'note': {'description': 'General note', 'required': ['description', 'tags'],
                         'status': ['active', 'draft', 'archived']}}
    exclude = exclude or set()
    statuses = sorted(_get_vals(enums, 'status').keys(),
                      key=lambda s: _STATUS_ORDER.get(s, 99)) or ['active', 'draft', 'archived']
    return {v: {'description': v.replace('-', ' ').replace('_', ' ').title(),
                'required': ['description', 'tags'], 'status': list(statuses)}
            for v in sorted(vals, key=lambda x: -vals[x]) if v not in exclude}

def build_domain_inference(folders: dict) -> dict:
    result = {}
    for folder in folders:
        if folder == 'root': continue
        key, low = folder.rstrip('/') + '/', folder.lower()
        matched = False
        for keywords, domain in _DOMAIN_KW:
            if any(w in low for w in keywords):
                result[key] = domain; matched = True; break
        if not matched:
            result[key] = low.replace(' ', '_')
    return result

def build_field_fixes(enums: dict) -> dict:
    fixes = {}
    for field, info in enums.items():
        if field == 'type': continue
        vals = info.get('values', {})
        popular = {v for v, c in vals.items() if c >= 10}
        rare = [v for v, c in vals.items() if c < 5]
        if not popular or not rare: continue
        fm = {}
        for rv in rare:
            for pv in popular:
                if _similar(rv, pv): fm[rv] = pv; break
        if fm: fixes[field] = fm
    return fixes

def build_status_order(enums: dict) -> dict:
    vals, order, idx = list(_get_vals(enums, 'status').keys()), {}, 0
    for s in sorted(_STATUS_ORDER, key=_STATUS_ORDER.get):
        if s in vals: order[s] = idx; idx += 1
    for s in vals:
        if s not in order: order[s] = idx; idx += 1
    order['_comment'] = 'sort order for MOC generation (lower = higher priority)'
    return order

def build_path_type_hints(folders: dict, node_types: dict) -> dict:
    hints = {'_comment': 'folder substring -> type name (used when card has no type field)'}
    valid = set(node_types.keys())
    for folder in folders:
        low = folder.lower().rstrip('/')
        for t in valid:
            if t in low: hints[low + '/'] = t; break
        for kw, tn in [('lead', 'lead'), ('contact', 'contact'), ('people', 'contact')]:
            if kw in low and tn in valid: hints[low + '/'] = tn
    return {k: v for k, v in hints.items() if v is not None}

def build_schema(discovery: dict) -> dict:
    enums = discovery.get('enums', {})
    folders = discovery.get('folder_structure', {})
    type_aliases = _find_aliases(_get_vals(enums, 'type'))
    node_types = build_node_types(enums, exclude=set(type_aliases.keys()))
    richness = [f for f in enums if f.lower() not in _SYSTEM_FIELDS]
    if not richness:
        richness = ['telegram', 'email', 'company', 'role', 'source',
                     'deal_status', 'responsible']
    return {
        '_comment': 'Draft schema generated from discover.py output — review and adjust',
        'node_types': node_types,
        'type_aliases': type_aliases,
        'field_fixes': build_field_fixes(enums),
        'region_fixes': {},
        'domain_inference': build_domain_inference(folders),
        'path_type_hints': build_path_type_hints(folders, node_types),
        'status_order': build_status_order(enums),
        'status_defaults': {
            '_comment': 'default status for new cards by type (when status is missing)',
            'default': 'active',
        },
        'richness_fields': {
            '_comment': 'frontmatter fields that indicate content richness (used by dedup)',
            'bonus_fields': richness,
        },
        'entity_extraction': {
            '_comment': 'settings for daily.py entity extraction',
            'noise_words': ['TODO', 'FIX', 'NEW', 'UPDATED', 'Phase', 'Score',
                            'Vault', 'Health', 'Pricing'],
        },
        'decay': {'rate': 0.015, 'floor': 0.1,
                  'tiers': {'active': 7, 'warm': 21, 'cold': 60}},
        'ignore_tags': [],
    }

def main():
    args = sys.argv[1:]
    if not args:
        print("Usage: generate_schema.py <discovery.json> [output.json]", file=sys.stderr)
        sys.exit(1)
    src = args[0]
    data = json.load(sys.stdin) if src == '-' else json.loads(Path(src).read_text())
    schema = build_schema(data)
    output = json.dumps(schema, ensure_ascii=False, indent=2) + '\n'
    if len(args) >= 2:
        out_path = Path(args[1])
        out_path.write_text(output)
        print(f"Schema written to {out_path}", file=sys.stderr)
    else:
        sys.stdout.write(output)

if __name__ == '__main__':
    main()
