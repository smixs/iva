"""
autograph common — shared utilities for all scripts.
Single source of truth. NO hardcoded domains, types, statuses, paths.
Everything reads from schema.json.
"""

import re
import json
from pathlib import Path
from datetime import date, datetime
from collections import defaultdict

# ─── CONSTANTS ─────────────────────────────────────────────
IGNORE_DIRS = frozenset({
    '.obsidian', 'attachments', '.git', '.graph',
    '.claude', '.trash', 'backup', 'archive', '__pycache__'
})

SCHEMA_FILENAME = 'schema.json'

# Scalar facts where a NEW differing value supersedes the old (recency wins);
# the losing value is recorded to ## History. Overridable via schema conflict_fields.
DEFAULT_CONFLICT_FIELDS = ["company", "role", "status", "handle",
                          "platform", "phone", "email", "title"]

# Same-entity detection for dedup/supersede grouping. Strong keys (exact normalized
# match on match_fields) union cards across different filenames. Name-only never
# groups (fuzzy off) — a false merge is worse than a duplicate.
DEFAULT_IDENTITY = {
    "match_fields": ["email", "telegram", "handle", "phone"],
    "same_domain_only": True,
    "same_type_only": True,
    "fuzzy_name": False,
    "ignore_values": ["", "n/a", "-", "none", "unknown"],
    "max_shared": 8,
}


# ─── SCHEMA ────────────────────────────────────────────────
_schema_cache = {}

def load_schema(schema_path: Path | str | None = None) -> dict:
    """Load schema.json. Caches after first load by resolved path.
    If no path given, looks in: CWD/schema.json → skill dir/schema.local.json → schema.json → schema.example.json"""
    if schema_path is not None:
        schema_path = Path(schema_path)
        key = str(schema_path.resolve())
        if key in _schema_cache:
            return _schema_cache[key]
    else:
        skill_dir = Path(__file__).parent.parent
        candidates = [
            Path.cwd() / SCHEMA_FILENAME,          # user's schema in CWD
            skill_dir / 'schema.local.json',        # local override FIRST
            skill_dir / SCHEMA_FILENAME,            # schema.json in skill dir
            skill_dir / 'schema.example.json',      # fallback example
        ]
        for c in candidates:
            if c.exists():
                schema_path = c
                break
        if schema_path is None:
            schema_path = skill_dir / SCHEMA_FILENAME  # will raise FileNotFoundError
        key = str(schema_path.resolve())
        if key in _schema_cache:
            return _schema_cache[key]

    if not schema_path.exists():
        raise FileNotFoundError(f"Schema not found: {schema_path}")

    schema = json.loads(schema_path.read_text())
    _schema_cache[key] = schema
    return schema


def get_node_types(schema: dict) -> list[str]:
    """All valid node types."""
    return list(schema.get('node_types', {}).keys())


def get_valid_statuses(schema: dict, node_type: str) -> list[str]:
    """Valid statuses for a node type."""
    return schema.get('node_types', {}).get(node_type, {}).get('status', [])


def get_type_aliases(schema: dict) -> dict:
    """Type alias map (old → new)."""
    return schema.get('type_aliases', {})


def get_domain_map(schema: dict) -> dict:
    """Folder → domain mapping."""
    return schema.get('domain_inference', {})


def get_decay_config(schema: dict) -> dict:
    """Decay rate, floor, tier thresholds."""
    return schema.get('decay', {
        'rate': 0.015, 'floor': 0.1,
        'tiers': {'active': 7, 'warm': 21, 'cold': 60}
    })


def get_ignore_tags(schema: dict) -> set:
    """Tags to ignore (e.g. bulk import artifacts)."""
    return set(schema.get('ignore_tags', []))


def get_field_fixes(schema: dict) -> dict:
    """Field value normalizations."""
    return schema.get('field_fixes', {})


def get_path_type_hints(schema: dict) -> dict:
    """Folder substring → type name mapping for type inference."""
    hints = schema.get('path_type_hints', {})
    return {k: v for k, v in hints.items() if k != '_comment'}


def get_status_order(schema: dict) -> dict:
    """Status sort order for MOC generation."""
    order = schema.get('status_order', {})
    return {k: v for k, v in order.items() if k != '_comment'}


def get_status_defaults(schema: dict) -> dict:
    """Default status by type when status is missing."""
    defaults = schema.get('status_defaults', {})
    return {k: v for k, v in defaults.items() if k != '_comment'}


def get_richness_fields(schema: dict) -> list:
    """Frontmatter fields that indicate content richness (for dedup)."""
    cfg = schema.get('richness_fields', {})
    return cfg.get('bonus_fields', [])


def get_conflict_fields(schema: dict) -> list:
    """Scalar fields where differing values = temporal conflict (recency wins)."""
    cfg = schema.get('conflict_fields', {}) or {}
    return cfg.get('fields', DEFAULT_CONFLICT_FIELDS)


def get_identity_config(schema: dict) -> dict:
    """Same-entity detection config, defaults filled for any missing key."""
    cfg = {k: v for k, v in (schema.get('identity') or {}).items() if k != '_comment'}
    merged = dict(DEFAULT_IDENTITY)
    merged.update(cfg)
    return merged


def card_recency_date(fields: dict) -> str:
    """Recency key for a card: updated > created > last_accessed > ''."""
    fields = fields or {}
    return str(fields.get('updated') or fields.get('created')
               or fields.get('last_accessed') or '')


def normalize_identity_value(field: str, val) -> str:
    """Normalize an identity value for cross-card matching."""
    s = str(val).strip().lower()
    if field in ('telegram', 'handle'):
        s = s.lstrip('@')
    elif field == 'phone':
        s = re.sub(r'\D', '', s)
    else:
        s = re.sub(r'\s+', ' ', s)
    return s


def get_entity_extraction_config(schema: dict) -> dict:
    """Entity extraction settings for daily.py."""
    cfg = schema.get('entity_extraction', {})
    return {k: v for k, v in cfg.items() if k != '_comment'}


# ─── FRONTMATTER ───────────────────────────────────────────
def parse_frontmatter(content: str) -> tuple[dict, str, list[str]]:
    """Parse YAML frontmatter from markdown content.
    Returns: (fields_dict, body_after_fm, original_fm_lines)
    If no frontmatter: (None, full_content, [])
    """
    content = content.replace('\r\n', '\n').replace('\r', '\n')
    m = re.match(r'^---\n(.*?)\n---\n?(.*)', content, re.DOTALL)
    if not m:
        return None, content, []

    raw_lines = m.group(1).split('\n')
    body = m.group(2)
    fields = {}
    multiline_key = None
    multiline_mode = None  # fold | literal | list | pending
    multiline_sep = ' '  # >- fold (space), |- literal (newline)

    for line in raw_lines:
        stripped = line.strip()
        indented = line.startswith('  ') or line.startswith('\t')

        # Multi-line continuation
        if multiline_key and indented:
            if multiline_mode == 'pending':
                if stripped.startswith('- '):
                    multiline_mode = 'list'
                    fields[multiline_key] = []
                else:
                    multiline_mode = 'fold'
                    multiline_sep = ' '
                    fields[multiline_key] = ''

            if multiline_mode == 'list':
                item = stripped[2:].strip() if stripped.startswith('- ') else stripped
                if item:
                    fields[multiline_key].append(item.strip("'\""))
            else:
                prev = fields.get(multiline_key, '') or ''
                fields[multiline_key] = (prev + multiline_sep + stripped).strip()
            continue

        if multiline_key and not indented:
            if fields.get(multiline_key) is None:
                fields[multiline_key] = ''
            multiline_key = None
            multiline_mode = None
            multiline_sep = ' '

        if not stripped or stripped.startswith('#'):
            continue

        if ':' not in stripped:
            continue

        key, _, val = stripped.partition(':')
        key = key.strip()
        val = val.strip()

        if val in ('>-', '>'):
            multiline_key = key
            multiline_mode = 'fold'
            multiline_sep = ' '
            fields[key] = ''
            continue
        if val in ('|-', '|'):
            multiline_key = key
            multiline_mode = 'literal'
            multiline_sep = '\n'
            fields[key] = ''
            continue
        if val.startswith('>-') or val.startswith('>'):
            multiline_key = key
            multiline_mode = 'fold'
            multiline_sep = ' '
            fields[key] = val.lstrip('>-').strip()
            continue
        if val.startswith('|-') or val.startswith('|'):
            multiline_key = key
            multiline_mode = 'literal'
            multiline_sep = '\n'
            fields[key] = val.lstrip('|-').strip()
            continue
        if val == '':
            multiline_key = key
            multiline_mode = 'pending'
            multiline_sep = ' '
            fields[key] = None
            continue

        if val.startswith('[') and val.endswith(']'):
            items = [x.strip().strip("'\"") for x in val[1:-1].split(',') if x.strip()]
            fields[key] = items
        else:
            fields[key] = val.strip("'\"")

    if multiline_key and fields.get(multiline_key) is None:
        fields[multiline_key] = ''

    return fields, body, raw_lines


def write_frontmatter(fields: dict, original_lines: list[str]) -> str:
    """Rebuild frontmatter, preserving original order, updating values, appending new.
    Handles multiline YAML values (>-, |-, >, |) — when a key is rewritten,
    its continuation lines are skipped to prevent duplication."""
    written = set()
    out = []
    skip_continuation = False

    for line in original_lines:
        stripped = line.strip()
        indented = line.startswith('  ') or line.startswith('\t')
        if skip_continuation and indented:
            continue  # fold/literal continuation of a replaced key: skip by indent, not colon

        if not stripped or stripped.startswith('#'):
            skip_continuation = False
            out.append(line)
            continue
        if ':' not in stripped:
            if not skip_continuation:
                out.append(line)
            continue

        skip_continuation = False
        key = stripped.partition(':')[0].strip()
        val_part = stripped.partition(':')[2].strip()
        written.add(key)
        if key in fields:
            out.append(format_field(key, fields[key]))
            # '' covers block-style lists and pending multiline values —
            # their indented continuation lines are replaced wholesale too.
            if val_part in ('>-', '>', '|-', '|', ''):
                skip_continuation = True
        else:
            out.append(line)

    for key, val in fields.items():
        if key not in written:
            out.append(format_field(key, val))

    return '\n'.join(out)


YAML_SPECIAL = re.compile(r'[:#\[\]{}"\',|>!&*?]')

def format_field(key: str, val) -> str:
    """Format a single frontmatter field."""
    if isinstance(val, list):
        return f"{key}: [{', '.join(str(v) for v in val)}]"
    if isinstance(val, (int, float)):
        return f"{key}: {val}"
    s = str(val)
    if key == 'description' and s and len(s) > 80:
        return f'{key}: >-\n  {s}'
    if YAML_SPECIAL.search(s):
        escaped = s.replace('"', '\\"')
        return f'{key}: "{escaped}"'
    return f"{key}: {s}"


# ─── FILE OPERATIONS ───────────────────────────────────────
def walk_vault(vault_dir: Path) -> list[Path]:
    """Walk vault, yield all .md files, skipping IGNORE_DIRS."""
    results = []
    for md in sorted(vault_dir.rglob('*.md')):
        parts = set(md.relative_to(vault_dir).parts)
        if parts & IGNORE_DIRS:
            continue
        results.append(md)
    return results


def rel_path(md_file: Path, vault_dir: Path) -> str:
    """Relative path as string."""
    return str(md_file.relative_to(vault_dir))


def is_hub_path(path: str) -> bool:
    """Return True for hub notes like _index or MEMORY at any depth."""
    return Path(path).name in {'_index', 'MEMORY'}


def build_link_index(vault_dir: Path, files: list[Path] | None = None) -> dict:
    """Build deterministic indexes for wikilink resolution."""
    files = files or walk_vault(vault_dir)
    exact = {}
    suffix_map = defaultdict(set)
    stem_map = defaultdict(set)

    for md in files:
        rp = rel_path(md, vault_dir)
        rp_noext = rp[:-3] if rp.endswith('.md') else rp
        exact[rp_noext] = rp_noext
        stem_map[md.stem].add(rp_noext)

        parts = rp_noext.split('/')
        for i in range(1, len(parts) - 1):
            suffix_map['/'.join(parts[i:])].add(rp_noext)

    return {
        'exact': exact,
        'unique_suffix': {k: next(iter(v)) for k, v in suffix_map.items() if len(v) == 1},
        'ambiguous_suffix': {k: sorted(v) for k, v in suffix_map.items() if len(v) > 1},
        'unique_stem': {k: next(iter(v)) for k, v in stem_map.items() if len(v) == 1},
        'ambiguous_stem': {k: sorted(v) for k, v in stem_map.items() if len(v) > 1},
    }


def normalize_link_target(target: str) -> str:
    """Normalize a wikilink target before resolution."""
    target = target.replace('\\', '').strip()
    if '#' in target:
        target = target.split('#', 1)[0].strip()
    if target.endswith('.md'):
        target = target[:-3]
    if target.startswith('vault/'):
        target = target[6:]
    return target


def resolve_link_target(target: str, link_index: dict) -> tuple[str | None, str]:
    """Resolve a target using exact path, unique suffix, then unique stem."""
    target = normalize_link_target(target)
    if not target:
        return None, 'empty'

    exact = link_index.get('exact', {})
    unique_suffix = link_index.get('unique_suffix', {})
    ambiguous_suffix = link_index.get('ambiguous_suffix', {})
    unique_stem = link_index.get('unique_stem', {})
    ambiguous_stem = link_index.get('ambiguous_stem', {})

    if target in exact:
        return exact[target], 'exact'
    if target in unique_suffix:
        return unique_suffix[target], 'unique_suffix'
    if target in ambiguous_suffix:
        return None, 'ambiguous_suffix'

    stem = target.split('/')[-1]
    if '/' in target:
        return None, 'missing'
    if stem in unique_stem:
        return unique_stem[stem], 'unique_stem'
    if stem in ambiguous_stem:
        return None, 'ambiguous_stem'
    return None, 'missing'


# ─── DOMAIN INFERENCE ──────────────────────────────────────
def infer_domain(file_rel_path: str, schema: dict) -> str:
    """Infer domain from file path using schema's domain_inference map."""
    domain_map = get_domain_map(schema)
    for pattern, domain in domain_map.items():
        if file_rel_path.startswith(pattern):
            return domain
    return 'personal'  # default


# ─── TYPE INFERENCE ────────────────────────────────────────
def infer_type(file_rel_path: str, schema: dict) -> str:
    """Infer card type from file path using schema's node_types + path_type_hints.
    No hardcoded values — uses schema data only."""
    valid_types = set(get_node_types(schema))
    rp = file_rel_path.lower()

    # Try to match path keywords against known type names
    for type_name in valid_types:
        if f'{type_name}/' in rp or rp.startswith(f'{type_name}/'):
            return type_name

    # Check path_type_hints from schema
    for pattern, hint_type in get_path_type_hints(schema).items():
        if f'/{pattern}' in rp or rp.startswith(pattern):
            return hint_type if hint_type in valid_types else 'note'

    # Default to first type or 'note'
    return 'note' if 'note' in valid_types else (list(valid_types)[0] if valid_types else 'note')


def collect_duplicate_groups(vault_dir: Path, schema: dict | None = None,
                             files: list[Path] | None = None,
                             ignored_stems: set[str] | None = None) -> dict[tuple[str, str, str], list[str]]:
    """Group compatible duplicates.

    Base: same stem, domain, and type (backward-compatible with earlier behavior).
    When the schema defines an `identity` block, cards that share a strong identity
    key (same normalized email/telegram/handle/phone) are additionally unioned across
    different filenames — same-entity detection. Name-only never groups. Safety-first:
    when in doubt, do NOT group (a false merge is worse than a duplicate).
    """
    schema = schema or {}
    files = files or walk_vault(vault_dir)
    ignored_stems = ignored_stems or {'_index', 'MEMORY'}

    records = []
    for md in files:
        if md.stem in ignored_stems:
            continue
        rp = rel_path(md, vault_dir)
        try:
            content = md.read_text(errors='replace')
        except Exception:
            content = ''
        fm, _, _ = parse_frontmatter(content)
        if fm is None:
            fm = {}
        records.append({
            'rp': rp, 'stem': md.stem,
            'domain': str(fm.get('domain') or infer_domain(rp, schema)),
            'type': str(fm.get('type') or infer_type(rp, schema)),
            'fm': fm,
        })

    # union-find over record indices
    parent = list(range(len(records)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    # seed: exact (stem, domain, type)
    exact = defaultdict(list)
    for i, r in enumerate(records):
        exact[(r['stem'], r['domain'], r['type'])].append(i)
    for idxs in exact.values():
        for j in idxs[1:]:
            union(idxs[0], j)

    # entity-identity: opt-in via schema `identity` block
    if schema.get('identity'):
        ident = get_identity_config(schema)
        ignore = set(ident['ignore_values'])
        by_key = defaultdict(list)
        for i, r in enumerate(records):
            for f in ident['match_fields']:
                v = r['fm'].get(f)
                if v is None or isinstance(v, (list, dict)):
                    continue
                nv = normalize_identity_value(f, v)
                if not nv or nv in ignore:
                    continue
                by_key[(f, nv)].append(i)
        for idxs in by_key.values():
            # generic/shared value (too many cards) → don't group
            if len(idxs) < 2 or len(idxs) > ident['max_shared']:
                continue
            for a in range(len(idxs)):
                for b in range(a + 1, len(idxs)):
                    ia, ib = idxs[a], idxs[b]
                    if ident['same_type_only'] and records[ia]['type'] != records[ib]['type']:
                        continue
                    if ident['same_domain_only'] and records[ia]['domain'] != records[ib]['domain']:
                        continue
                    union(ia, ib)

    # assemble components with >1 member; key = first member's (stem, domain, type),
    # which is unique per component (a given tuple lives in exactly one component).
    comps = defaultdict(list)
    for i in range(len(records)):
        comps[find(i)].append(i)

    result = {}
    for idxs in comps.values():
        if len(idxs) < 2:
            continue
        rep = records[idxs[0]]
        result[(rep['stem'], rep['domain'], rep['type'])] = [records[i]['rp'] for i in idxs]
    return result


# ─── WIKILINKS ─────────────────────────────────────────────
def extract_wikilinks(text: str) -> list[tuple[str, str]]:
    """Extract wikilinks as [(target, display_name), ...].
    Handles [[target]], [[target|display]], and [[target#heading]]."""
    results = []
    for m in re.finditer(r'\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]', text):
        target = m.group(1).strip()
        # Strip #anchor — file target only
        if '#' in target:
            target = target.split('#')[0].strip()
        if not target:
            continue
        display = m.group(2) or target
        results.append((target, display.strip()))
    return results


# ─── DECAY ─────────────────────────────────────────────────
def calc_relevance(days_since_access: int, schema: dict,
                   access_count: int = 1, file_type: str = '') -> float:
    """Ebbinghaus-inspired: more retrievals = slower forgetting.
    strength = 1 + ln(access_count) → effective_rate = rate / strength
    """
    from math import log
    config = get_decay_config(schema)
    # Domain-specific rate or default (filter _comment keys)
    domain_rates = {k: v for k, v in config.get('domain_rates', {}).items()
                    if k != '_comment'}
    rate = domain_rates.get(file_type, config.get('rate', 0.015))
    floor = config.get('floor', 0.1)
    # Ebbinghaus spacing effect
    strength = 1.0 + log(max(access_count, 1))
    effective_rate = rate / strength
    return max(floor, round(1.0 - effective_rate * days_since_access, 3))


def calc_tier(days_since_access: int, schema: dict, current_tier: str = '') -> str:
    """Calculate tier based on days since last access."""
    if current_tier == 'core':
        return 'core'  # never auto-demoted
    config = get_decay_config(schema)
    tiers = config.get('tiers', {'active': 7, 'warm': 21, 'cold': 60})
    if days_since_access <= tiers.get('active', 7):
        return 'active'
    if days_since_access <= tiers.get('warm', 21):
        return 'warm'
    if days_since_access <= tiers.get('cold', 60):
        return 'cold'
    return 'archive'


def days_since(date_str: str) -> int:
    """Days between a date string and today."""
    if not date_str:
        return 999
    try:
        dt = datetime.strptime(date_str[:10], '%Y-%m-%d').date()
        return (date.today() - dt).days
    except (ValueError, TypeError):
        return 999
