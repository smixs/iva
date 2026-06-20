#!/usr/bin/env python3
"""
autograph enrich — tag and link enrichment via OpenRouter API.

Replaces agent swarms with direct API calls. Zero external dependencies (stdlib only).

Usage:
    enrich.py tags <vault-dir> [--apply] [--budget 50000] [--model MODEL] [--force] [--delay 0.5] [--workers 3]
    enrich.py swarm-links <vault-dir> [--apply] [--budget 100000] [--model MODEL] [--force] [--delay 0.3] [--workers 5]
"""

import json
import sys
import os
import time
import random
import threading
from pathlib import Path
from datetime import datetime
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (walk_vault, parse_frontmatter, write_frontmatter,
                    rel_path, extract_wikilinks, load_schema, get_ignore_tags)
from swarm_prepare import estimate_tokens, bin_pack_batches, top_folder

# ─── CONSTANTS ────────────────────────────────────────────
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "google/gemini-3-flash-preview"
MAX_RETRIES = 3
BASE_DELAY = 2.0
FILES_PER_TAGS_CALL = 20

# Thread safety
_results_lock = threading.Lock()
_consecutive_auth_errors = 0
_auth_lock = threading.Lock()

# ─── API LAYER ────────────────────────────────────────────

def get_api_key() -> str:
    """Get OpenRouter API key from environment."""
    key = os.environ.get('OPENROUTER_API_KEY', '')
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY environment variable not set")
    return key


def call_openrouter(messages: list[dict], response_schema: dict,
                    model: str = DEFAULT_MODEL, schema_name: str = "response") -> dict:
    """Call OpenRouter API with structured JSON output.

    Retries on 429/5xx with exponential backoff. Extra retry on broken JSON.
    Returns parsed JSON dict.
    """
    global _consecutive_auth_errors
    api_key = get_api_key()

    body = json.dumps({
        "model": model,
        "messages": messages,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": schema_name,
                "strict": True,
                "schema": response_schema,
            }
        }
    }).encode()

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    last_error = None
    for attempt in range(MAX_RETRIES):
        try:
            req = Request(OPENROUTER_URL, data=body, headers=headers, method="POST")
            with urlopen(req, timeout=60) as resp:
                raw = resp.read().decode()

            data = json.loads(raw)
            content = data["choices"][0]["message"]["content"]

            # Reset auth error counter on success
            with _auth_lock:
                _consecutive_auth_errors = 0

            # Try to parse JSON response
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                # One extra retry for broken JSON
                if attempt < MAX_RETRIES - 1:
                    time.sleep(BASE_DELAY + random.uniform(0.5, 2.0))
                    continue
                raise ValueError(f"Invalid JSON in response: {content[:200]}")

        except HTTPError as e:
            last_error = e
            if e.code == 401:
                with _auth_lock:
                    _consecutive_auth_errors += 1
                    if _consecutive_auth_errors >= 3:
                        raise RuntimeError("3 consecutive 401 errors — check OPENROUTER_API_KEY") from e
                raise
            if e.code == 429:
                retry_after = e.headers.get('Retry-After')
                delay = int(retry_after) if retry_after and retry_after.isdigit() else BASE_DELAY * (2 ** attempt)
                delay += random.uniform(0.5, 2.0)
                time.sleep(delay)
                continue
            if e.code >= 500:
                delay = BASE_DELAY * (2 ** attempt) + random.uniform(0.5, 2.0)
                time.sleep(delay)
                continue
            raise
        except (URLError, TimeoutError) as e:
            last_error = e
            if attempt < MAX_RETRIES - 1:
                delay = BASE_DELAY * (2 ** attempt) + random.uniform(0.5, 2.0)
                time.sleep(delay)
                continue
            raise

    raise RuntimeError(f"All {MAX_RETRIES} retries exhausted: {last_error}")


def chunk_list(lst: list, n: int) -> list[list]:
    """Split list into chunks of size n."""
    if n <= 0:
        return [lst] if lst else []
    return [lst[i:i+n] for i in range(0, len(lst), n)]


# ─── TAGS SUBCOMMAND ─────────────────────────────────────

TAGS_SYSTEM_PROMPT = """\
You are a tag classifier for an Obsidian knowledge vault. Assign 1-5 lowercase hyphenated tags per file.
Rules:
- STRONGLY prefer tags from SEED SET below. Only create new if no seed tag fits.
- New tags: lowercase, hyphenated (machine-learning, not MachineLearning)
- Content-based only (never tag "note", "markdown", "file")
- Return fewer tags if file is narrow. Empty array OK if nothing fits from seeds.
SEED TAGS: {seed_tags}"""

TAGS_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}}
                },
                "required": ["path", "tags"],
                "additionalProperties": False
            }
        }
    },
    "required": ["results"],
    "additionalProperties": False
}


def collect_vault_tags(vault_dir: Path, schema: dict) -> list[str]:
    """Collect all unique tags from vault, minus ignore_tags."""
    ignore = get_ignore_tags(schema)
    tags = set()
    for md in walk_vault(vault_dir):
        content = md.read_text(errors='replace')
        fm, _, _ = parse_frontmatter(content)
        if fm and isinstance(fm.get('tags'), list):
            for t in fm['tags']:
                t_clean = str(t).strip().lower()
                if t_clean and t_clean not in ignore:
                    tags.add(t_clean)
    return sorted(tags)


def build_tag_entries(vault_dir: Path, schema: dict, force: bool = False) -> list[dict]:
    """Build entries for files that need tags (empty/missing tags)."""
    ignore = get_ignore_tags(schema)
    entries = []
    for md in walk_vault(vault_dir):
        content = md.read_text(errors='replace')
        fm, body, _ = parse_frontmatter(content)
        rp = rel_path(md, vault_dir)

        # Skip files that already have tags (unless --force)
        if not force and fm and isinstance(fm.get('tags'), list) and len(fm['tags']) > 0:
            tags_clean = [t for t in fm['tags'] if str(t).strip().lower() not in ignore]
            if tags_clean:
                continue

        tokens = estimate_tokens(md)
        summary = body[:500].strip() if body else ''
        ftype = fm.get('type', '') if fm else ''
        fdomain = fm.get('domain', '') if fm else ''

        entries.append({
            'path': rp,
            'folder': top_folder(rp),
            'tokens': tokens,
            'summary': summary,
            'type': ftype,
            'domain': fdomain,
        })
    return entries


def _process_tag_batch(batch_id: str, files: list[dict], seed_tags: list[str],
                       model: str, delay: float, output_dir: Path, force: bool) -> dict | None:
    """Process a single tag batch. Returns result dict or None on error."""
    result_path = output_dir / f'{batch_id}-results.json'

    # Resume: skip if result exists and not --force
    if result_path.exists() and not force:
        return json.loads(result_path.read_text())

    if delay > 0:
        time.sleep(delay + random.uniform(0, delay * 0.5))

    # Build user message with file summaries
    file_list = []
    for f in files:
        file_list.append(f"### {f['path']}\nType: {f['type']} | Domain: {f['domain']}\n{f['summary'][:300]}")

    user_msg = "Classify these files:\n\n" + "\n\n".join(file_list)
    system_msg = TAGS_SYSTEM_PROMPT.format(seed_tags=', '.join(seed_tags[:200]))

    try:
        result = call_openrouter(
            messages=[
                {"role": "system", "content": system_msg},
                {"role": "user", "content": user_msg},
            ],
            response_schema=TAGS_RESPONSE_SCHEMA,
            model=model,
            schema_name="tag_results",
        )
        output = {
            'batch_id': batch_id,
            'results': result.get('results', []),
            'validation': {'file_count': len(files), 'result_count': len(result.get('results', []))},
        }
        result_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
        return output
    except Exception as e:
        error_path = output_dir.parent / 'errors' / f'{batch_id}-error.json'
        error_path.parent.mkdir(parents=True, exist_ok=True)
        error_path.write_text(json.dumps({
            'batch_id': batch_id, 'error': str(e), 'timestamp': datetime.now().isoformat(),
        }, indent=2) + '\n')
        print(f"  ERROR {batch_id}: {e}", file=sys.stderr)
        return None


def apply_tags(vault_dir: Path, results_dir: Path):
    """Apply tag results to vault files."""
    applied = 0
    for rp_file in sorted(results_dir.glob('batch-*-results.json')):
        data = json.loads(rp_file.read_text())
        for item in data.get('results', []):
            path = vault_dir / item['path']
            if not path.exists():
                continue
            tags = item.get('tags', [])
            if not tags:
                continue

            content = path.read_text(errors='replace')
            fm, body, lines = parse_frontmatter(content)
            if fm is None:
                # Create frontmatter
                fm = {'tags': tags}
                new_fm = write_frontmatter(fm, [])
                path.write_text(f"---\n{new_fm}\n---\n{body}")
            else:
                fm['tags'] = tags
                new_fm = write_frontmatter(fm, lines)
                path.write_text(f"---\n{new_fm}\n---\n{body}")
            applied += 1
    return applied


def cmd_tags(vault_dir: Path, apply: bool = False, budget: int = 50000,
             model: str = DEFAULT_MODEL, force: bool = False,
             delay: float = 0.5, workers: int = 3):
    """Tags enrichment subcommand."""
    vault_dir = vault_dir.resolve()
    schema = load_schema()

    # 1. Collect seed tags
    seed_tags = collect_vault_tags(vault_dir, schema)
    print(f"Seed tags: {len(seed_tags)}")

    # 2. Build entries for files needing tags
    entries = build_tag_entries(vault_dir, schema, force)
    print(f"Files needing tags: {len(entries)}")
    if not entries:
        print("Nothing to do.")
        return

    # 3. Bin-pack and chunk
    batches = bin_pack_batches(entries, budget)
    api_tasks = []
    batch_num = 0
    for batch in batches:
        for chunk in chunk_list(batch, FILES_PER_TAGS_CALL):
            batch_num += 1
            api_tasks.append((f'batch-{batch_num:03d}', chunk))
    print(f"API batches: {len(api_tasks)}")

    # 4. Output dir
    output_dir = vault_dir / '.graph' / 'enrich' / 'tags'
    output_dir.mkdir(parents=True, exist_ok=True)

    # 5. Process with ThreadPoolExecutor
    results = []
    errors = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_process_tag_batch, bid, files, seed_tags, model, delay, output_dir, force): bid
            for bid, files in api_tasks
        }
        for future in as_completed(futures):
            bid = futures[future]
            try:
                result = future.result()
                if result:
                    with _results_lock:
                        results.append(result)
                    print(f"  OK {bid}: {result['validation']['result_count']} results")
                else:
                    errors += 1
            except Exception as e:
                errors += 1
                print(f"  FAIL {bid}: {e}", file=sys.stderr)

    # 6. Write run metadata
    total_tagged = sum(r['validation']['result_count'] for r in results)
    meta = {
        'mode': 'tags',
        'total_files': len(entries),
        'total_batches': len(api_tasks),
        'total_tagged': total_tagged,
        'errors': errors,
        'model': model,
        'timestamp': datetime.now().isoformat(),
    }
    (output_dir / 'run-meta.json').write_text(json.dumps(meta, indent=2) + '\n')
    print(f"\nDone: {total_tagged} files tagged, {errors} errors")

    # 7. Apply if requested
    if apply:
        applied = apply_tags(vault_dir, output_dir)
        print(f"Applied tags to {applied} files")


# ─── CATALOG (for swarm-links) ────────────────────────────

FILES_PER_SWARM_CALL = 8


def scan_vault_for_links(vault_dir: Path, force: bool = False) -> tuple[set, dict, dict, list]:
    """Single walk: returns (stems_set, stem_to_path, catalog, link_entries).

    Replaces three separate walk_vault() calls with one pass.
    """
    stems_set = set()
    stem_to_path = {}
    catalog = {}      # domain → list of catalog entries
    link_entries = []  # files needing links (<2 outgoing)

    for md in walk_vault(vault_dir):
        content = md.read_text(errors='replace')
        fm, body, _ = parse_frontmatter(content)
        rp = rel_path(md, vault_dir)
        stem = md.stem

        # --- stems ---
        stems_set.add(stem)
        stem_to_path[stem] = rp

        # --- catalog ---
        domain = (fm.get('domain', '') if fm else '') or 'general'
        ftype = fm.get('type', '') if fm else ''
        tags = fm.get('tags', []) if fm else []
        first_line = body.strip().split('\n')[0][:120] if body else ''

        catalog.setdefault(domain, []).append({
            'stem': stem,
            'type': ftype,
            'tags': tags[:5] if isinstance(tags, list) else [],
            'desc': first_line,
        })

        # --- link entries ---
        existing_links = extract_wikilinks(body)
        if not force and len(existing_links) >= 2:
            continue

        tokens = estimate_tokens(md)
        summary = body[:500].strip() if body else ''
        ftags = tags

        link_entries.append({
            'path': rp,
            'folder': top_folder(rp),
            'tokens': tokens,
            'summary': summary,
            'type': ftype,
            'domain': domain,
            'tags': ftags if isinstance(ftags, list) else [],
            'existing_links': [t for t, _ in existing_links],
        })

    return stems_set, stem_to_path, catalog, link_entries


def format_catalog(entries: list[dict], max_entries: int = 800) -> str:
    """Format catalog entries as text table for LLM prompt.

    Each line: stem | tags: t1, t2 | Description...
    Truncates if > max_entries.
    """
    if not entries:
        return "(empty catalog)"
    lines = []
    for e in entries[:max_entries]:
        tags_str = ', '.join(str(t) for t in e.get('tags', []))
        desc = e.get('desc', '')[:80]
        line = f"{e['stem']} | tags: {tags_str} | {desc}"
        lines.append(line)
    if len(entries) > max_entries:
        lines.append(f"(truncated, {len(entries) - max_entries} more)")
    return '\n'.join(lines)


def apply_links(vault_dir: Path, results_dir: Path, stem_to_path: dict[str, str]):
    """Apply link results to vault files — append ## Related section."""
    applied = 0
    for rp_file in sorted(results_dir.glob('batch-*-results.json')):
        data = json.loads(rp_file.read_text())
        for item in data.get('results', []):
            path = vault_dir / item['path']
            if not path.exists():
                continue
            matched = item.get('matched_links', [])
            if not matched:
                continue

            content = path.read_text(errors='replace')

            # Build wikilink targets for new stems
            new_targets = {}
            for stem in matched:
                rp_target = stem_to_path.get(stem, stem)
                wikilink_target = rp_target[:-3] if rp_target.endswith('.md') else rp_target
                new_targets[stem] = wikilink_target

            if '## Related' in content:
                # Parse existing links and deduplicate
                related_idx = content.index('## Related')
                related_section = content[related_idx:]
                existing_links = extract_wikilinks(related_section)
                existing_stems = {Path(link).stem for link, _ in existing_links}
                new_stems = [s for s in matched if s not in existing_stems]
                if not new_stems:
                    continue
                # Find end of ## Related section (next ## or EOF)
                rest = content[related_idx + len('## Related'):]
                next_heading = rest.find('\n## ')
                if next_heading >= 0:
                    insert_pos = related_idx + len('## Related') + next_heading
                    new_lines = '\n'.join(f"- [[{new_targets[s]}]]" for s in new_stems)
                    content = content[:insert_pos] + '\n' + new_lines + content[insert_pos:]
                else:
                    new_lines = '\n'.join(f"- [[{new_targets[s]}]]" for s in new_stems)
                    content = content.rstrip() + '\n' + new_lines + '\n'
            else:
                # Create new ## Related section
                link_lines = [f"- [[{new_targets[s]}]]" for s in matched]
                section = "\n\n## Related\n" + '\n'.join(link_lines) + '\n'
                content = content.rstrip() + section

            path.write_text(content)
            applied += 1
    return applied


# ─── SWARM-LINKS SUBCOMMAND ──────────────────────────────

SWARM_LINKS_SYSTEM_PROMPT = """\
You are a link suggestion engine for an Obsidian vault.
For each file, pick 3-8 related notes FROM THE CATALOG BELOW.
CRITICAL RULES:
- ONLY return stems that appear EXACTLY in the catalog. Do NOT invent new names.
- Pick notes that are semantically related by topic, domain, tags, or content.
- Do NOT suggest the file's own stem.
- Do NOT suggest stems already in its existing links.

CATALOG ({domain}):
{catalog_text}"""

SWARM_LINKS_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "links": {"type": "array", "items": {"type": "string"}}
                },
                "required": ["path", "links"],
                "additionalProperties": False
            }
        }
    },
    "required": ["results"],
    "additionalProperties": False
}


def _process_swarm_link_batch(batch_id: str, files: list[dict],
                               catalog_text: str, domain: str,
                               all_stems: set[str], model: str,
                               delay: float, output_dir: Path,
                               force: bool) -> dict | None:
    """Process a single swarm-link batch with strict set membership validation."""
    result_path = output_dir / f'{batch_id}-results.json'

    if result_path.exists() and not force:
        return json.loads(result_path.read_text())

    if delay > 0:
        time.sleep(delay + random.uniform(0, delay * 0.5))

    # Build user message with file summaries
    file_list = []
    for f in files:
        tags_str = ', '.join(f.get('tags', [])[:10])
        links_str = ', '.join(f.get('existing_links', [])[:5])
        file_list.append(
            f"### {f['path']}\nType: {f['type']} | Domain: {f['domain']} | Tags: {tags_str}\n"
            f"Existing links: {links_str}\n{f['summary'][:300]}"
        )

    user_msg = "Suggest links for these files:\n\n" + "\n\n".join(file_list)
    system_msg = SWARM_LINKS_SYSTEM_PROMPT.format(
        domain=domain, catalog_text=catalog_text
    )

    try:
        result = call_openrouter(
            messages=[
                {"role": "system", "content": system_msg},
                {"role": "user", "content": user_msg},
            ],
            response_schema=SWARM_LINKS_RESPONSE_SCHEMA,
            model=model,
            schema_name="swarm_link_results",
        )

        # Post-process: strict set membership (no fuzzy)
        enriched = []
        for item in result.get('results', []):
            raw_links = item.get('links', [])
            file_path = item.get('path', '')
            file_stem = Path(file_path).stem

            # Get existing links for this file
            existing = set()
            for f in files:
                if f['path'] == file_path:
                    existing = set(f.get('existing_links', []))
                    break

            # Match: try raw value first, then extract stem from path
            valid = []
            seen = set()
            for s in raw_links:
                # Try as-is first (exact stem)
                matched_stem = s if s in all_stems else None
                # If not found, try extracting stem from path-like value
                if not matched_stem:
                    extracted = Path(s).stem
                    if extracted in all_stems:
                        matched_stem = extracted
                # Also strip .md suffix if present
                if not matched_stem and s.endswith('.md'):
                    bare = Path(s[:-3]).stem
                    if bare in all_stems:
                        matched_stem = bare
                if (matched_stem
                        and matched_stem != file_stem
                        and matched_stem not in existing
                        and matched_stem not in seen):
                    valid.append(matched_stem)
                    seen.add(matched_stem)

            enriched.append({
                'path': file_path,
                'links_raw': raw_links,
                'matched_links': valid,
            })

        output = {
            'batch_id': batch_id,
            'results': enriched,
            'validation': {
                'file_count': len(files),
                'result_count': len(enriched),
                'total_raw': sum(len(r.get('links_raw', [])) for r in enriched),
                'total_matched': sum(len(r.get('matched_links', [])) for r in enriched),
            },
        }
        result_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
        return output
    except Exception as e:
        error_path = output_dir.parent / 'errors' / f'{batch_id}-error.json'
        error_path.parent.mkdir(parents=True, exist_ok=True)
        error_path.write_text(json.dumps({
            'batch_id': batch_id, 'error': str(e), 'timestamp': datetime.now().isoformat(),
        }, indent=2) + '\n')
        print(f"  ERROR {batch_id}: {e}", file=sys.stderr)
        return None


def cmd_swarm_links(vault_dir: Path, apply: bool = False, budget: int = 100000,
                     model: str = 'google/gemini-2.0-flash-001', force: bool = False,
                     delay: float = 0.3, workers: int = 5):
    """Swarm-links enrichment: catalog-oriented link suggestions."""
    vault_dir = vault_dir.resolve()

    # Single vault walk: stems + catalog + link entries
    all_stems, stem_to_path, catalog, entries = scan_vault_for_links(vault_dir, force)
    print(f"Vault stems: {len(all_stems)}")
    print(f"Catalog domains: {len(catalog)} ({', '.join(f'{d}:{len(v)}' for d, v in catalog.items())})")
    print(f"Files needing links: {len(entries)}")
    if not entries:
        print("Nothing to do.")
        return

    # 4. Output dir
    output_dir = vault_dir / '.graph' / 'enrich' / 'swarm-links'
    output_dir.mkdir(parents=True, exist_ok=True)

    # 5. Group entries by domain, prepare batches
    domain_entries = {}
    for e in entries:
        d = e.get('domain', '') or 'general'
        domain_entries.setdefault(d, []).append(e)

    api_tasks = []
    batch_num = 0
    for domain, d_entries in domain_entries.items():
        # Build catalog text for this domain + cross-domain top stems
        domain_catalog = catalog.get(domain, [])
        # Add top-30 stems from other domains for cross-domain links
        cross_entries = []
        for other_d, other_entries in catalog.items():
            if other_d != domain:
                cross_entries.extend(other_entries[:30])
        combined = domain_catalog + cross_entries
        cat_text = format_catalog(combined)

        for chunk in chunk_list(d_entries, FILES_PER_SWARM_CALL):
            batch_num += 1
            api_tasks.append((f'batch-{batch_num:03d}', chunk, cat_text, domain))

    print(f"API batches: {len(api_tasks)}")

    # 6. Process with ThreadPoolExecutor
    results = []
    errors = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_process_swarm_link_batch, bid, files, cat_text, domain,
                        all_stems, model, delay, output_dir, force): bid
            for bid, files, cat_text, domain in api_tasks
        }
        for future in as_completed(futures):
            bid = futures[future]
            try:
                result = future.result()
                if result:
                    with _results_lock:
                        results.append(result)
                    v = result.get('validation', {})
                    print(f"  OK {bid}: {v.get('total_matched', 0)}/{v.get('total_raw', 0)} links matched")
                else:
                    errors += 1
            except Exception as e:
                errors += 1
                print(f"  FAIL {bid}: {e}", file=sys.stderr)

    # 7. Run metadata
    total_raw = sum(r.get('validation', {}).get('total_raw', 0) for r in results)
    total_matched = sum(r.get('validation', {}).get('total_matched', 0) for r in results)
    meta = {
        'mode': 'swarm-links',
        'total_files': len(entries),
        'total_batches': len(api_tasks),
        'total_links_raw': total_raw,
        'total_links_matched': total_matched,
        'match_rate': round(total_matched / total_raw * 100, 1) if total_raw > 0 else 0,
        'errors': errors,
        'model': model,
        'validation': 'strict_set_membership',
        'timestamp': datetime.now().isoformat(),
    }
    (output_dir / 'run-meta.json').write_text(json.dumps(meta, indent=2) + '\n')
    print(f"\nDone: {total_matched}/{total_raw} links matched ({meta['match_rate']}%), {errors} errors")

    # 8. Apply (reuse apply_links)
    if apply:
        applied = apply_links(vault_dir, output_dir, stem_to_path)
        print(f"Applied links to {applied} files")


# ─── CLI ──────────────────────────────────────────────────

def parse_args(args: list[str]) -> dict:
    """Parse CLI arguments."""
    if len(args) < 2:
        print("Usage: enrich.py {tags|swarm-links} <vault-dir> [options]", file=sys.stderr)
        sys.exit(1)

    cmd = args[0]
    vault_dir = Path(args[1])

    # Defaults vary by subcommand
    budgets = {'tags': 50000, 'swarm-links': 100000}
    delays = {'swarm-links': 0.3}
    worker_counts = {'swarm-links': 5}
    models = {'swarm-links': 'google/gemini-2.0-flash-001'}

    opts = {
        'cmd': cmd,
        'vault_dir': vault_dir,
        'apply': False,
        'budget': budgets.get(cmd, 70000),
        'model': models.get(cmd, DEFAULT_MODEL),
        'force': False,
        'delay': delays.get(cmd, 0.5),
        'workers': worker_counts.get(cmd, 3),
    }

    i = 2
    while i < len(args):
        a = args[i]
        if a == '--apply':
            opts['apply'] = True
        elif a == '--force':
            opts['force'] = True
        elif a == '--budget' and i + 1 < len(args):
            i += 1
            opts['budget'] = int(args[i])
        elif a == '--model' and i + 1 < len(args):
            i += 1
            opts['model'] = args[i]
        elif a == '--delay' and i + 1 < len(args):
            i += 1
            opts['delay'] = float(args[i])
        elif a == '--workers' and i + 1 < len(args):
            i += 1
            opts['workers'] = int(args[i])
        i += 1

    return opts


def main():
    opts = parse_args(sys.argv[1:])

    if not opts['vault_dir'].is_dir():
        print(f"Not a directory: {opts['vault_dir']}", file=sys.stderr)
        sys.exit(1)

    if opts['cmd'] == 'tags':
        cmd_tags(opts['vault_dir'], opts['apply'], opts['budget'],
                 opts['model'], opts['force'], opts['delay'], opts['workers'])
    elif opts['cmd'] == 'swarm-links':
        cmd_swarm_links(opts['vault_dir'], opts['apply'], opts['budget'],
                         opts['model'], opts['force'], opts['delay'], opts['workers'])
    else:
        print(f"Unknown command: {opts['cmd']}. Use 'tags' or 'swarm-links'.", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
