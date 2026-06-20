#!/usr/bin/env python3
"""
autograph research — helper for /autograph:research slash command.

Two subcommands:

    plan   <vault>                               → gate + small manifests for 3–5 exploration agents
    reduce <vault> <observations> <answers>      → schema draft from agents + user Q&A

The orchestration (spawning agents, asking users) lives in commands/research.md.
This script only does deterministic work: file walks, bin-packing, schema synthesis.
"""

import json
import sys
from pathlib import Path
from collections import Counter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import walk_vault, rel_path, parse_frontmatter  # noqa: E402

MAX_AGENTS = 5
MAX_FILES_PER_AGENT = 20
SAMPLE_TITLES = 5

# ─── GATE ─────────────────────────────────────────────────

def gate(vault_dir: Path) -> dict:
    """Classify vault as empty / chaos / structured."""
    files = walk_vault(vault_dir)
    total = len(files)
    folders = {rel_path(f, vault_dir).split('/')[0] for f in files if '/' in rel_path(f, vault_dir)}
    has_schema = (vault_dir / 'schema.json').exists()

    fm_hits = 0
    typed_hits = 0
    for md in files[:500]:
        try:
            fm, _, _ = parse_frontmatter(md.read_text(errors='replace'))
        except Exception:
            continue
        if fm:
            fm_hits += 1
            if fm.get('type') or fm.get('domain'):
                typed_hits += 1

    sampled = min(total, 500)
    fm_coverage = (fm_hits / sampled) if sampled else 0.0
    typed_coverage = (typed_hits / sampled) if sampled else 0.0

    if total <= 20:
        verdict = 'empty'
    elif has_schema and typed_coverage >= 0.3:
        verdict = 'structured'
    elif len(folders) >= 3 and typed_coverage >= 0.3:
        verdict = 'structured'
    else:
        verdict = 'chaos'

    return {
        'files_total': total,
        'folders_total': len(folders),
        'has_schema_json': has_schema,
        'frontmatter_coverage': round(fm_coverage, 3),
        'typed_coverage': round(typed_coverage, 3),
        'verdict': verdict,
    }


# ─── PLAN ─────────────────────────────────────────────────

def _bin_pack(files: list[Path], vault_dir: Path, max_agents: int, max_per_agent: int) -> list[list[str]]:
    """Group files by top folder, then spread across up to max_agents buckets."""
    by_folder: dict[str, list[str]] = {}
    for f in files:
        rp = rel_path(f, vault_dir)
        top = rp.split('/')[0] if '/' in rp else '_root'
        by_folder.setdefault(top, []).append(rp)

    # Sort folders largest-first so each agent gets a balanced mix.
    folders = sorted(by_folder, key=lambda f: -len(by_folder[f]))
    buckets: list[list[str]] = [[] for _ in range(max_agents)]
    i = 0
    for folder in folders:
        for path in by_folder[folder]:
            # Round-robin into buckets that still have room.
            for _ in range(max_agents):
                if len(buckets[i % max_agents]) < max_per_agent:
                    buckets[i % max_agents].append(path)
                    i += 1
                    break
                i += 1
            else:
                break  # all buckets full

    return [b for b in buckets if b]


def _sample_titles(files: list[Path], n: int) -> list[str]:
    titles = []
    for md in files[: n * 3]:
        titles.append(md.stem)
        if len(titles) >= n:
            break
    return titles


def cmd_plan(vault_dir: Path) -> dict:
    vault_dir = vault_dir.resolve()
    g = gate(vault_dir)
    files = walk_vault(vault_dir)

    manifests = []
    if g['verdict'] == 'chaos':
        buckets = _bin_pack(files, vault_dir, MAX_AGENTS, MAX_FILES_PER_AGENT)
        for idx, bucket in enumerate(buckets, 1):
            manifests.append({
                'agent_id': f'explorer-{idx:02d}',
                'file_count': len(bucket),
                'files': bucket,
            })

    folder_counts = Counter()
    for f in files:
        rp = rel_path(f, vault_dir)
        folder_counts[rp.split('/')[0] if '/' in rp else '_root'] += 1

    return {
        'vault_dir': str(vault_dir),
        'gate': g,
        'top_folders': folder_counts.most_common(10),
        'sample_titles': _sample_titles(files, SAMPLE_TITLES),
        'manifests': manifests,
        'agent_prompt_template': (
            "You are a vault exploration agent. Read the files listed below in full "
            "and return ONE JSON object (no prose) with fields: observed_themes "
            "(5-10 short tags), entity_types (list of kinds you see: person, project, "
            "note, meeting, etc.), frontmatter_fields (fields actually used in "
            "frontmatter), language (ru/en/mixed), folder_semantics (object mapping "
            "folder -> one-line purpose), sample_titles (5 titles). Focus on patterns, "
            "not per-file classification. Keep under 400 words total.\n\nFILES:\n{files}"
        ),
    }


# ─── REDUCE ───────────────────────────────────────────────

DEFAULT_STATUS_SETS = {
    'minimal': ['active', 'done'],
    'standard': ['active', 'draft', 'done', 'archived'],
    'full': ['active', 'draft', 'in-progress', 'blocked', 'done', 'archived'],
}

DEFAULT_DECAY_PROFILES = {
    'fast': {'rate': 0.025, 'tiers': {'active': 5, 'warm': 14, 'cold': 30}},
    'balanced': {'rate': 0.015, 'tiers': {'active': 7, 'warm': 21, 'cold': 60}},
    'slow': {'rate': 0.008, 'tiers': {'active': 14, 'warm': 45, 'cold': 120}},
}


def _merge_observations(observations: list[dict]) -> dict:
    themes = Counter()
    entity_types = Counter()
    fm_fields = Counter()
    languages = Counter()
    folder_semantics: dict[str, list[str]] = {}

    for obs in observations:
        for t in obs.get('observed_themes', []) or []:
            themes[str(t).lower()] += 1
        for et in obs.get('entity_types', []) or []:
            entity_types[str(et).lower()] += 1
        for f in obs.get('frontmatter_fields', []) or []:
            fm_fields[str(f).lower()] += 1
        lang = obs.get('language')
        if lang:
            languages[str(lang).lower()] += 1
        for folder, purpose in (obs.get('folder_semantics') or {}).items():
            folder_semantics.setdefault(folder, []).append(str(purpose))

    return {
        'themes': themes,
        'entity_types': entity_types,
        'frontmatter_fields': fm_fields,
        'languages': languages,
        'folder_semantics': folder_semantics,
    }


def cmd_reduce(vault_dir: Path, observations_path: Path, answers_path: Path) -> dict:
    observations = json.loads(observations_path.read_text())
    if isinstance(observations, dict):
        observations = [observations]
    answers = json.loads(answers_path.read_text())

    merged = _merge_observations(observations)

    # User answers drive the taxonomy — observations are hints only.
    purpose = (answers.get('purpose') or 'mixed').lower()
    ambition = (answers.get('ambition') or 'standard').lower()
    declared_domains = answers.get('domains') or []
    status_choice = (answers.get('status_profile') or 'standard').lower()
    decay_choice = (answers.get('decay_profile') or 'balanced').lower()
    domain_map = answers.get('domain_map') or {}

    # node_types: intersect user ambition with observed entity_types.
    ambition_caps = {'minimal': 5, 'standard': 10, 'full': 15}
    cap = ambition_caps.get(ambition, 10)
    candidate_types = [t for t, _ in merged['entity_types'].most_common() if t.isidentifier()]
    if 'note' not in candidate_types:
        candidate_types.insert(0, 'note')
    node_types = {}
    for t in candidate_types[:cap]:
        node_types[t] = {'status': DEFAULT_STATUS_SETS.get(status_choice, DEFAULT_STATUS_SETS['standard'])}

    # domain_inference: prefer user-provided map, fall back to declared domains on top folders.
    domain_inference = dict(domain_map)
    for folder in merged['folder_semantics']:
        if folder in domain_inference or folder == '_root':
            continue
        if declared_domains:
            domain_inference[f'{folder}/'] = declared_domains[0]

    decay = DEFAULT_DECAY_PROFILES.get(decay_choice, DEFAULT_DECAY_PROFILES['balanced'])

    schema = {
        '_generated_by': 'autograph /research',
        '_purpose': purpose,
        '_ambition': ambition,
        'node_types': node_types,
        'type_aliases': {},
        'field_fixes': {},
        'domain_inference': domain_inference,
        'path_type_hints': {},
        'status_order': {s: i for i, s in enumerate(
            DEFAULT_STATUS_SETS.get(status_choice, DEFAULT_STATUS_SETS['standard'])
        )},
        'status_defaults': {'default': 'active', 'type': 'status'},
        'richness_fields': {'bonus_fields': sorted(merged['frontmatter_fields'])[:10]},
        'entity_extraction': {'noise_words': ['TODO', 'FIX', 'NOTE', 'WIP']},
        'decay': {
            'rate': decay['rate'],
            'floor': 0.1,
            'tiers': decay['tiers'],
            'domain_rates': {},
        },
        'ignore_tags': [],
    }
    return schema


# ─── MAIN ─────────────────────────────────────────────────

USAGE = """\
Usage:
    research.py plan <vault-dir>
    research.py reduce <vault-dir> <observations.json> <user-answers.json>
"""


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        sys.stdout.write(USAGE)
        sys.exit(0)

    cmd = args[0]
    if cmd == 'plan':
        if len(args) < 2:
            sys.stderr.write(USAGE)
            sys.exit(1)
        vault_dir = Path(args[1])
        if not vault_dir.is_dir():
            sys.stderr.write(f"Not a directory: {vault_dir}\n")
            sys.exit(1)
        result = cmd_plan(vault_dir)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2))
        sys.stdout.write('\n')
        return

    if cmd == 'reduce':
        if len(args) < 4:
            sys.stderr.write(USAGE)
            sys.exit(1)
        vault_dir = Path(args[1])
        observations_path = Path(args[2])
        answers_path = Path(args[3])
        for p in (observations_path, answers_path):
            if not p.exists():
                sys.stderr.write(f"Missing: {p}\n")
                sys.exit(1)
        schema = cmd_reduce(vault_dir, observations_path, answers_path)
        sys.stdout.write(json.dumps(schema, ensure_ascii=False, indent=2))
        sys.stdout.write('\n')
        return

    sys.stderr.write(f"Unknown subcommand: {cmd}\n")
    sys.stderr.write(USAGE)
    sys.exit(1)


if __name__ == '__main__':
    main()
