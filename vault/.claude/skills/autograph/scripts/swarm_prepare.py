#!/usr/bin/env python3
"""
autograph swarm_prepare — split vault into batches for parallel LLM classification.

Map phase: walks vault, estimates tokens per file, greedy bin-packs into batches
that fit a token budget, writes manifests for Wave 1 agents.

Usage: python3 swarm_prepare.py <vault-dir> [discovery.json] [--budget 50000]
"""

import json
import sys
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import walk_vault, rel_path  # noqa: E402

# ─── PROMPT TEMPLATE ──────────────────────────────────────

WAVE1_PROMPT_TEMPLATE = """\
You are a file classifier. Read each file, output ONE JSONL line per file.

SEED TYPES (prefer these): {seed_types}
SEED DOMAINS (prefer these): {seed_domains}

Rules:
- Use seed type if it fits. Only propose new if NONE fit.
- Output ONLY JSONL lines, no explanations.
- Empty/unreadable files: type="note", domain="personal", confidence="low"

Format per line:
{{"path":"<path>","proposed_type":"<type>","proposed_domain":"<domain>","summary":"<120 chars>","seed_match":true,"confidence":"high|medium|low"}}

FILES:
{file_list}
"""

# ─── HELPERS ──────────────────────────────────────────────

def estimate_tokens(file_path: Path) -> int:
    """Estimate token count from file size (~4 bytes per token)."""
    try:
        return file_path.stat().st_size // 4
    except OSError:
        return 0


def top_folder(rel: str) -> str:
    """Extract top-level folder from relative path, or '_root' for root files."""
    parts = Path(rel).parts
    return parts[0] if len(parts) > 1 else '_root'


def extract_seed_types(discovery: dict | None) -> list[str]:
    """Extract seed types from discovery JSON enums."""
    if not discovery:
        return ['note']
    enums = discovery.get('enums', {})
    type_vals = enums.get('type', {}).get('values', {})
    if type_vals:
        return sorted(type_vals, key=lambda t: -type_vals[t])
    return ['note']


def extract_seed_domains(discovery: dict | None) -> list[str]:
    """Extract seed domains from discovery JSON folder structure."""
    if not discovery:
        return ['personal']
    folders = discovery.get('folder_structure', {})
    if not folders:
        return ['personal']
    # Use folder names as domain hints
    domains = set()
    for folder in folders:
        low = folder.lower().rstrip('/')
        if low and low != 'root':
            domains.add(low)
    return sorted(domains) if domains else ['personal']


def augment_seeds_from_schema(discovery: dict | None, seed_types: list[str]) -> list[str]:
    """Try to augment seed types using generate_schema.build_node_types if available."""
    try:
        from generate_schema import build_node_types
        enums = (discovery or {}).get('enums', {})
        node_types = build_node_types(enums)
        for t in node_types:
            if t not in seed_types:
                seed_types.append(t)
    except (ImportError, Exception):
        pass
    return seed_types


def bin_pack_batches(file_entries: list[dict], budget: int) -> list[list[dict]]:
    """Greedy bin-packing: group files into batches respecting token budget.

    Groups by top-level folder first (keeps related files together),
    then packs greedily into budget-sized batches.
    """
    # Group by folder
    by_folder: dict[str, list[dict]] = {}
    for entry in file_entries:
        folder = entry['folder']
        by_folder.setdefault(folder, []).append(entry)

    # Sort folders by total tokens descending (largest folders split first)
    folder_order = sorted(by_folder, key=lambda f: sum(e['tokens'] for e in by_folder[f]), reverse=True)

    batches: list[list[dict]] = []
    current_batch: list[dict] = []
    current_tokens = 0

    for folder in folder_order:
        for entry in by_folder[folder]:
            tok = entry['tokens']
            # Single file exceeds budget → it gets its own batch
            if tok >= budget:
                if current_batch:
                    batches.append(current_batch)
                    current_batch = []
                    current_tokens = 0
                batches.append([entry])
                continue

            if current_tokens + tok > budget and current_batch:
                batches.append(current_batch)
                current_batch = []
                current_tokens = 0

            current_batch.append(entry)
            current_tokens += tok

    if current_batch:
        batches.append(current_batch)

    return batches


# ─── MAIN ─────────────────────────────────────────────────

def prepare(vault_dir: Path, discovery_path: Path | None = None, budget: int = 50000) -> dict:
    """Main prepare logic. Returns swarm-meta dict."""
    vault_dir = vault_dir.resolve()

    # Load discovery JSON if provided
    discovery = None
    if discovery_path and discovery_path.exists():
        discovery = json.loads(discovery_path.read_text())

    # Walk vault and build file entries
    md_files = walk_vault(vault_dir)
    file_entries = []
    for md in md_files:
        rp = rel_path(md, vault_dir)
        tokens = estimate_tokens(md)
        file_entries.append({
            'path': rp,
            'folder': top_folder(rp),
            'tokens': tokens,
        })

    if not file_entries:
        print("No files found in vault.", file=sys.stderr)
        return {'total_batches': 0, 'total_files': 0}

    # Extract seeds
    seed_types = extract_seed_types(discovery)
    seed_types = augment_seeds_from_schema(discovery, seed_types)
    seed_domains = extract_seed_domains(discovery)

    # Bin-pack into batches
    batches = bin_pack_batches(file_entries, budget)

    # Create output directories
    swarm_dir = vault_dir / '.graph' / 'swarm'
    manifests_dir = swarm_dir / 'manifests'
    classifications_dir = swarm_dir / 'classifications'
    manifests_dir.mkdir(parents=True, exist_ok=True)
    classifications_dir.mkdir(parents=True, exist_ok=True)

    # Write manifests
    total_batches = len(batches)
    for i, batch in enumerate(batches):
        batch_id = f"batch-{i+1:03d}"
        manifest = {
            'batch_id': batch_id,
            'vault_dir': str(vault_dir),
            'total_batches': total_batches,
            'files': [e['path'] for e in batch],
            'file_count': len(batch),
            'estimated_tokens': sum(e['tokens'] for e in batch),
            'seed_types': seed_types,
            'seed_domains': seed_domains,
        }
        manifest_path = manifests_dir / f'{batch_id}.json'
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

    # Write swarm-meta.json
    total_tokens = sum(e['tokens'] for e in file_entries)
    meta = {
        'vault_dir': str(vault_dir),
        'total_files': len(file_entries),
        'total_tokens': total_tokens,
        'total_batches': total_batches,
        'budget_per_batch': budget,
        'seed_types': seed_types,
        'seed_domains': seed_domains,
        'discovery_path': str(discovery_path) if discovery_path else None,
        'created_at': datetime.now().isoformat(),
        'wave1_prompt_template': WAVE1_PROMPT_TEMPLATE,
    }
    meta_path = swarm_dir / 'swarm-meta.json'
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + '\n')

    # Print summary
    print(f"Swarm prepared: {total_batches} batches, {len(file_entries)} files, ~{total_tokens} tokens")
    print(f"Budget per batch: {budget} tokens")
    print(f"Seed types: {seed_types}")
    print(f"Seed domains: {seed_domains}")
    print(f"Manifests: {manifests_dir}")
    for i, batch in enumerate(batches):
        batch_tokens = sum(e['tokens'] for e in batch)
        print(f"  batch-{i+1:03d}: {len(batch)} files, ~{batch_tokens} tokens")

    return meta


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print("Usage: swarm_prepare.py <vault-dir> [discovery.json] [--budget N]",
              file=sys.stderr)
        sys.exit(1)

    vault_dir = Path(args[0])
    if not vault_dir.is_dir():
        print(f"Not a directory: {vault_dir}", file=sys.stderr)
        sys.exit(1)

    discovery_path = None
    budget = 50000

    i = 1
    while i < len(args):
        if args[i] == '--budget' and i + 1 < len(args):
            budget = int(args[i + 1])
            i += 2
        else:
            discovery_path = Path(args[i])
            i += 1

    prepare(vault_dir, discovery_path, budget)


if __name__ == '__main__':
    main()
