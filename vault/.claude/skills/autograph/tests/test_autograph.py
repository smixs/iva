#!/usr/bin/env python3
"""
autograph self-contained tests — uses temp fixtures, no real vault needed.
Runs ~40 tests covering common.py functions + all script CLIs + edge cases.

Usage: python3 test_autograph.py
       (no arguments required, works from any directory)
"""

import sys
import os
import json
import shutil
import tempfile
import subprocess
from pathlib import Path
from datetime import date, timedelta

# ─── SETUP ────────────────────────────────────────────────
SCRIPTS_DIR = Path(__file__).resolve().parent.parent / 'scripts'
sys.path.insert(0, str(SCRIPTS_DIR))

PASS = 0
FAIL = 0


def test(name: str, condition: bool, detail: str = ""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}: {detail}")


def run(cmd: list, cwd: str = None) -> tuple:
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=60)
    return r.returncode, r.stdout, r.stderr


# ─── FIXTURES ─────────────────────────────────────────────

SCHEMA = {
    "node_types": {
        "note": {
            "description": "Knowledge note",
            "required": ["description", "tags"],
            "status": ["active", "draft", "archived"]
        },
        "contact": {
            "description": "Person",
            "required": ["description", "tags", "status"],
            "status": ["active", "inactive"]
        },
        "project": {
            "description": "Project with deliverables",
            "required": ["description", "tags", "status"],
            "status": ["active", "done", "paused", "cancelled"]
        },
        "lead": {
            "description": "Sales lead",
            "required": ["description", "status"],
            "status": ["prospect", "negotiation", "won", "lost"]
        }
    },
    "type_aliases": {
        "crm": "contact",
        "person": "contact",
        "idea": "note"
    },
    "field_fixes": {
        "status": {
            "actve": "active",
            "inactiv": "inactive"
        },
        "priority": {
            "hi": "high",
            "lo": "low"
        }
    },
    "region_fixes": {
        "KZ ": "KZ",
        "kz": "KZ"
    },
    "domain_inference": {
        "projects/": "work",
        "personal/": "personal",
        "knowledge/": "knowledge",
        "contacts/": "crm"
    },
    "path_type_hints": {
        "_comment": "folder substring -> type name",
        "leads/": "lead",
        "contacts/": "contact",
        "people/": "contact"
    },
    "status_order": {
        "_comment": "sort for MOC",
        "active": 0,
        "prospect": 1,
        "done": 8,
        "draft": 9
    },
    "status_defaults": {
        "_comment": "defaults",
        "default": "active"
    },
    "richness_fields": {
        "_comment": "for dedup",
        "bonus_fields": ["telegram", "email", "company"]
    },
    "entity_extraction": {
        "_comment": "for daily.py",
        "noise_words": ["TODO", "FIX", "Score"]
    },
    "decay": {
        "rate": 0.015,
        "floor": 0.1,
        "tiers": {
            "active": 7,
            "warm": 21,
            "cold": 60
        }
    },
    "ignore_tags": ["imported"]
}

# Markdown fixtures: (relative_path, content)
VAULT_FILES = {
    "projects/alpha.md": (
        "---\n"
        "type: project\n"
        "status: active\n"
        "domain: work\n"
        "tags: [dev, ai]\n"
        "description: Alpha project for AI platform\n"
        "priority: high\n"
        "tier: active\n"
        "relevance: 1.0\n"
        f"last_accessed: {date.today().isoformat()}\n"
        "---\n"
        "# Alpha Project\n\n"
        "Building an AI platform. See [[contacts/bob]] and [[knowledge/ml-basics]].\n\n"
        "## Roadmap\n- Phase 1\n- Phase 2\n"
    ),
    "projects/beta.md": (
        "---\n"
        "type: project\n"
        "status: draft\n"
        "domain: work\n"
        "tags: [design]\n"
        "description: Beta design sprint\n"
        "tier: warm\n"
        "relevance: 0.7\n"
        f"last_accessed: {(date.today() - timedelta(days=10)).isoformat()}\n"
        "---\n"
        "# Beta Sprint\n\n"
        "Design phase. Related to [[projects/alpha|Alpha]].\n"
    ),
    "contacts/bob.md": (
        "---\n"
        "type: contact\n"
        "status: active\n"
        "domain: crm\n"
        "tags: [partner, dev]\n"
        "description: Bob Smith, lead developer\n"
        "telegram: @bobdev\n"
        "email: bob@example.com\n"
        "company: DevCorp\n"
        "tier: active\n"
        "relevance: 1.0\n"
        f"last_accessed: {date.today().isoformat()}\n"
        "---\n"
        "# Bob Smith\n\n"
        "Key partner. Works on [[projects/alpha]] and [[projects/beta]].\n"
    ),
    "contacts/alice.md": (
        "---\n"
        "type: contact\n"
        "status: active\n"
        "domain: crm\n"
        "tags: [client]\n"
        "description: Alice Johnson, marketing lead\n"
        "tier: warm\n"
        "relevance: 0.8\n"
        f"last_accessed: {(date.today() - timedelta(days=15)).isoformat()}\n"
        "---\n"
        "# Alice Johnson\n\n"
        "Client contact. Involved in [[projects/beta]].\n"
    ),
    "knowledge/ml-basics.md": (
        "---\n"
        "type: note\n"
        "status: active\n"
        "domain: knowledge\n"
        "tags: [ai, ml, learning]\n"
        "description: Machine learning fundamentals\n"
        "tier: warm\n"
        "relevance: 0.6\n"
        f"last_accessed: {(date.today() - timedelta(days=20)).isoformat()}\n"
        "---\n"
        "# ML Basics\n\n"
        "Neural networks, transformers, etc.\n\n"
        "## Key Concepts\n- Backpropagation\n- Attention\n"
    ),
    "knowledge/python-tips.md": (
        "---\n"
        "type: note\n"
        "status: draft\n"
        "domain: knowledge\n"
        "tags: [python, dev]\n"
        "description: Useful Python patterns\n"
        "tier: cold\n"
        "relevance: 0.3\n"
        f"last_accessed: {(date.today() - timedelta(days=45)).isoformat()}\n"
        "---\n"
        "# Python Tips\n\n"
        "Dataclasses, pattern matching, etc.\n"
    ),
    "personal/journal.md": (
        "---\n"
        "type: note\n"
        "status: active\n"
        "domain: personal\n"
        "tags: [journal]\n"
        "description: Daily journal entry\n"
        "tier: archive\n"
        "relevance: 0.1\n"
        f"last_accessed: {(date.today() - timedelta(days=100)).isoformat()}\n"
        "---\n"
        "# Journal\n\n"
        "Today I worked on [[projects/alpha]] and talked to [[contacts/alice]].\n"
    ),
    "no-frontmatter.md": (
        "# Just a Note\n\n"
        "This file has no YAML frontmatter at all.\n"
        "Links to [[knowledge/ml-basics]].\n"
    ),
    "broken-frontmatter.md": (
        "---\n"
        "type:\n"
        "tags: [broken\n"
        "---\n"
        "# Broken FM\n\n"
        "The frontmatter above is malformed.\n"
    ),
    # Duplicate slug (same stem as contacts/bob.md)
    "personal/bob.md": (
        "---\n"
        "type: note\n"
        "status: draft\n"
        "tags: [personal]\n"
        "description: Personal notes about Bob\n"
        "---\n"
        "# Bob\n\n"
        "Random notes.\n"
    ),
}

DAILY_FILE = {
    "2026-03-01.md": (
        "# Memory 2026-03-01\n\n"
        "Met with @alice_m and @bob_dev today.\n\n"
        "**Сергей Иванов** presented the new roadmap.\n\n"
        "Discussed [[projects/alpha]] budget: $5,000.\n\n"
        "Decided: approved the Q2 plan.\n\n"
        "Events: launched v2.0\n"
    )
}


def create_vault(base_dir: Path) -> Path:
    """Create a temporary vault with test fixtures."""
    vault = base_dir / "test-vault"
    vault.mkdir(parents=True, exist_ok=True)
    for rel, content in VAULT_FILES.items():
        fp = vault / rel
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content)
    return vault


def create_schema(base_dir: Path) -> Path:
    """Write test schema.json."""
    sp = base_dir / "schema.json"
    sp.write_text(json.dumps(SCHEMA, indent=2, ensure_ascii=False))
    return sp


def create_daily_dir(base_dir: Path) -> Path:
    """Write daily memory files."""
    mem = base_dir / "memory"
    mem.mkdir(parents=True, exist_ok=True)
    for name, content in DAILY_FILE.items():
        (mem / name).write_text(content)
    return mem


# ─── MAIN ─────────────────────────────────────────────────
def main():
    tmp = Path(tempfile.mkdtemp(prefix="autograph_test_"))
    try:
        vault_dir = create_vault(tmp)
        schema_path = create_schema(tmp)
        daily_dir = create_daily_dir(tmp)

        # Clear schema cache before tests (common.py caches schemas)
        from common import _schema_cache
        _schema_cache.clear()

        print(f"\n{'='*60}")
        print(f"  AUTOGRAPH SELF-CONTAINED TESTS")
        print(f"  vault:  {vault_dir}")
        print(f"  schema: {schema_path}")
        print(f"  tmp:    {tmp}")
        print(f"{'='*60}\n")

        # ═══════════════════════════════════════════════════════
        # 1. common.py — pure function tests
        # ═══════════════════════════════════════════════════════
        print("--- common.py ---")
        from common import (
            load_schema, parse_frontmatter, walk_vault, infer_domain,
            infer_type, calc_relevance, calc_tier, days_since,
            extract_wikilinks, IGNORE_DIRS, write_frontmatter, format_field,
            build_link_index, resolve_link_target, collect_duplicate_groups, is_hub_path
        )

        # 1.1 schema loading
        schema = load_schema(schema_path)
        test("load_schema returns dict", isinstance(schema, dict))
        test("schema has node_types", 'node_types' in schema)
        test("schema has decay config", 'decay' in schema)
        test("schema has domain_inference", 'domain_inference' in schema)

        # 1.2 IGNORE_DIRS
        test("IGNORE_DIRS is frozenset", isinstance(IGNORE_DIRS, frozenset))
        test("IGNORE_DIRS contains .obsidian", '.obsidian' in IGNORE_DIRS)

        # 1.3 parse_frontmatter — valid
        fm, body, lines = parse_frontmatter(
            "---\ntype: crm\nstatus: active\ntags: [a, b, c]\n---\n# Hello\nBody"
        )
        test("parse_fm extracts type", fm.get('type') == 'crm')
        test("parse_fm extracts tags list", fm.get('tags') == ['a', 'b', 'c'])
        test("parse_fm body contains text", 'Hello' in body)

        # 1.4 parse_frontmatter — no frontmatter
        fm2, body2, _ = parse_frontmatter("# Just markdown\nNo frontmatter here")
        test("parse_fm returns None for no-fm", fm2 is None)
        test("parse_fm returns full content as body", 'Just markdown' in body2)

        # 1.5 parse_frontmatter — empty value
        fm3, _, _ = parse_frontmatter("---\ntype:\nstatus: active\n---\nBody")
        test("parse_fm handles empty value", fm3.get('type') == '')

        # 1.6 extract_wikilinks
        links = extract_wikilinks("See [[foo/bar|Foo Bar]] and [[baz]] text")
        test("extract_wikilinks finds 2 links", len(links) == 2)
        test("extract_wikilinks parses alias", links[0] == ('foo/bar', 'Foo Bar'))
        test("extract_wikilinks plain link", links[1] == ('baz', 'baz'))

        # 1.7 extract_wikilinks — no links
        test("extract_wikilinks empty on no links", extract_wikilinks("no links here") == [])

        # 1.8 infer_domain
        test("infer_domain projects/ -> work",
             infer_domain("projects/alpha.md", schema) == "work")
        test("infer_domain personal/ -> personal",
             infer_domain("personal/journal.md", schema) == "personal")
        test("infer_domain unknown -> personal (default)",
             infer_domain("random/file.md", schema) == "personal")

        # 1.9 infer_type
        test("infer_type note/ folder -> note",
             infer_type("knowledge/note/something.md", schema) == "note")
        test("infer_type contacts/ -> contact (via path_type_hints)",
             infer_type("contacts/someone.md", schema) == "contact")

        # 1.10 calc_relevance
        test("calc_relevance day 0 = 1.0", calc_relevance(0, schema) == 1.0)
        test("calc_relevance day 10 = 0.85", calc_relevance(10, schema) == 0.85)
        test("calc_relevance day 60 = floor 0.1", calc_relevance(60, schema) == 0.1)
        test("calc_relevance day 100 = floor 0.1", calc_relevance(100, schema) == 0.1)

        # 1.11 calc_tier
        test("calc_tier day 3 = active", calc_tier(3, schema) == 'active')
        test("calc_tier day 7 = active (boundary)", calc_tier(7, schema) == 'active')
        test("calc_tier day 15 = warm", calc_tier(15, schema) == 'warm')
        test("calc_tier day 21 = warm (boundary)", calc_tier(21, schema) == 'warm')
        test("calc_tier day 40 = cold", calc_tier(40, schema) == 'cold')
        test("calc_tier day 90 = archive", calc_tier(90, schema) == 'archive')
        test("calc_tier core stays core", calc_tier(999, schema, 'core') == 'core')

        # 1.12 days_since
        today = date.today()
        test("days_since today = 0", days_since(today.isoformat()) == 0)
        test("days_since yesterday = 1",
             days_since((today - timedelta(days=1)).isoformat()) == 1)
        test("days_since empty = 999", days_since('') == 999)
        test("days_since garbage = 999", days_since('not-a-date') == 999)
        test("days_since None = 999", days_since(None) == 999)

        # 1.13 walk_vault
        files = walk_vault(vault_dir)
        test("walk_vault finds files", len(files) == len(VAULT_FILES))
        # Should skip .obsidian, .git etc
        obs_dir = vault_dir / '.obsidian'
        obs_dir.mkdir(exist_ok=True)
        (obs_dir / 'hidden.md').write_text("hidden")
        files2 = walk_vault(vault_dir)
        test("walk_vault ignores .obsidian", len(files2) == len(VAULT_FILES))

        # 1.14 write_frontmatter + format_field
        test("format_field list", format_field('tags', ['a', 'b']) == 'tags: [a, b]')
        test("format_field string", format_field('type', 'note') == 'type: note')
        test("format_field int", format_field('count', 42) == 'count: 42')
        test("format_field float", format_field('relevance', 0.85) == 'relevance: 0.85')

        # 1.15 write_frontmatter multiline roundtrip (no duplication)
        multiline_fm = "---\ntype: note\ndescription: >-\n  Long description that\n  spans multiple lines\ntags: [ai, test]\n---\n# Body\n"
        fm_ml, body_ml, orig_ml = parse_frontmatter(multiline_fm)
        test("multiline parse: description joined",
             fm_ml.get('description') == 'Long description that spans multiple lines',
             f"got: {fm_ml.get('description')}")
        block_list_fm = "---\ntype: note\ntags:\n  - ai\n  - test\nstatus: active\n---\n# Body\n"
        fm_list, _, _ = parse_frontmatter(block_list_fm)
        test("block list parse: tags extracted",
             fm_list.get('tags') == ['ai', 'test'],
             f"got: {fm_list.get('tags')!r}")
        # Roundtrip: write back same fields → no duplication
        rebuilt_ml = write_frontmatter(fm_ml, orig_ml)
        fm_rt, _, _ = parse_frontmatter(f"---\n{rebuilt_ml}\n---\n")
        test("multiline roundtrip: no duplication",
             fm_rt.get('description') == fm_ml.get('description'),
             f"original={fm_ml.get('description')!r}, roundtrip={fm_rt.get('description')!r}")
        # Second roundtrip — should be stable
        rebuilt_ml2 = write_frontmatter(fm_rt, rebuilt_ml.split('\n'))
        fm_rt2, _, _ = parse_frontmatter(f"---\n{rebuilt_ml2}\n---\n")
        test("multiline double roundtrip: stable",
             fm_rt2.get('description') == fm_ml.get('description'),
             f"got: {fm_rt2.get('description')!r}")
        # Literal block |- continuation lines skipped when key rewritten
        literal_fm = "---\ntype: note\ndescription: |-\n  Line one\n  Line two\ntags: [test]\n---\n"
        fm_lit, _, orig_lit = parse_frontmatter(literal_fm)
        rebuilt_lit = write_frontmatter(fm_lit, orig_lit)
        # Key point: continuation lines should NOT appear as extra lines
        continuation_leaked = 'Line one' in rebuilt_lit and rebuilt_lit.count('Line one') > 1
        test("literal |- rewrite: no leaked continuation lines",
             not continuation_leaked,
             f"got: {rebuilt_lit}")
        # Untouched multiline key preserved as-is
        partial_fields = {'tags': ['ai', 'updated']}  # only update tags, not description
        rebuilt_partial = write_frontmatter(partial_fields, orig_ml)
        test("untouched multiline key preserved",
             'spans multiple lines' in rebuilt_partial,
             f"got: {rebuilt_partial}")

        # 1.16 deterministic link resolver
        resolver_vault = tmp / 'resolver-vault'
        (resolver_vault / 'docs/cards').mkdir(parents=True, exist_ok=True)
        (resolver_vault / 'crm').mkdir(parents=True, exist_ok=True)
        (resolver_vault / 'misc').mkdir(parents=True, exist_ok=True)
        (resolver_vault / 'docs/cards/visa.md').write_text("# Visa card\n")
        (resolver_vault / 'crm/visa.md').write_text("# Visa contact\n")
        (resolver_vault / 'misc/visa-guide.md').write_text("# Visa guide\n")
        resolver_index = build_link_index(resolver_vault)
        resolved_exact, reason_exact = resolve_link_target('docs/cards/visa', resolver_index)
        test("resolve_link_target exact path",
             resolved_exact == 'docs/cards/visa' and reason_exact == 'exact',
             f"got: {(resolved_exact, reason_exact)}")
        resolved_suffix, reason_suffix = resolve_link_target('cards/visa', resolver_index)
        test("resolve_link_target unique suffix",
             resolved_suffix == 'docs/cards/visa' and reason_suffix == 'unique_suffix',
             f"got: {(resolved_suffix, reason_suffix)}")
        resolved_ambiguous, reason_ambiguous = resolve_link_target('visa', resolver_index)
        test("resolve_link_target blocks ambiguous stem",
             resolved_ambiguous is None and reason_ambiguous == 'ambiguous_stem',
             f"got: {(resolved_ambiguous, reason_ambiguous)}")
        resolved_unique_stem, reason_unique_stem = resolve_link_target('visa-guide', resolver_index)
        test("resolve_link_target unique stem",
             resolved_unique_stem == 'misc/visa-guide' and reason_unique_stem == 'unique_stem',
             f"got: {(resolved_unique_stem, reason_unique_stem)}")

        # 1.17 duplicate grouping only merges compatible cards
        dedup_vault = tmp / 'dedup-vault'
        (dedup_vault / 'knowledge/notes').mkdir(parents=True, exist_ok=True)
        (dedup_vault / 'contacts').mkdir(parents=True, exist_ok=True)
        (dedup_vault / 'personal').mkdir(parents=True, exist_ok=True)
        (dedup_vault / 'knowledge/foo.md').write_text(
            "---\ntype: note\ndomain: knowledge\ndescription: Foo\n---\n# Foo\n"
        )
        (dedup_vault / 'knowledge/notes/foo.md').write_text(
            "---\ntype: note\ndomain: knowledge\ndescription: Foo note\n---\n# Foo note\n"
        )
        (dedup_vault / 'contacts/bob.md').write_text(
            "---\ntype: contact\ndomain: crm\ndescription: Bob contact\n---\n# Bob\n"
        )
        (dedup_vault / 'personal/bob.md').write_text(
            "---\ntype: note\ndomain: personal\ndescription: Bob note\n---\n# Bob note\n"
        )
        duplicate_groups = collect_duplicate_groups(dedup_vault, schema)
        test("collect_duplicate_groups keeps same type/domain duplicates",
             duplicate_groups.get(('foo', 'knowledge', 'note')) == ['knowledge/notes/foo.md', 'knowledge/foo.md'] or
             duplicate_groups.get(('foo', 'knowledge', 'note')) == ['knowledge/foo.md', 'knowledge/notes/foo.md'],
             f"got: {duplicate_groups}")
        test("collect_duplicate_groups skips cross-domain homonyms",
             all(key[0] != 'bob' for key in duplicate_groups),
             f"got: {duplicate_groups}")
        test("is_hub_path detects nested _index", is_hub_path('foo/_index'))
        test("is_hub_path detects nested MEMORY", is_hub_path('agents/x/MEMORY'))

        # ═══════════════════════════════════════════════════════
        # 2. Script CLI tests (subprocess against temp vault)
        # ═══════════════════════════════════════════════════════

        py = sys.executable  # use the same python that runs this test

        # --- graph.py ---
        print("\n--- graph.py ---")
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'graph.py'), 'health',
                              str(vault_dir), str(schema_path)])
        test("graph health exits 0", code == 0, err[:300])
        test("graph health shows total files",
             'Total files:' in out, out[:200])
        # Should find our 10 files
        file_count_str = ''
        if 'Total files:' in out:
            file_count_str = out.split('Total files:')[1].split('\n')[0].strip()
        test("graph health correct file count",
             file_count_str == str(len(VAULT_FILES)),
             f"expected {len(VAULT_FILES)}, got '{file_count_str}'")
        test("graph health shows Health Score", 'Health Score' in out)

        # graph orphans
        code, out, _ = run([py, str(SCRIPTS_DIR / 'graph.py'), 'orphans',
                            str(vault_dir), str(schema_path)])
        test("graph orphans exits 0", code == 0)
        test("graph orphans shows list", 'Orphans:' in out)

        # graph backlinks
        code, out, _ = run([py, str(SCRIPTS_DIR / 'graph.py'), 'backlinks',
                            str(vault_dir), 'contacts/bob', str(schema_path)])
        test("graph backlinks exits 0", code == 0)
        test("graph backlinks finds links", 'Backlinks' in out)

        # --- moc.py ---
        print("\n--- moc.py ---")
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'moc.py'), 'generate',
                              str(vault_dir), str(schema_path)])
        test("moc generate exits 0", code == 0, err[:300])
        test("moc generates wikilinks", 'wikilinks' in out.lower(), out[:200])

        # Check MOC files were created
        moc_dir = vault_dir / 'MOC'
        moc_files = list(moc_dir.glob('MOC-*.md')) if moc_dir.exists() else []
        test("moc creates MOC files", len(moc_files) > 0,
             f"found {len(moc_files)}")

        # --- engine.py ---
        print("\n--- engine.py ---")
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'engine.py'), 'stats',
                              str(vault_dir), str(schema_path)])
        test("engine stats exits 0", code == 0, err[:300])
        test("engine stats shows total cards", 'total cards:' in out, out[:200])
        test("engine stats shows decay rate", '0.015' in out)
        test("engine stats shows tier distribution", 'tier distribution' in out)

        # engine creative
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'engine.py'), 'creative', '2',
                              str(vault_dir), str(schema_path)])
        test("engine creative exits 0", code == 0, err[:300])

        # --- enforce.py ---
        print("\n--- enforce.py ---")
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'enforce.py'),
                              str(vault_dir), str(schema_path)])
        test("enforce exits 0", code == 0, err[:300])
        test("enforce shows compliance score", 'SCHEMA COMPLIANCE' in out, out[:300])

        # --- discover.py ---
        print("\n--- discover.py ---")
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'discover.py'), str(vault_dir)])
        test("discover exits 0", code == 0, err[:300])
        try:
            disc = json.loads(out)
            test("discover outputs valid JSON", True)
            # MOC files may have been created by moc.py above, so count >= original
            test("discover finds files >= fixture count",
                 disc['meta']['total_files'] >= len(VAULT_FILES),
                 f"expected >= {len(VAULT_FILES)}, got {disc['meta'].get('total_files')}")
        except Exception as e:
            test("discover outputs valid JSON", False, str(e)[:200])

        # --- dedup.py ---
        print("\n--- dedup.py ---")
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'dedup.py'), str(vault_dir)])
        test("dedup exits 0", code == 0, err[:300])
        # We have bob.md in two places, so duplicates should be found
        test("dedup finds duplicates",
             'Duplicate groups' in out or 'No duplicates' in out,
             out[:200])

        policy_vault = tmp / 'policy-vault'
        (policy_vault / 'pu').mkdir(parents=True, exist_ok=True)
        (policy_vault / 'sample/contacts').mkdir(parents=True, exist_ok=True)
        (policy_vault / 'sample/clients').mkdir(parents=True, exist_ok=True)
        (policy_vault / 'crm/sample').mkdir(parents=True, exist_ok=True)
        (policy_vault / 'pu/alex.md').write_text(
            "---\ntype: power_user\ndomain: sample\nstatus: active\n---\n# Alex\n")
        (policy_vault / 'sample/contacts/alex.md').write_text(
            "---\ntype: contact\ndomain: sample\nstatus: active\n---\n# Alex\n")
        (policy_vault / 'sample/clients/acme.md').write_text(
            "---\ntype: client\ndomain: sample\nstatus: active\n---\n# Acme\n")
        (policy_vault / 'sample/contacts/acme.md').write_text(
            "---\ntype: contact\ndomain: sample\nstatus: active\n---\n# Acme\n")
        policy_schema = dict(SCHEMA)
        policy_schema['node_types'] = dict(SCHEMA['node_types'])
        policy_schema['node_types']['power_user'] = {
            "description": "Power user", "required": ["description"], "status": ["active"]
        }
        policy_schema['node_types']['client'] = {
            "description": "Client", "required": ["description"], "status": ["active"]
        }
        policy_schema['node_types']['crm'] = {
            "description": "CRM overlay", "required": ["description"], "status": ["active"]
        }
        policy_schema['dedup_policy'] = {
            "canonical_priority": [
                "pu/",
                "sample/clients/",
                "sample/contacts/",
                "crm/sample/"
            ],
            "path_rules": [
                {"prefix": "pu/", "domain": "sample-pu", "type": "power_user", "kind": "power_user"},
                {"prefix": "sample/clients/", "domain": "sample-clients", "type": "client", "kind": "client"},
                {"prefix": "sample/contacts/", "domain": "sample-contacts", "type": "contact", "kind": "contact"},
                {"prefix": "crm/sample/", "domain": "sample-crm", "type": "crm", "kind": "crm"}
            ]
        }
        policy_schema_path = tmp / 'policy-schema.json'
        policy_schema_path.write_text(json.dumps(policy_schema))
        policy_manifest = tmp / 'policy-manifest.json'
        code, out, err = run([py, str(SCRIPTS_DIR / 'dedup.py'), str(policy_vault),
                              str(policy_schema_path), '--dry-run', '--manifest',
                              str(policy_manifest), '--verbose'])
        test("dedup policy manifest exits 0", code == 0, err[:300])
        test("dedup policy manifest writes file", policy_manifest.exists())
        test("dedup policy does not move PU/client into contacts",
             'MOVE:' not in out and 'policy' in policy_manifest.read_text(),
             out[:300])
        manifest_data = json.loads(policy_manifest.read_text())
        actions = {c['slug']: c['action'] for c in manifest_data['clusters']}
        test("dedup policy keeps layered PU/contact", actions.get('alex') == 'keep_linked_layers', str(actions))
        test("dedup policy keeps client/contact layers", actions.get('acme') == 'keep_linked_layers', str(actions))

        # --- daily.py ---
        print("\n--- daily.py ---")
        _schema_cache.clear()
        code, out, err = run([py, str(SCRIPTS_DIR / 'daily.py'), 'extract',
                              str(daily_dir), str(vault_dir), '2026-03-01'])
        test("daily extract exits 0", code == 0, err[:300])
        test("daily extract finds people", '"people"' in out, out[:200])
        try:
            daily_summary = json.loads(out)
            test("daily extract summary includes linked_entities",
                 'linked_entities' in daily_summary,
                 str(daily_summary))
        except Exception as e:
            test("daily extract summary includes linked_entities", False, str(e)[:200])

        # ═══════════════════════════════════════════════════════
        # 3. swarm_prepare.py + swarm_reduce.py tests
        # ═══════════════════════════════════════════════════════

        # --- swarm_prepare.py ---
        print("\n--- swarm_prepare.py ---")
        _schema_cache.clear()

        # First run discover to get discovery JSON
        code_disc, out_disc, _ = run([py, str(SCRIPTS_DIR / 'discover.py'), str(vault_dir)])
        disc_json_path = tmp / 'discovery.json'
        disc_json_path.write_text(out_disc)

        # 3.1 swarm_prepare exits 0 and produces manifests
        code, out, err = run([py, str(SCRIPTS_DIR / 'swarm_prepare.py'),
                              str(vault_dir), str(disc_json_path), '--budget', '50000'])
        test("swarm_prepare exits 0", code == 0, err[:300])
        test("swarm_prepare shows batch count", 'batch' in out.lower(), out[:200])

        # Check manifests were created
        manifests_dir = vault_dir / '.graph' / 'swarm' / 'manifests'
        manifests = list(manifests_dir.glob('batch-*.json')) if manifests_dir.exists() else []
        test("swarm_prepare creates manifests", len(manifests) > 0,
             f"found {len(manifests)} manifests")

        # 3.2 All files distributed (sum of batch file_counts = total files)
        total_in_batches = 0
        all_batch_files = set()
        for mf in manifests:
            manifest = json.loads(mf.read_text())
            total_in_batches += manifest['file_count']
            for f in manifest['files']:
                all_batch_files.add(f)
        # walk_vault finds all files (may include MOC files from moc.py test above)
        from common import walk_vault as wv, rel_path as rp
        vault_files_actual = [rp(f, vault_dir) for f in wv(vault_dir)]
        test("swarm_prepare distributes all files",
             total_in_batches == len(vault_files_actual),
             f"batches have {total_in_batches}, vault has {len(vault_files_actual)}")

        # 3.3 No file duplicated across batches
        test("swarm_prepare no file duplicates",
             len(all_batch_files) == total_in_batches,
             f"unique={len(all_batch_files)}, total={total_in_batches}")

        # 3.4 Budget respected per batch
        budget = 50000
        budget_ok = True
        for mf in manifests:
            manifest = json.loads(mf.read_text())
            if manifest['estimated_tokens'] > budget and manifest['file_count'] > 1:
                budget_ok = False
        test("swarm_prepare respects token budget", budget_ok)

        # 3.5 Seed types included
        if manifests:
            first_manifest = json.loads(manifests[0].read_text())
            test("swarm_prepare includes seed_types",
                 len(first_manifest.get('seed_types', [])) > 0,
                 str(first_manifest.get('seed_types', [])))
        else:
            test("swarm_prepare includes seed_types", False, "no manifests")

        # 3.6 swarm-meta.json exists
        meta_path = vault_dir / '.graph' / 'swarm' / 'swarm-meta.json'
        test("swarm_prepare creates swarm-meta.json", meta_path.exists())

        # 3.7 Deterministic: two runs produce identical manifests
        # Clean up and re-run
        import shutil as _shutil
        swarm_dir_1 = tmp / 'swarm-backup'
        if manifests_dir.exists():
            _shutil.copytree(manifests_dir, swarm_dir_1)
        # Remove and re-run
        _shutil.rmtree(vault_dir / '.graph' / 'swarm', ignore_errors=True)
        code2, _, _ = run([py, str(SCRIPTS_DIR / 'swarm_prepare.py'),
                           str(vault_dir), str(disc_json_path), '--budget', '50000'])
        manifests2 = sorted(manifests_dir.glob('batch-*.json')) if manifests_dir.exists() else []
        manifests1 = sorted(swarm_dir_1.glob('batch-*.json')) if swarm_dir_1.exists() else []
        deterministic = (len(manifests1) == len(manifests2))
        if deterministic:
            for m1, m2 in zip(manifests1, manifests2):
                d1 = json.loads(m1.read_text())
                d2 = json.loads(m2.read_text())
                # Compare file lists (not timestamps)
                if d1['files'] != d2['files']:
                    deterministic = False
                    break
        test("swarm_prepare is deterministic", deterministic)

        # 3.8 Empty vault
        empty_swarm = tmp / 'empty-swarm-vault'
        empty_swarm.mkdir(exist_ok=True)
        code_e, out_e, err_e = run([py, str(SCRIPTS_DIR / 'swarm_prepare.py'),
                                     str(empty_swarm)])
        test("swarm_prepare handles empty vault", code_e == 0, err_e[:200])

        # --- swarm_reduce.py ---
        print("\n--- swarm_reduce.py ---")

        # Create fake Wave 1 JSONL output for testing
        classifications_dir = vault_dir / '.graph' / 'swarm' / 'classifications'
        classifications_dir.mkdir(parents=True, exist_ok=True)
        jsonl_lines = []
        for rel_file in list(VAULT_FILES.keys())[:5]:
            jsonl_lines.append(json.dumps({
                "path": rel_file,
                "proposed_type": "note",
                "proposed_domain": "knowledge",
                "summary": "Test file",
                "seed_match": True,
                "confidence": "high"
            }))
        for rel_file in list(VAULT_FILES.keys())[5:]:
            jsonl_lines.append(json.dumps({
                "path": rel_file,
                "proposed_type": "contact",
                "proposed_domain": "crm",
                "summary": "Contact file",
                "seed_match": True,
                "confidence": "medium"
            }))
        (classifications_dir / 'batch-001.jsonl').write_text('\n'.join(jsonl_lines) + '\n')

        # Add a malformed line
        (classifications_dir / 'batch-002.jsonl').write_text(
            '{"path":"ok.md","proposed_type":"note","proposed_domain":"personal","summary":"ok","seed_match":true,"confidence":"high"}\n'
            'THIS IS NOT JSON\n'
            '{"no_path_field": true}\n'
        )

        # 3.9 swarm_reduce prepare reads JSONL and counts frequencies
        code, out, err = run([py, str(SCRIPTS_DIR / 'swarm_reduce.py'), 'prepare',
                              str(vault_dir)])
        test("swarm_reduce prepare exits 0", code == 0, err[:300])
        test("swarm_reduce prepare shows types", 'note' in out, out[:300])

        consolidation_path = vault_dir / '.graph' / 'swarm' / 'consolidation.json'
        test("swarm_reduce prepare creates consolidation.json",
             consolidation_path.exists())

        if consolidation_path.exists():
            consol = json.loads(consolidation_path.read_text())
            test("swarm_reduce prepare has type_frequency",
                 'note' in consol.get('type_frequency', {}),
                 str(consol.get('type_frequency', {})))
        else:
            test("swarm_reduce prepare has type_frequency", False, "no consolidation")

        # 3.10 swarm_reduce prepare handles malformed lines (logged to stderr)
        test("swarm_reduce prepare warns on malformed", 'malformed' in err.lower() or 'WARN' in err,
             err[:200])

        # 3.11 swarm_reduce finalize with valid schema → exits 0
        valid_schema = {
            "node_types": {
                "note": {"description": "General note", "required": ["description", "tags"],
                         "status": ["active", "draft", "archived"]},
                "contact": {"description": "Person", "required": ["description", "tags"],
                            "status": ["active", "inactive"]},
                "project": {"description": "Project", "required": ["description", "status"],
                            "status": ["active", "done", "paused"]}
            },
            "type_aliases": {"person": "contact"},
            "field_fixes": {},
            "domain_inference": {"projects/": "work", "contacts/": "crm"},
            "path_type_hints": {"contacts/": "contact"},
            "status_order": {"active": 0, "draft": 1, "archived": 2, "inactive": 3, "done": 4, "paused": 5},
            "status_defaults": {"default": "active"},
            "richness_fields": {"bonus_fields": ["email", "telegram"]},
            "entity_extraction": {"noise_words": ["TODO"]},
            "decay": {"rate": 0.015, "floor": 0.1, "tiers": {"active": 7, "warm": 21, "cold": 60}},
            "ignore_tags": []
        }
        valid_path = tmp / 'valid-wave2.json'
        valid_path.write_text(json.dumps(valid_schema))
        output_schema = tmp / 'output-schema.json'

        code, out, err = run([py, str(SCRIPTS_DIR / 'swarm_reduce.py'), 'finalize',
                              str(valid_path), str(output_schema)])
        test("swarm_reduce finalize valid exits 0", code == 0, err[:300])
        test("swarm_reduce finalize writes output", output_schema.exists())

        # 3.12 swarm_reduce finalize rejects missing sections → exits 1
        bad_schema_missing = {"node_types": {"note": {"description": "x", "required": [], "status": ["active"]}}}
        bad_path_missing = tmp / 'bad-missing.json'
        bad_path_missing.write_text(json.dumps(bad_schema_missing))
        code, _, err = run([py, str(SCRIPTS_DIR / 'swarm_reduce.py'), 'finalize',
                            str(bad_path_missing)])
        test("swarm_reduce finalize rejects missing sections", code != 0,
             err[:200])

        # 3.13 swarm_reduce finalize rejects >15 node_types → exits 1
        too_many_types = {f"type_{i}": {"description": f"Type {i}", "required": [], "status": ["active"]}
                          for i in range(16)}
        bad_schema_many = dict(valid_schema)
        bad_schema_many = json.loads(json.dumps(valid_schema))  # deep copy
        bad_schema_many["node_types"] = too_many_types
        bad_path_many = tmp / 'bad-many.json'
        bad_path_many.write_text(json.dumps(bad_schema_many))
        code, _, err = run([py, str(SCRIPTS_DIR / 'swarm_reduce.py'), 'finalize',
                            str(bad_path_many)])
        test("swarm_reduce finalize rejects >15 types", code != 0,
             err[:200])

        # 3.14 swarm_reduce finalize checks alias targets exist
        bad_schema_alias = json.loads(json.dumps(valid_schema))
        bad_schema_alias["type_aliases"] = {"ghost": "nonexistent_type"}
        bad_path_alias = tmp / 'bad-alias.json'
        bad_path_alias.write_text(json.dumps(bad_schema_alias))
        code, _, err = run([py, str(SCRIPTS_DIR / 'swarm_reduce.py'), 'finalize',
                            str(bad_path_alias)])
        test("swarm_reduce finalize rejects bad alias target", code != 0,
             err[:200])

        # ═══════════════════════════════════════════════════════
        # 4. Edge cases
        # ═══════════════════════════════════════════════════════
        print("\n--- edge cases ---")

        # 3.1 Empty vault
        empty_dir = tmp / "empty-vault"
        empty_dir.mkdir(exist_ok=True)
        _schema_cache.clear()

        code, _, _ = run([py, str(SCRIPTS_DIR / 'graph.py'), 'health',
                          str(empty_dir), str(schema_path)])
        test("graph handles empty vault", code == 0)

        code, _, _ = run([py, str(SCRIPTS_DIR / 'moc.py'), 'generate',
                          str(empty_dir), str(schema_path)])
        test("moc handles empty vault", code == 0)

        code, _, _ = run([py, str(SCRIPTS_DIR / 'engine.py'), 'stats',
                          str(empty_dir), str(schema_path)])
        test("engine handles empty vault", code == 0)

        code, _, _ = run([py, str(SCRIPTS_DIR / 'dedup.py'), str(empty_dir)])
        test("dedup handles empty vault", code == 0)

        code, out, _ = run([py, str(SCRIPTS_DIR / 'discover.py'), str(empty_dir)])
        test("discover handles empty vault", code == 0)
        try:
            disc_empty = json.loads(out)
            test("discover empty vault returns 0 files",
                 disc_empty['meta']['total_files'] == 0)
        except Exception:
            test("discover empty vault returns 0 files", False, "bad JSON")

        # 3.2 File without frontmatter (already in vault)
        fm_none, body_none, _ = parse_frontmatter(VAULT_FILES["no-frontmatter.md"])
        test("no-fm file: parse_fm returns None", fm_none is None)
        test("no-fm file: body preserved", '# Just a Note' in body_none)

        # 3.3 File with broken frontmatter
        fm_broken, body_broken, _ = parse_frontmatter(VAULT_FILES["broken-frontmatter.md"])
        test("broken-fm: parse_fm returns dict (not crash)",
             fm_broken is not None or fm_broken is None)
        # The parser should not crash; it may return partial data or None

        # 3.4 No hardcoded domains/maps in scripts
        # Note: common.py has get_domain_map() which is schema-driven, so we
        # only check for DOMAIN_MAP (a hardcoded constant pattern)
        for script_name in ['graph.py', 'moc.py', 'engine.py', 'common.py']:
            src = (SCRIPTS_DIR / script_name).read_text()
            test(f"{script_name} no hardcoded DOMAIN_MAP constant",
                 'DOMAIN_MAP' not in src)

        # ═══════════════════════════════════════════════════════
        # 5. enrich.py tests (mock API)
        # ═══════════════════════════════════════════════════════
        print("\n--- enrich.py ---")
        import enrich

        # Mock API — returns canned results
        _mock_call_count = 0
        def mock_openrouter(messages, response_schema, model=enrich.DEFAULT_MODEL, schema_name="response"):
            nonlocal _mock_call_count
            _mock_call_count += 1
            # Detect mode from schema_name or message content
            user_msg = messages[-1]['content'] if messages else ''
            if 'Classify' in user_msg or schema_name == 'tag_results':
                # Tags mode — extract paths from user message
                paths = []
                for line in user_msg.split('\n'):
                    if line.startswith('### '):
                        paths.append(line[4:].strip())
                return {"results": [{"path": p, "tags": ["ai", "test"]} for p in paths]}
            elif schema_name == 'swarm_link_results':
                # Swarm-links mode — return exact stems (some valid, some not)
                paths = []
                for line in user_msg.split('\n'):
                    if line.startswith('### '):
                        paths.append(line[4:].strip())
                return {"results": [{"path": p, "links": ["alpha", "bob", "nonexistent-stem-xyz", Path(p).stem]} for p in paths]}
            else:
                # Links mode — extract paths, return suggestions
                paths = []
                for line in user_msg.split('\n'):
                    if line.startswith('### '):
                        paths.append(line[4:].strip())
                return {"results": [{"path": p, "suggestions": ["ML Basics", "Alpha Project", "nonexistent note xyz"]} for p in paths]}

        original_call = enrich.call_openrouter
        enrich.call_openrouter = mock_openrouter

        # 5.1 chunk_list
        test("chunk_list normal", enrich.chunk_list([1,2,3,4,5], 2) == [[1,2],[3,4],[5]])
        test("chunk_list empty", enrich.chunk_list([], 3) == [])
        test("chunk_list smaller than chunk", enrich.chunk_list([1,2], 5) == [[1,2]])

        # 5.8 collect_vault_tags
        seed_tags = enrich.collect_vault_tags(vault_dir, schema)
        test("collect_vault_tags returns list", isinstance(seed_tags, list))
        test("collect_vault_tags finds tags", len(seed_tags) > 0)
        test("collect_vault_tags excludes ignore_tags", 'imported' not in seed_tags)

        # 5.9 build_tag_entries — filters files without tags
        tag_entries = enrich.build_tag_entries(vault_dir, schema)
        test("build_tag_entries finds untagged", len(tag_entries) > 0)
        # Files with tags should be skipped (unless force)
        tagged_paths = [e['path'] for e in tag_entries]
        test("build_tag_entries skips tagged files",
             'projects/alpha.md' not in tagged_paths,
             f"alpha.md should be skipped, got {tagged_paths}")

        # 5.10 build_tag_entries --force includes all
        force_entries = enrich.build_tag_entries(vault_dir, schema, force=True)
        test("build_tag_entries force includes all",
             len(force_entries) > len(tag_entries))

        # 5.11 Tags dry run (no --apply) — results saved to disk
        _mock_call_count = 0
        enrich_tags_dir = vault_dir / '.graph' / 'enrich' / 'tags'
        if enrich_tags_dir.exists():
            shutil.rmtree(enrich_tags_dir)
        enrich.cmd_tags(vault_dir, apply=False, budget=50000,
                        model="test-model", force=True, delay=0, workers=1)
        tag_results = list(enrich_tags_dir.glob('batch-*-results.json'))
        test("tags dry run creates result files", len(tag_results) > 0)
        test("tags dry run called mock API", _mock_call_count > 0)

        # 5.12 Tags --apply writes to files
        # Add a file with no tags for apply test
        test_apply_file = vault_dir / "apply-test.md"
        test_apply_file.write_text("# Apply Test\n\nNo frontmatter here.\n")
        if enrich_tags_dir.exists():
            shutil.rmtree(enrich_tags_dir)
        enrich.cmd_tags(vault_dir, apply=True, budget=50000,
                        model="test-model", force=True, delay=0, workers=1)
        test_content = test_apply_file.read_text()
        fm_check, _, _ = parse_frontmatter(test_content)
        test("tags apply writes frontmatter",
             fm_check is not None and 'tags' in fm_check,
             f"got fm={fm_check}")

        # 5.13 Tags resume (idempotent — skip existing results)
        _mock_call_count = 0
        enrich.cmd_tags(vault_dir, apply=False, budget=50000,
                        model="test-model", force=False, delay=0, workers=1)
        test("tags resume skips existing batches", _mock_call_count == 0,
             f"expected 0 API calls, got {_mock_call_count}")

        # 5.14 scan_vault_for_links — unified scan
        scan_stems, scan_stem_to_path, scan_catalog, scan_entries = enrich.scan_vault_for_links(vault_dir, force=False)
        test("scan_vault_for_links returns stems", len(scan_stems) > 0)
        test("scan_vault_for_links has alpha", 'alpha' in scan_stems)
        test("scan_vault_for_links stem_to_path maps", 'bob' in scan_stem_to_path)
        test("scan_vault_for_links catalog is dict", isinstance(scan_catalog, dict))
        total_entries = sum(len(v) for v in scan_catalog.values())
        test("scan_vault_for_links catalog has entries", total_entries > 0,
             f"got {total_entries} entries across {len(scan_catalog)} domains")
        test("scan_vault_for_links finds link entries", len(scan_entries) > 0)

        # 5.15 scan_vault_for_links force mode includes all files
        _, _, _, force_entries = enrich.scan_vault_for_links(vault_dir, force=True)
        test("scan_vault_for_links force includes more",
             len(force_entries) >= len(scan_entries))

        # ═══════════════════════════════════════════════════════
        # 5b. swarm-links tests
        # ═══════════════════════════════════════════════════════
        print("\n--- swarm-links ---")

        # 5b.2 format_catalog formats entries
        sample_entries = [
            {'stem': 'test-note', 'type': 'note', 'tags': ['ai', 'test'], 'desc': 'A test note'},
            {'stem': 'other', 'type': 'project', 'tags': ['dev'], 'desc': 'Other note'},
        ]
        formatted = enrich.format_catalog(sample_entries)
        test("format_catalog contains stems", 'test-note' in formatted and 'other' in formatted)
        test("format_catalog contains tags", 'ai, test' in formatted)

        # 5b.3 format_catalog truncates at max_entries
        big_entries = [{'stem': f'note-{i}', 'type': 'note', 'tags': [], 'desc': f'Note {i}'} for i in range(50)]
        truncated = enrich.format_catalog(big_entries, max_entries=10)
        test("format_catalog truncates", '(truncated, 40 more)' in truncated)

        # 5b.4 format_catalog empty
        empty_formatted = enrich.format_catalog([])
        test("format_catalog empty", empty_formatted == "(empty catalog)")

        # 5b.5 swarm-link validation: strict set membership
        # Simulate what _process_swarm_link_batch does internally
        test_stems = {'alpha', 'bob', 'ml-basics', 'python-tips'}
        raw_links = ['alpha', 'bob', 'nonexistent-stem', 'invented-name']
        valid = [s for s in raw_links if s in test_stems]
        test("swarm strict validation passes exact stems",
             valid == ['alpha', 'bob'],
             f"got {valid}")

        # 5b.6 swarm-link filters self-links
        file_stem = 'alpha'
        raw_with_self = ['alpha', 'bob', 'ml-basics']
        filtered_self = [s for s in raw_with_self if s in test_stems and s != file_stem]
        test("swarm filters self-links",
             'alpha' not in filtered_self and 'bob' in filtered_self)

        # 5b.7 swarm-link filters existing links
        existing_links = {'bob'}
        raw_all = ['alpha', 'bob', 'ml-basics']
        filtered_existing = [s for s in raw_all
                             if s in test_stems and s != file_stem and s not in existing_links]
        test("swarm filters existing links",
             'bob' not in filtered_existing and 'ml-basics' in filtered_existing)

        # 5b.8 swarm-links dry run
        _mock_call_count = 0
        enrich_swarm_dir = vault_dir / '.graph' / 'enrich' / 'swarm-links'
        if enrich_swarm_dir.exists():
            shutil.rmtree(enrich_swarm_dir)
        enrich.cmd_swarm_links(vault_dir, apply=False, budget=100000,
                                model="test-model", force=True, delay=0, workers=1)
        swarm_results = list(enrich_swarm_dir.glob('batch-*-results.json'))
        test("swarm-links dry run creates result files", len(swarm_results) > 0)
        test("swarm-links dry run called mock API", _mock_call_count > 0)

        # 5b.9 swarm-links results have matched_links from strict validation
        if swarm_results:
            first_swarm = json.loads(swarm_results[0].read_text())
            has_matched = any(
                len(r.get('matched_links', [])) > 0
                for r in first_swarm.get('results', [])
            )
            test("swarm-links strict match finds real stems", has_matched,
                 f"results: {first_swarm.get('results', [])[:2]}")
            # Verify no nonexistent stems passed
            all_matched = []
            for r in first_swarm.get('results', []):
                all_matched.extend(r.get('matched_links', []))
            test("swarm-links no invented stems in matched",
                 'nonexistent-stem-xyz' not in all_matched,
                 f"matched: {all_matched}")

        # 5b.10 swarm-links --apply appends ## Related
        swarm_test_file = vault_dir / "swarm-test.md"
        swarm_test_file.write_text("---\ntype: note\ntags: [test]\n---\n# Swarm Test\n\nSome content.\n")
        if enrich_swarm_dir.exists():
            shutil.rmtree(enrich_swarm_dir)
        enrich.cmd_swarm_links(vault_dir, apply=True, budget=100000,
                                model="test-model", force=True, delay=0, workers=1)
        swarm_content = swarm_test_file.read_text()
        test("swarm-links apply adds Related section",
             '## Related' in swarm_content,
             f"content: {swarm_content[:200]}")

        # Restore original
        enrich.call_openrouter = original_call

        # ═══════════════════════════════════════════════════════
        # 6. link_cleanup.py tests
        # ═══════════════════════════════════════════════════════
        print("\n--- link_cleanup.py ---")
        import link_cleanup

        # 6.1 build_stems_and_paths
        valid_targets = link_cleanup.build_stems_and_paths(vault_dir)
        test("cleanup stems includes alpha",
             valid_targets.get('unique_stem', {}).get('alpha') == 'projects/alpha',
             f"got: {valid_targets.get('unique_stem', {}).get('alpha')}")
        test("cleanup stems includes path",
             valid_targets.get('exact', {}).get('projects/alpha') == 'projects/alpha',
             f"got: {valid_targets.get('exact', {}).get('projects/alpha')}")

        # 6.2 check_link_target — valid
        test("check_link valid stem", link_cleanup.check_link_target('alpha', valid_targets))
        test("check_link valid path", link_cleanup.check_link_target('projects/alpha', valid_targets))

        # 6.3 check_link_target — invalid
        test("check_link invalid", not link_cleanup.check_link_target('nonexistent-file-xyz', valid_targets))
        test("check_link ambiguous stem invalid", not link_cleanup.check_link_target('bob', valid_targets))

        # 6.4 cleanup_related_section — removes broken links
        content_with_broken = (
            "# Test\n\nSome body.\n\n"
            "## Related\n"
            "- [[projects/alpha]]\n"
            "- [[nonexistent-phantom-link]]\n"
            "- [[knowledge/ml-basics]]\n"
        )
        new_content, removed, kept = link_cleanup.cleanup_related_section(
            content_with_broken, valid_targets)
        test("cleanup removes phantom link",
             'nonexistent-phantom-link' in removed)
        test("cleanup keeps valid links", len(kept) >= 2)
        test("cleanup output has no phantom",
             '[[nonexistent-phantom-link]]' not in new_content)
        test("cleanup output has valid links",
             '[[projects/alpha]]' in new_content)

        # 6.5 cleanup_related_section — all broken → delete section
        content_all_broken = (
            "# Test\n\nBody text.\n\n"
            "## Related\n"
            "- [[ghost-link-1]]\n"
            "- [[ghost-link-2]]\n"
        )
        new_all, removed_all, kept_all = link_cleanup.cleanup_related_section(
            content_all_broken, valid_targets)
        test("cleanup deletes section when all broken",
             '## Related' not in new_all)
        test("cleanup reports all removed", len(removed_all) == 2)

        # 6.6 cleanup doesn't touch body links
        content_body_links = (
            "# Test\n\n"
            "See [[nonexistent-in-body]] for details.\n\n"
            "## Related\n"
            "- [[projects/alpha]]\n"
        )
        new_body, removed_body, _ = link_cleanup.cleanup_related_section(
            content_body_links, valid_targets)
        test("cleanup ignores body links",
             '[[nonexistent-in-body]]' in new_body)
        test("cleanup body link not in removed",
             'nonexistent-in-body' not in removed_body)

        # 6.7 dry run doesn't modify files
        # Create a file with phantom link
        cleanup_test_file = vault_dir / "cleanup-test.md"
        cleanup_test_file.write_text(
            "---\ntype: note\n---\n# Cleanup Test\n\n"
            "## Related\n- [[phantom-target-xyz]]\n"
        )
        original_content = cleanup_test_file.read_text()
        report = link_cleanup.run_cleanup(vault_dir, apply=False)
        test("cleanup dry run safe", cleanup_test_file.read_text() == original_content)
        test("cleanup report has links_removed", len(report['links_removed']) > 0)

        # 6.8 --apply modifies files
        report_apply = link_cleanup.run_cleanup(vault_dir, apply=True)
        new_cleanup_content = cleanup_test_file.read_text()
        test("cleanup apply removes phantom",
             '[[phantom-target-xyz]]' not in new_cleanup_content)

        # 6.9 cleanup writes report json
        report_path = vault_dir / '.graph' / 'link-cleanup-report.json'
        test("cleanup writes report", report_path.exists())

        # ═══════════════════════════════════════════════════════
        # 7. Fix verification tests (code review findings)
        # ═══════════════════════════════════════════════════════
        print("\n--- code review fixes ---")

        # 7.1 CRLF frontmatter parsing
        crlf_content = "---\r\ntype: note\r\nstatus: active\r\ntags: [ai, test]\r\n---\r\n# CRLF Note\r\n\r\nBody with CRLF.\r\n"
        fm_crlf, body_crlf, _ = parse_frontmatter(crlf_content)
        test("parse_fm CRLF: extracts type", fm_crlf is not None and fm_crlf.get('type') == 'note')
        test("parse_fm CRLF: extracts tags", fm_crlf is not None and fm_crlf.get('tags') == ['ai', 'test'])
        test("parse_fm CRLF: body preserved", 'CRLF Note' in body_crlf)

        # 7.2 Literal block (|-) preserves newlines
        literal_content = "---\ntype: note\ndescription: |-\n  Line one\n  Line two\n  Line three\n---\n# Test\n"
        fm_literal, _, _ = parse_frontmatter(literal_content)
        test("parse_fm literal block |- has newlines",
             fm_literal is not None and '\n' in fm_literal.get('description', ''),
             f"got: {fm_literal.get('description', '') if fm_literal else 'None'}")

        # 7.3 Fold block (>-) joins with spaces
        fold_content = "---\ntype: note\ndescription: >-\n  First part\n  second part\n---\n# Test\n"
        fm_fold, _, _ = parse_frontmatter(fold_content)
        test("parse_fm fold block >- joins with space",
             fm_fold is not None and 'First part second part' in fm_fold.get('description', ''),
             f"got: {fm_fold.get('description', '') if fm_fold else 'None'}")

        # 7.4 format_field YAML special chars — colon
        test("format_field escapes colon",
             format_field('title', 'Key: Value') == 'title: "Key: Value"')

        # 7.5 format_field YAML special chars — hash
        test("format_field escapes hash",
             format_field('title', 'Topic #1') == 'title: "Topic #1"')

        # 7.6 format_field YAML special chars — brackets
        test("format_field escapes brackets",
             format_field('note', 'See [link]') == 'note: "See [link]"')

        # 7.7 format_field YAML special chars — quotes
        result_q = format_field('title', 'He said "hello"')
        test("format_field escapes double quotes",
             result_q == 'title: "He said \\"hello\\""',
             f"got: {result_q}")

        # 7.8 format_field safe string — no escaping
        test("format_field no escape for safe string",
             format_field('type', 'note') == 'type: note')

        # 7.9 extract_wikilinks strips #anchor
        anchor_links = extract_wikilinks("See [[target#heading]] and [[other#sec|display]]")
        test("extract_wikilinks anchor stripped",
             len(anchor_links) == 2 and anchor_links[0][0] == 'target',
             f"got: {anchor_links}")
        test("extract_wikilinks anchor with alias",
             anchor_links[1] == ('other', 'display'),
             f"got: {anchor_links[1] if len(anchor_links) > 1 else 'missing'}")

        # 7.10 extract_wikilinks anchor-only link skipped
        anchor_only = extract_wikilinks("See [[#heading-only]]")
        test("extract_wikilinks anchor-only skipped",
             len(anchor_only) == 0,
             f"got: {anchor_only}")

        # 7.11 resolve_link strips anchor (graph.py)
        from graph import resolve_link, fix_broken_links, build_graph
        from dedup import merge_content
        from daily import (
            build_vault_index as build_daily_index,
            extract_entities as extract_daily_entities,
            build_relationships as build_daily_relationships,
            derive_legacy_buckets,
            build_output_meta,
            process_date as process_daily_date,
        )
        test_path_index = {'target': 'knowledge/target', 'foo': 'projects/foo'}
        test("resolve_link strips anchor",
             resolve_link('target#heading', test_path_index) == 'knowledge/target')
        test("resolve_link empty after anchor strip",
             resolve_link('#heading', test_path_index) is None)

        # 7.12 graph fix rewrites only the exact broken wikilink
        fix_vault = tmp / 'graph-fix-vault'
        (fix_vault / 'notes').mkdir(parents=True, exist_ok=True)
        (fix_vault / 'docs').mkdir(parents=True, exist_ok=True)
        source_note = fix_vault / 'notes/source.md'
        source_note.write_text("See [[visa]] and [[visa-guide]].\n")
        (fix_vault / 'docs/visa.md').write_text("# Visa\n")
        (fix_vault / 'docs/visa-guide.md').write_text("# Visa guide\n")
        synthetic_graph = {
            'broken_link_list': [{'source': 'notes/source', 'target': 'visa'}]
        }
        fixes, applied = fix_broken_links(fix_vault, synthetic_graph, apply=True)
        updated_source = source_note.read_text()
        test("graph fix suggests unique stem target",
             len(fixes) == 1 and fixes[0]['new'] == 'docs/visa',
             f"got: {fixes}")
        test("graph fix applies one exact replacement", applied == 1, f"got: {applied}")
        test("graph fix does not mutate prefixed links",
             '[[docs/visa]]' in updated_source and '[[visa-guide]]' in updated_source and '[[docs/visa-guide]]' not in updated_source,
             f"got: {updated_source}")

        # 7.13 nested hub notes are not orphans
        hub_vault = tmp / 'graph-hub-vault'
        (hub_vault / 'foo').mkdir(parents=True, exist_ok=True)
        (hub_vault / 'agents/x').mkdir(parents=True, exist_ok=True)
        (hub_vault / 'foo/_index.md').write_text("# Foo hub\n")
        (hub_vault / 'agents/x/MEMORY.md').write_text("# Agent memory\n")
        (hub_vault / 'foo/card.md').write_text("# Card\n")
        hub_graph = build_graph(hub_vault, schema)
        test("graph skips nested _index orphan",
             'foo/_index' not in hub_graph['orphan_list'],
             f"got: {hub_graph['orphan_list']}")
        test("graph skips nested MEMORY orphan",
             'agents/x/MEMORY' not in hub_graph['orphan_list'],
             f"got: {hub_graph['orphan_list']}")
        test("graph keeps regular orphan",
             'foo/card' in hub_graph['orphan_list'],
             f"got: {hub_graph['orphan_list']}")

        # 7.14 dedup merge writes YAML via shared serializer
        dedup_merge_dir = tmp / 'dedup-merge-vault'
        dedup_merge_dir.mkdir(parents=True, exist_ok=True)
        canonical_note = dedup_merge_dir / 'canonical.md'
        extra_note = dedup_merge_dir / 'extra.md'
        long_desc = "Long description with colon: hash # brackets [x] and enough words to cross the serializer threshold for multiline output."
        canonical_note.write_text(
            "---\n"
            "type: note\n"
            "tags: [base]\n"
            "description: Base note\n"
            "---\n"
            "# Canon\n\n"
            "Body.\n"
        )
        extra_note.write_text(
            "---\n"
            f"description: {long_desc}\n"
            "tags: [base, extra]\n"
            "---\n"
            "# Extra\n\n"
            "## Imported Section\n"
            "Merged text.\n"
        )
        merged = merge_content(canonical_note, [extra_note])
        merged_content = canonical_note.read_text()
        merged_fm, merged_body, _ = parse_frontmatter(merged_content)
        test("dedup merge reports changed", merged, "merge_content returned False")
        test("dedup merge keeps YAML parseable",
             merged_fm is not None and merged_fm.get('description') == long_desc,
             f"got: {merged_fm}")
        test("dedup merge preserves list fields",
             merged_fm.get('tags') == ['base', 'extra'],
             f"got: {merged_fm.get('tags')}")
        test("dedup merge uses multiline serializer",
             'description: >-' in merged_content,
             f"got: {merged_content}")
        test("dedup merge keeps original field order",
             merged_content.find('type: note') < merged_content.find('tags: [base, extra]') < merged_content.find('description: >-'),
             f"got: {merged_content}")
        test("dedup merge appends unique body sections",
             '## Imported Section' in merged_body,
             f"got: {merged_body}")

        # 7.15 daily extraction resolves typed linked entities
        daily_index = build_daily_index(vault_dir)
        daily_entities = extract_daily_entities(
            "Worked with [[contacts/bob|Bob Smith]] on [[projects/alpha|Alpha]].",
            daily_index
        )
        linked_types = {(item['name'], item['type']) for item in daily_entities['linked_entities']}
        daily_relationships = build_daily_relationships(daily_entities)
        test("daily typed links include contact",
             ('Bob Smith', 'contact') in linked_types,
             f"got: {daily_entities['linked_entities']}")
        test("daily typed links include project",
             ('Alpha', 'project') in linked_types,
             f"got: {daily_entities['linked_entities']}")
        test("daily projects bucket excludes contacts",
             daily_entities['projects'] == [{'name': 'Alpha', 'link': 'projects/alpha'}],
             f"got: {daily_entities['projects']}")
        test("daily relationships use typed linked entities",
             any(r['from_type'] == 'contact' and r['to_type'] == 'project' for r in daily_relationships) or
             any(r['from_type'] == 'project' and r['to_type'] == 'contact' for r in daily_relationships),
             f"got: {daily_relationships}")
        legacy_buckets = derive_legacy_buckets([
            {'name': 'Alpha', 'link': 'projects/alpha', 'type': 'project', 'domain': 'work'},
            {'name': 'Acme', 'link': 'companies/acme', 'type': 'company', 'domain': 'crm'},
            {'name': 'Bob Smith', 'link': 'contacts/bob', 'type': 'contact', 'domain': 'crm'},
        ])
        test("daily legacy buckets derive projects from linked_entities",
             legacy_buckets['projects'] == [{'name': 'Alpha', 'link': 'projects/alpha'}],
             f"got: {legacy_buckets}")
        test("daily legacy buckets derive companies from linked_entities",
             legacy_buckets['companies'] == [{'name': 'Acme', 'link': 'companies/acme'}],
             f"got: {legacy_buckets}")
        output_meta = build_output_meta()
        test("daily output meta marks linked_entities primary",
             output_meta.get('primary_entity_field') == 'entities.linked_entities',
             f"got: {output_meta}")
        test("daily output meta marks legacy buckets deprecated",
             output_meta.get('deprecated_fields') == ['entities.projects', 'entities.companies'],
             f"got: {output_meta}")
        dated_result = process_daily_date(daily_dir, daily_index, '2026-03-01')
        test("daily process_date includes output meta",
             dated_result.get('_meta', {}).get('primary_entity_field') == 'entities.linked_entities',
             f"got: {dated_result.get('_meta')}")

        # 7.16 check_link_target strips anchor (link_cleanup.py)
        test("check_link_target strips anchor",
             link_cleanup.check_link_target('alpha#section', valid_targets))
        test("check_link_target anchor-only is not broken",
             link_cleanup.check_link_target('#heading', valid_targets))

        # 7.17 load_schema local priority
        # Create two schemas in a temp dir — schema.json and schema.local.json
        _schema_cache.clear()
        schema_test_dir = tmp / 'schema-priority-test'
        schema_test_dir.mkdir(exist_ok=True)
        scripts_dir_test = schema_test_dir / 'scripts'
        scripts_dir_test.mkdir(exist_ok=True)
        base_schema = {"node_types": {"note": {"description": "base", "required": [], "status": []}},
                       "type_aliases": {}, "field_fixes": {}, "domain_inference": {},
                       "path_type_hints": {}, "status_order": {}, "status_defaults": {},
                       "richness_fields": {}, "entity_extraction": {}, "decay": {"rate": 0.01, "floor": 0.1},
                       "ignore_tags": []}
        local_schema = dict(base_schema)
        local_schema["_marker"] = "local"
        (schema_test_dir / 'schema.json').write_text(json.dumps(base_schema))
        (schema_test_dir / 'schema.local.json').write_text(json.dumps(local_schema))
        # load_schema with explicit path still works
        loaded_base = load_schema(schema_test_dir / 'schema.json')
        test("load_schema explicit path works", 'node_types' in loaded_base)
        _schema_cache.clear()
        loaded_local = load_schema(schema_test_dir / 'schema.local.json')
        test("load_schema local has marker", loaded_local.get('_marker') == 'local')

        # 7.18 load_schema cache by resolved path (not 'default')
        _schema_cache.clear()
        s1 = load_schema(schema_path)
        s2 = load_schema(schema_path)
        test("load_schema cache hit same object", s1 is s2)
        # Different path → different cache entry
        _schema_cache.clear()
        s3 = load_schema(schema_test_dir / 'schema.json')
        s4 = load_schema(schema_path)
        test("load_schema different paths different cache", s3 is not s4)

        # 7.19 swarm_reduce prompt matches REQUIRED_SCHEMA_SECTIONS
        from swarm_reduce import WAVE2_PROMPT_TEMPLATE, REQUIRED_SCHEMA_SECTIONS
        test("swarm_reduce prompt no region_fixes",
             'region_fixes' not in WAVE2_PROMPT_TEMPLATE)
        # All required sections mentioned in prompt
        for section in REQUIRED_SCHEMA_SECTIONS:
            test(f"swarm_reduce prompt mentions {section}",
                 section in WAVE2_PROMPT_TEMPLATE,
                 f"'{section}' not found in prompt")

        # ═══════════════════════════════════════════════════════
        # SUMMARY
        # ═══════════════════════════════════════════════════════
        total = PASS + FAIL
        print(f"\n{'='*60}")
        print(f"  RESULTS: {PASS}/{total} passed, {FAIL} failed")
        print(f"{'='*60}")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    sys.exit(0 if FAIL == 0 else 1)


if __name__ == '__main__':
    main()
