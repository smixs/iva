#!/usr/bin/env python3
"""
autograph swarm_reduce — consolidate Wave 1 classifications and validate Wave 2 schema.

Two commands:
  prepare  — read JSONL classifications, count frequencies, output consolidation.json
  finalize — validate Wave 2 agent output, write schema.json

Usage:
  python3 swarm_reduce.py prepare <vault-dir> [discovery.json] [draft-schema.json]
  python3 swarm_reduce.py finalize <wave2-output.json> [output-schema.json]
"""

import json
import sys
from pathlib import Path
from collections import Counter
from datetime import datetime

# ─── PROMPT TEMPLATE ──────────────────────────────────────

WAVE2_PROMPT_TEMPLATE = """\
You are a schema architect. Produce a minimal schema.json.

Rules:
- Target 5-10 node_types. Fewer is better. Merge similar types.
- Types with <5 files: merge into broader type or drop.
- Novel types (not seed) need >10 files to survive.
- All 11 schema sections must be present:
  node_types, type_aliases, field_fixes, domain_inference,
  path_type_hints, status_order, status_defaults, richness_fields,
  entity_extraction, decay, ignore_tags
- Output ONLY valid JSON, no explanations.

Inputs provided: type frequencies, domain frequencies, all classifications,
draft schema as starting point, discovery metadata.
"""

REQUIRED_SCHEMA_SECTIONS = frozenset({
    'node_types', 'type_aliases', 'field_fixes', 'domain_inference',
    'path_type_hints', 'status_order', 'status_defaults', 'richness_fields',
    'entity_extraction', 'decay', 'ignore_tags',
})

# ─── PREPARE ──────────────────────────────────────────────

def read_classifications(swarm_dir: Path) -> list[dict]:
    """Read all JSONL files from classifications/ directory."""
    classifications_dir = swarm_dir / 'classifications'
    if not classifications_dir.exists():
        return []

    results = []
    malformed = 0
    for jsonl_file in sorted(classifications_dir.glob('*.jsonl')):
        for line_num, line in enumerate(jsonl_file.read_text().splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if 'path' in entry:
                    results.append(entry)
                else:
                    malformed += 1
                    print(f"WARN: missing 'path' in {jsonl_file.name}:{line_num}",
                          file=sys.stderr)
            except json.JSONDecodeError:
                malformed += 1
                print(f"WARN: malformed JSON in {jsonl_file.name}:{line_num}",
                      file=sys.stderr)

    if malformed:
        print(f"Skipped {malformed} malformed lines.", file=sys.stderr)
    return results


def count_frequencies(classifications: list[dict], seed_types: list[str] | None = None
                      ) -> dict:
    """Count type and domain frequencies from classifications."""
    type_freq: Counter = Counter()
    domain_freq: Counter = Counter()
    confidence_dist: Counter = Counter()
    novel_types: Counter = Counter()

    seed_set = set(seed_types or [])

    for entry in classifications:
        ptype = entry.get('proposed_type', 'note')
        pdomain = entry.get('proposed_domain', 'personal')
        conf = entry.get('confidence', 'medium')

        type_freq[ptype] += 1
        domain_freq[pdomain] += 1
        confidence_dist[conf] += 1

        if ptype not in seed_set:
            novel_types[ptype] += 1

    return {
        'type_frequency': dict(type_freq.most_common()),
        'domain_frequency': dict(domain_freq.most_common()),
        'confidence_distribution': dict(confidence_dist.most_common()),
        'novel_types': dict(novel_types.most_common()),
        'total_classified': len(classifications),
    }


def prepare_consolidation(vault_dir: Path, discovery_path: Path | None = None,
                          draft_schema_path: Path | None = None) -> dict:
    """Read Wave 1 outputs, produce consolidation.json for Wave 2."""
    vault_dir = vault_dir.resolve()
    swarm_dir = vault_dir / '.graph' / 'swarm'

    # Read swarm meta for seed types
    meta_path = swarm_dir / 'swarm-meta.json'
    meta = {}
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
    seed_types = meta.get('seed_types', ['note'])

    # Read all classifications
    classifications = read_classifications(swarm_dir)
    if not classifications:
        print("No classifications found. Run Wave 1 agents first.", file=sys.stderr)
        return {}

    # Count frequencies
    frequencies = count_frequencies(classifications, seed_types)

    # Load optional inputs
    discovery = None
    if discovery_path and discovery_path.exists():
        discovery = json.loads(discovery_path.read_text())

    draft_schema = None
    if draft_schema_path and draft_schema_path.exists():
        draft_schema = json.loads(draft_schema_path.read_text())

    # Build consolidation
    consolidation = {
        'created_at': datetime.now().isoformat(),
        'total_classified': frequencies['total_classified'],
        'type_frequency': frequencies['type_frequency'],
        'domain_frequency': frequencies['domain_frequency'],
        'confidence_distribution': frequencies['confidence_distribution'],
        'novel_types': frequencies['novel_types'],
        'seed_types': seed_types,
        'classifications': classifications,
        'discovery_meta': discovery.get('meta', {}) if discovery else {},
        'draft_schema': draft_schema,
        'wave2_prompt_template': WAVE2_PROMPT_TEMPLATE,
    }

    # Write consolidation.json
    consolidation_path = swarm_dir / 'consolidation.json'
    consolidation_path.write_text(
        json.dumps(consolidation, ensure_ascii=False, indent=2) + '\n'
    )

    # Print summary
    print(f"Consolidation: {frequencies['total_classified']} classifications")
    print(f"Types: {frequencies['type_frequency']}")
    print(f"Domains: {frequencies['domain_frequency']}")
    print(f"Novel types: {frequencies['novel_types']}")
    print(f"Output: {consolidation_path}")

    return consolidation


# ─── FINALIZE ─────────────────────────────────────────────

def validate_schema(schema: dict) -> list[str]:
    """Validate schema from Wave 2 agent. Returns list of errors (empty = valid)."""
    errors = []

    # Check required sections
    # Note: region_fixes is optional (not in REQUIRED_SCHEMA_SECTIONS)
    missing = REQUIRED_SCHEMA_SECTIONS - set(schema.keys())
    if missing:
        errors.append(f"Missing sections: {sorted(missing)}")

    # Validate node_types
    node_types = schema.get('node_types', {})
    nt_clean = {k: v for k, v in node_types.items() if k != '_comment'}

    if not nt_clean:
        errors.append("node_types is empty")
    elif len(nt_clean) > 15:
        errors.append(f"Too many node_types: {len(nt_clean)} (max 15)")
    elif len(nt_clean) < 3:
        errors.append(f"Too few node_types: {len(nt_clean)} (min 3)")

    for type_name, type_def in nt_clean.items():
        if not isinstance(type_def, dict):
            errors.append(f"node_type '{type_name}' is not a dict")
            continue
        for field in ('description', 'required', 'status'):
            if field not in type_def:
                errors.append(f"node_type '{type_name}' missing '{field}'")

    # Validate type_aliases targets exist
    aliases = schema.get('type_aliases', {})
    for alias, target in aliases.items():
        if alias == '_comment':
            continue
        if target not in nt_clean:
            errors.append(f"type_alias '{alias}' → '{target}' but '{target}' not in node_types")

    # Validate status_order covers all statuses used in node_types
    status_order = schema.get('status_order', {})
    so_clean = {k: v for k, v in status_order.items() if k != '_comment'}
    all_statuses = set()
    for td in nt_clean.values():
        if isinstance(td, dict):
            all_statuses.update(td.get('status', []))
    missing_statuses = all_statuses - set(so_clean.keys())
    if missing_statuses:
        errors.append(f"status_order missing statuses: {sorted(missing_statuses)}")

    # Validate decay config
    decay = schema.get('decay', {})
    if 'rate' not in decay or 'floor' not in decay:
        errors.append("decay missing 'rate' or 'floor'")

    return errors


def finalize_schema(wave2_path: Path, output_path: Path | None = None) -> bool:
    """Validate and write final schema.json. Returns True on success."""
    if not wave2_path.exists():
        print(f"File not found: {wave2_path}", file=sys.stderr)
        return False

    try:
        schema = json.loads(wave2_path.read_text())
    except json.JSONDecodeError as e:
        print(f"Invalid JSON: {e}", file=sys.stderr)
        return False

    errors = validate_schema(schema)

    if errors:
        print("Schema validation FAILED:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)

        # Save invalid draft for debugging
        invalid_path = wave2_path.parent / 'schema-draft-invalid.json'
        invalid_path.write_text(json.dumps(schema, ensure_ascii=False, indent=2) + '\n')
        print(f"Raw draft saved to: {invalid_path}", file=sys.stderr)
        return False

    # Clean up _comment fields from output
    output = json.dumps(schema, ensure_ascii=False, indent=2) + '\n'

    if output_path:
        output_path.write_text(output)
        print(f"Schema written to {output_path}")
    else:
        sys.stdout.write(output)

    node_count = len({k for k in schema.get('node_types', {}) if k != '_comment'})
    print(f"Valid schema: {node_count} node types", file=sys.stderr)
    return True


# ─── MAIN ─────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    if len(args) < 2 or args[0] in ('-h', '--help'):
        print("Usage:", file=sys.stderr)
        print("  swarm_reduce.py prepare <vault-dir> [discovery.json] [draft-schema.json]",
              file=sys.stderr)
        print("  swarm_reduce.py finalize <wave2-output.json> [output-schema.json]",
              file=sys.stderr)
        sys.exit(1)

    command = args[0]

    if command == 'prepare':
        vault_dir = Path(args[1])
        if not vault_dir.is_dir():
            print(f"Not a directory: {vault_dir}", file=sys.stderr)
            sys.exit(1)
        discovery_path = Path(args[2]) if len(args) > 2 else None
        draft_path = Path(args[3]) if len(args) > 3 else None
        result = prepare_consolidation(vault_dir, discovery_path, draft_path)
        if not result:
            sys.exit(1)

    elif command == 'finalize':
        wave2_path = Path(args[1])
        output_path = Path(args[2]) if len(args) > 2 else None
        ok = finalize_schema(wave2_path, output_path)
        sys.exit(0 if ok else 1)

    else:
        print(f"Unknown command: {command}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
