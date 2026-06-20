# Workflow 1: BOOTSTRAP (raw vault → structured graph)

**When to use:** New vault, bulk import, first setup. Run once, then switch to HEALTH workflow for maintenance.

## Phase 1: Discover (scan vault, find natural patterns)

```bash
python3 scripts/discover.py <vault-dir> --verbose > /tmp/discovery.json
```

Outputs JSON: all frontmatter field values, folder structure, wikilink patterns, tag frequency. This is raw data — not yet a schema.

## Phase 2: Generate schema (CRITICAL — TWO STEPS, NEVER SKIP)

**THIS PHASE HAS TWO MANDATORY PARTS. BOTH MUST RUN. NEVER SKIP THE AGENT SWARM.**

### Step 2A: Script baseline

```bash
python3 scripts/generate_schema.py /tmp/discovery.json /tmp/schema-draft.json
```

Produces a mechanical draft from enum data. For vaults with existing frontmatter this may be sufficient. For vaults without frontmatter (imports, fresh vaults, mixed dumps) the script output will be nearly empty — this is expected.

### Step 2B: Agent swarm enrichment (MANDATORY — map-reduce)

**NEVER SKIP THIS STEP.** No deterministic script can classify unstructured notes. Only LLM agents can read actual content and propose meaningful types, domains, and enums.

Uses a map-reduce architecture: `swarm_prepare.py` splits vault into non-overlapping batches, parallel haiku agents classify (Wave 1), `swarm_reduce.py` consolidates, a single sonnet agent produces the final schema (Wave 2).

#### Preparation

```bash
python3 scripts/swarm_prepare.py <vault-dir> /tmp/discovery.json [--budget 50000]
```

Walks vault, estimates tokens per file (~4 bytes/token), greedy bin-packs into batches of ~50K tokens. Writes manifests to `.graph/swarm/manifests/batch-NNN.json`. Each batch contains a non-overlapping file list + seed types extracted from discovery + generate_schema.

**Key guarantees:**
- Files are never duplicated across batches
- Each batch stays within token budget
- Seed types minimize novel type proliferation

#### Wave 1: Classify (parallel haiku agents)

For each manifest in `.graph/swarm/manifests/`:

1. Read the manifest JSON to get file list + seed types
2. Launch a haiku agent with the Wave 1 prompt (embedded in swarm-meta.json)
3. Agent reads each file, outputs one JSONL line per file
4. Save output to `.graph/swarm/classifications/batch-NNN.jsonl`

JSONL format per line:
```json
{"path":"<path>","proposed_type":"<type>","proposed_domain":"<domain>","summary":"<120 chars>","seed_match":true,"confidence":"high|medium|low"}
```

#### Consolidation

```bash
python3 scripts/swarm_reduce.py prepare <vault-dir> [discovery.json] [draft-schema.json]
```

Reads all `.graph/swarm/classifications/*.jsonl`, counts type/domain frequencies, identifies novel types (not in seed), writes `consolidation.json` for Wave 2.

#### Wave 2: Reduce (single sonnet agent)

Give the sonnet agent `consolidation.json` contents. It produces a complete schema.json with all 11 sections. Rules: target 5-10 node_types, merge types with <5 files, novel types need >10 files to survive.

Save output to `/tmp/wave2-schema.json`.

#### Finalization

```bash
python3 scripts/swarm_reduce.py finalize /tmp/wave2-schema.json schema.json
```

Validates the schema: all 11 sections present, each node_type has description/required/status, aliases point to real types, status_order covers all statuses, 3-15 types (sanity check). If valid → writes schema.json. If invalid → saves draft to `.graph/swarm/schema-draft-invalid.json` with errors.

#### Intermediate files

```
.graph/swarm/
  manifests/batch-001.json ...   # Wave 1 inputs (file lists per batch)
  classifications/batch-001.jsonl ...  # Wave 1 outputs (JSONL per batch)
  consolidation.json             # Wave 2 input (frequencies + all classifications)
  swarm-meta.json                # Run metadata + prompt templates
```

**Why this step is critical:**
- Script works on enum frequency only — if vault has no frontmatter, it produces nothing useful
- Agents actually READ file content and understand what type of note it is
- A vault with 1000 imported notes and zero frontmatter needs intelligent classification, not pattern matching
- Skipping this step = applying a near-empty schema = useless enforce results
- **Map-reduce prevents context overflow: each agent sees only its batch (~50K tokens)**

**Schema structure (11 required sections):**
- `node_types` — valid types with status enums per type
- `type_aliases` — old→new type mappings (auto-fixed on enforce)
- `field_fixes` — typo corrections per field
- `domain_inference` — folder prefix→domain mapping
- `path_type_hints` — folder→type inference
- `status_order` — sort priority for MOC
- `status_defaults` — default status by type
- `richness_fields` — dedup scoring fields
- `entity_extraction` — daily.py config
- `decay` — rate, floor, tier thresholds, domain_rates
- `ignore_tags` — tags to skip

Full reference: `references/schema-reference.md`

## Phase 3: Review (human approves schema)

Present schema to user. They approve, adjust, or reject. Never auto-apply a generated schema.

## Phase 4: Bootstrap + Enforce (frontmatter + structural fields)

```bash
python3 scripts/engine.py init <vault-dir> --dry-run     # bootstrap bare files
python3 scripts/engine.py init <vault-dir>                # apply
python3 scripts/enforce.py <vault-dir> schema.json        # dry run
python3 scripts/enforce.py <vault-dir> schema.json --apply # apply
```

Bootstrap adds frontmatter to bare files. Enforce auto-fixes: type aliases, missing types (inferred from path), status typos, missing domains, missing system fields. Flags for review: missing descriptions, missing tags, unknown statuses.

## Phase 5: Link Cleanup (remove phantom wikilinks)

```bash
python3 scripts/link_cleanup.py <vault-dir>              # dry run
python3 scripts/link_cleanup.py <vault-dir> --apply
```

Cleans historical phantom wikilinks from `## Related` sections. Checks every link target against real vault stems. Broken links are removed; if all links in a section are broken, the section is deleted. Body links outside `## Related` are never touched. Report written to `.graph/link-cleanup-report.json`.

Run BEFORE tag/link enrichment so the enricher works on clean files.

## Phase 6: Tag Enrich (tags via OpenRouter API)

```bash
OPENROUTER_API_KEY=sk-... python3 scripts/enrich.py tags <vault-dir>           # dry run
OPENROUTER_API_KEY=sk-... python3 scripts/enrich.py tags <vault-dir> --apply   # apply
```

Collects seed tags from vault, finds files with empty/missing tags, batches them into API calls via OpenRouter (default model: `google/gemini-3-flash-preview`). LLM assigns 1-5 lowercase hyphenated tags per file, strongly preferring seed tags. Results cached in `.graph/enrich/tags/`. Concurrent via `ThreadPoolExecutor` (default 3 workers).

Options: `--budget N` (token budget per batch), `--model MODEL`, `--force` (re-process all), `--delay N` (seconds between calls), `--workers N`.

## Phase 7: Deduplicate

```bash
python3 scripts/dedup.py <vault-dir>              # report
python3 scripts/dedup.py <vault-dir> --apply       # merge + trash
```

Finds same-slug files in different folders. Picks canonical by content richness (primary) + path depth (tiebreaker). Merges unique content, redirects wikilinks, moves extras to `.trash/`. Run BEFORE link enrichment so links point to canonical files.

## Phase 8: Link Enrich — Swarm Links (CATALOG-ORIENTED)

**USE `swarm-links`, NOT `links`.** This is the proven approach.

```bash
OPENROUTER_API_KEY=sk-... python3 scripts/enrich.py swarm-links <vault-dir>           # dry run
OPENROUTER_API_KEY=sk-... python3 scripts/enrich.py swarm-links <vault-dir> --apply   # apply
OPENROUTER_API_KEY=sk-... python3 scripts/enrich.py swarm-links <vault-dir> --apply --force  # re-enrich all files
```

### How it works

1. **Build catalog** — `build_catalog()` scans vault, groups files by domain into `{domain: [{stem, type, tags, desc}]}`
2. **Format for LLM** — `format_catalog()` renders entries as text table (stem | tags | first line of content), max 800 entries per domain
3. **Cross-domain bridging** — Each domain catalog gets top-30 stems from other domains to prevent domain silos
4. **LLM picks from catalog** — Prompt explicitly says "ONLY return stems from the catalog, do NOT invent new names"
5. **Strict set validation** — No fuzzy matching. Response stems checked against `all_stems` set. Also extracts stem from path-like responses (`Path(s).stem`) since LLMs sometimes return full paths
6. **Self-link & duplicate filtering** — Removes file's own stem and already-existing links
7. **Apply** — Appends `## Related` section with matched wikilinks (reuses `apply_links()`)

### Defaults

| Parameter | Value | Why |
|-----------|-------|-----|
| Model | `google/gemini-2.0-flash-001` | Cheap, fast, follows catalog instructions well |
| Files per batch | 8 | Catalog takes ~5K tokens, leave room for files |
| Workers | 5 | Flash handles high parallelism |
| Delay | 0.3s | Lower latency, Flash is cheap |
| Validation | Strict set membership | Zero phantom links — only exact stems pass |

### Why NOT `links` (legacy)

The old `enrich.py links` approach asks LLM to "generate natural, descriptive names" WITHOUT providing a stem catalog. Then Python fuzzy-matches suggestions against real vault stems (SequenceMatcher + Jaccard, threshold 0.75).

**Results in practice:**
- `links`: **10 out of 3260 suggestions matched (0.3%)** — catastrophic failure
- `swarm-links`: **3488 out of 4277 matched (81.6%)** — works

The root cause: LLM invents names like "machine learning fundamentals" but the vault stem is "ml-basics" or in Russian. Fuzzy matching can't bridge that gap. Catalog-based approach eliminates hallucination entirely.

**`links` is kept for backward compatibility but should NOT be used. Always use `swarm-links`.**

### Key lesson: path-to-stem extraction

LLMs sometimes return full paths (`Inbox/imports/DESCRIBE`) instead of bare stems (`DESCRIBE`). The validation layer handles this:
1. Try raw value against stems set
2. If no match, extract `Path(s).stem` and try again
3. If `.md` suffix present, strip it and retry

This raised match rate from 52% to 81.6% in testing.

### Intermediate files

```
.graph/enrich/
  swarm-links/
    batch-001-results.json   # {batch_id, results: [{path, links_raw, matched_links}], validation}
    run-meta.json            # {mode, total_files, match_rate, model, validation method}
  tags/
    batch-001-results.json
    run-meta.json
  errors/
    batch-NNN-error.json     # Only on failures
```

### Recommended run order

1. `swarm-links .` — dry run, check match rate in output
2. `swarm-links . --apply` — apply to files with <2 links
3. `swarm-links . --apply --force` — re-enrich ALL files (second pass catches stragglers)
4. `link_cleanup.py . --apply` — clean any broken links after enrichment
5. `graph.py health .` — verify health score improved

## Phase 9: MOC Generation

```bash
python3 scripts/moc.py generate <vault-dir>
python3 scripts/moc.py generate <vault-dir> --domain work
```

Generates index files per domain with wikilinks grouped by type and sorted by status.

## Phase 10: Verify

```bash
python3 scripts/graph.py health <vault-dir>
python3 scripts/enforce.py <vault-dir> schema.json
```

Target: 90+/100 on both scores.

## Proven Results (production run, 864 files)

| Metric | Before enrichment | After swarm-links |
|--------|------------------|-------------------|
| Health Score | 66.4 | **80.6** |
| Total links | ~1750 | **4963** |
| Avg links/file | 2.03 | **5.74** |
| Dead-ends | 164+ | **55** |
| Orphan files | 9 | **7** |
| Files with ## Related | ~200 | **777 (90%)** |
| Match rate (links) | 0.3% | N/A (deprecated) |
| Match rate (swarm-links) | N/A | **81.6%** |
| API cost (Gemini Flash) | — | ~$0.10 total |
