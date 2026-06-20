---
name: autograph
description: >-
  Schema-as-code enforcement for any Obsidian vault. Zero hardcoded domains.
  Use when creating vault cards, checking vault health, running schema compliance,
  deduplicating entities, generating MOC indexes, running decay cycles, bootstrapping
  a vault, fixing wikilinks, finding orphans or backlinks, extracting entities from
  daily files, or touching/promoting cards.
  Do NOT use for content generation or non-vault file operations.
  For quick health checks without schema enforcement, prefer vault-health skill.
---

# autograph — typed vault engine

One schema. One graph. Works on any vault.

## Overview

No hardcoded domains, types, or paths. The agent discovers structure from data, builds a schema, then enforces it. All scripts share `common.py`. Zero external dependencies (stdlib only, API calls via urllib).

## Quick Reference: 5 Workflows

| Workflow | When to use | Entry point |
|----------|-------------|-------------|
| **BOOTSTRAP** | New vault / after import / first setup | `discover.py` → `enforce.py` → `graph.py health` |
| **HEALTH** | Daily maintenance / on request | `graph.py health` → fix → moc → decay |
| **CREATE** | New knowledge card | Schema lookup → write file → link → touch |
| **SEARCH & LINK** | Find info + strengthen connections | Hub → links → target; `graph.py orphans` → connect |
| **ORCHESTRATE** | Automated multi-agent workflows (no API keys) | `orchestrate.py health\|bootstrap` |

---

## Workflow 1: BOOTSTRAP (raw vault → structured graph)

**When to use:** New vault, bulk import, first setup. Run once, then switch to HEALTH.

**Full guide:** `references/bootstrap-workflow.md`

### Summary (10 phases)

1. **Discover:** `uv run scripts/discover.py <vault-dir> --verbose > /tmp/discovery.json`
2. **Generate schema:** Script baseline (`generate_schema.py`) + **agent swarm** (`swarm_prepare.py` → Wave 1 haiku → `swarm_reduce.py` → Wave 2 sonnet). **NEVER skip the swarm.**
3. **Review:** Human approves schema. Never auto-apply.
4. **Bootstrap + Enforce:** `engine.py init` + `enforce.py --apply`
5. **Link cleanup:** `link_cleanup.py --apply` (before enrichment)
6. **Tag enrich:** `enrich.py tags --apply` (via OpenRouter API)
7. **Deduplicate:** `dedup.py --apply` (before link enrichment)
8. **Link enrich:** `enrich.py swarm-links --apply` (**always swarm-links, never links**)
9. **MOC generation:** `moc.py generate`
10. **Verify:** `graph.py health` + `enforce.py` → target 90+/100

### Critical Rules

- **Always run Phase 2B (agent swarm).** Script alone cannot classify unstructured content.
- **Always use `swarm-links`**, not `links` (0.3% vs 81.6% match rate).
- **Always dry-run first** — run without `--apply` before applying.
- **Dedup before link enrich** — prevents links to merged/trashed files.

---

## Workflow 2: HEALTH (daily graph maintenance)

**When to use:** Daily upkeep, after edits, or when health score drops. This is the most common workflow.

### Decision Logic

```
1. Run `graph.py health <vault-dir>` → check score
2. If health < 90 → investigate:
   a. broken_links > 0  → `graph.py fix <vault-dir> --apply`
   b. orphans > 5       → connect orphans to hub files (see Workflow 4)
   c. desc_coverage < 70% → add descriptions to files missing them
3. Run `moc.py generate <vault-dir>` → regenerate indexes
4. Run `engine.py decay <vault-dir>` → recalculate relevance + tiers
5. Run `graph.py health <vault-dir>` → confirm improvement
```

### Thresholds & Action Triggers

| Metric | Good | Action needed |
|--------|------|---------------|
| Health score | ≥90 | <90: investigate broken links, orphans |
| Broken links | 0 | >0: `graph.py fix --apply` |
| Orphan files | <5 | ≥5: connect to hubs (Workflow 4) |
| Description coverage | ≥80% | <70%: add descriptions |
| Stale cards (>90d) | <20% | >30%: `engine.py creative` to resurface |

### Commands

```bash
uv run scripts/graph.py health <vault-dir>           # health check
uv run scripts/graph.py fix <vault-dir> --apply       # fix broken links
uv run scripts/moc.py generate <vault-dir>            # regenerate MOCs
uv run scripts/engine.py decay <vault-dir>            # decay cycle (Ebbinghaus)
uv run scripts/engine.py decay <vault-dir> --dry-run  # preview decay changes
uv run scripts/engine.py stats <vault-dir>            # tier distribution
uv run scripts/engine.py creative 5 <vault-dir>       # resurface forgotten cards
```

---

## Workflow 3: CREATE (new card with immediate linking)

**When to use:** Creating any new vault card. Always link immediately — orphan cards are wasted knowledge.

### Steps

1. **Type:** Pick from schema `node_types`
2. **Path:** Reverse-lookup `domain_inference` to find target folder:
   ```python
   # domain_inference maps path→domain. To find folder for domain "crm":
   for path_prefix, domain in schema['domain_inference'].items():
       if domain == 'crm':
           target_folder = path_prefix  # e.g. "work/crm/"
           break
   ```
3. **Frontmatter:** Write description (search snippet, not title repeat), tags (2-5, lowercase, kebab-case), status from type's enum
4. **LINKING PROTOCOL (mandatory):**
   a. Add `## Related` section with `[[hub]]` file of the domain
      - Hub = `_index.md` or `MEMORY.md` of that domain
   b. Find 2-3 sibling cards of same type+domain → add `[[links]]`
      - `uv run scripts/graph.py backlinks <vault> <hub>` → find siblings
      - Or: read vault-graph.json → filter nodes by type+domain
   c. Run `uv run scripts/engine.py touch <new-file>`
5. **Verify checklist:**
   - [ ] Hub linked?
   - [ ] 2+ related cards found?
   - [ ] description ≠ title repeat?
   - [ ] tags: 2-5, lowercase, kebab-case?
   - [ ] status ∈ schema enum?

Templates: `references/card-templates.md`

---

## Workflow 4: SEARCH & LINK (find + strengthen connections)

**When to use:** Looking up information in the vault, or strengthening weak areas of the graph.

### Navigation (Hub → Links → Target)

1. **Determine domain** from the topic (work, personal, research, etc. — whatever your schema defines)
2. **Start at hub:** `_index.md` or `MEMORY.md` of that domain
3. **Follow links** — max 2 hops from hub to target
4. **Fallback:** `uv run scripts/graph.py backlinks <vault> <target>` for reverse links

### Orphan Rescue

```bash
uv run scripts/graph.py orphans <vault-dir>        # find orphans
# For each orphan: connect to nearest hub or sibling card
```

### Link Strengthening

```bash
# Files with <2 links → enrich
OPENROUTER_API_KEY=sk-... uv run scripts/enrich.py swarm-links <vault-dir> --apply
uv run scripts/graph.py health <vault-dir>          # verify improvement
```

---

## Workflow 5: ORCHESTRATE (automated multi-agent workflows)

**When to use:** Instead of running scripts manually. No API keys — the Claude Code agent does all judgment directly.

### Phase 0: Script sequencing

```bash
python3 scripts/orchestrate.py health <vault-dir>      # automated health workflow
python3 scripts/orchestrate.py bootstrap <vault-dir>    # full bootstrap (one command)
```

`health` runs: graph check > fix broken links > link cleanup > MOC > decay > verify.
`bootstrap` runs: enforce > cleanup > tags > dedup > swarm-links > MOC > verify.

### Phases 1-3: Agent judgment (no API keys)

The agent (you) does the judgment directly — read prepared data, decide, write results.

```bash
# Phase 1: prep dedup clusters for YOUR review
python3 scripts/orchestrate.py dedup-prepare <vault-dir>
# -> writes .graph/dedup-review-input.json
# -> YOU read clusters, mark approved=true, then: dedup.py --apply-manifest

# Phase 2: prep domain catalogs for YOUR link suggestions
python3 scripts/orchestrate.py link-prepare <vault-dir>
# -> writes .graph/link-review-input.json
# -> YOU read catalogs, suggest links per domain, write batch results

# Phase 3: prep graph data for YOUR semantic analysis
python3 scripts/orchestrate.py graph-prepare <vault-dir>
# -> writes .graph/graph-analysis-input.json
# -> YOU analyze contradictions, missing links, stale hubs, write findings
```

For Phases 1-3: run the prep command, read the output JSON, do the analysis yourself (you ARE the LLM), write results back. Use Agent tool for parallel domain work in Phase 2.

---

---

## Decay Engine (Ebbinghaus)

The decay system models memory with three key mechanisms:

### 1. Access count (spacing effect)

Each `touch` increments `access_count` in frontmatter. More retrievals = slower forgetting:

```
strength = 1 + ln(access_count)
effective_rate = base_rate / strength
relevance = max(floor, 1.0 - effective_rate * days_since_access)
```

Example: a card touched 5 times has `strength = 1 + ln(5) ≈ 2.6`, decaying ~2.6x slower than a card touched once.

### 2. Domain-specific rates

Different content types decay at different rates. Configure in schema `decay.domain_rates`:

| Type | Rate | Half-life (~) | Rationale |
|------|------|---------------|-----------|
| contact | 0.005 | 100 days | People don't become irrelevant quickly |
| crm | 0.008 | 62 days | Deals have medium lifecycle |
| learning | 0.010 | 50 days | Knowledge fades moderately |
| project | 0.012 | 42 days | Projects have defined timelines |
| daily | 0.020 | 25 days | Daily notes lose relevance fast |
| (default) | 0.015 | 33 days | Fallback for unlisted types |

### 3. Graduated recall

Touch promotes one tier at a time, not a direct jump to active:

```
archive → cold → warm → active
```

Each promotion sets `last_accessed` to a midpoint date, so without re-touch the card naturally drifts back.

### Backward compatibility

- Files without `access_count` → default=1 → `1+ln(1)=1.0` → rate unchanged
- Files without `type` → default rate applies
- Existing calls `calc_relevance(days, schema)` → work unchanged (new params optional)

---

## Maintenance Commands

```bash
uv run scripts/moc.py generate <vault-dir>                                       # MOC generation
uv run scripts/engine.py decay <vault-dir>                                       # decay cycle
uv run scripts/engine.py touch <vault-dir>/path/card.md                          # touch (graduated)
uv run scripts/engine.py creative 5 <vault-dir>                                  # creative recall
uv run scripts/engine.py stats <vault-dir>                                       # stats
uv run scripts/graph.py backlinks <vault-dir> path/to/card                       # backlinks
uv run scripts/graph.py orphans <vault-dir>                                      # orphans
uv run scripts/graph.py fix <vault-dir> --apply                                  # fix links
uv run scripts/daily.py extract <memory-dir> <vault-dir>                         # entity extraction
uv run scripts/engine.py init <vault-dir> --dry-run                              # bootstrap bare files
OPENROUTER_API_KEY=sk-... uv run scripts/enrich.py swarm-links <vault-dir> --apply  # link enrichment
OPENROUTER_API_KEY=sk-... uv run scripts/enrich.py tags <vault-dir> --apply         # tag enrichment
uv run scripts/link_cleanup.py <vault-dir> --apply                               # link cleanup
```

## Scripts

| Script | Purpose |
|--------|---------|
| common.py | Shared: parse FM, walk, domain, decay (Ebbinghaus), wikilinks |
| discover.py | Workflow 1: scan vault, output enum candidates |
| generate_schema.py | Workflow 1: turn discovery JSON into draft schema |
| swarm_prepare.py | Workflow 1: bin-pack vault into agent batches |
| swarm_reduce.py | Workflow 1: consolidate + validate schema |
| enforce.py | Workflow 1: validate + autofix against schema |
| link_cleanup.py | Workflow 1/4: remove phantom wikilinks from ## Related |
| enrich.py | Workflow 1/4: tags + swarm-links (catalog-oriented link enrichment) |
| dedup.py | Workflow 1: safe merge + .trash/ |
| graph.py | Workflow 2/4: health score, link repair, backlinks, orphans |
| moc.py | Workflow 2: MOC generation per domain |
| orchestrate.py | Workflow 5: multi-agent orchestration (health, bootstrap, dedup-review, link-enrich, graph-analyze) |
| engine.py | Workflow 2/3: decay (Ebbinghaus), touch (graduated), creative, stats, init |
| daily.py | Entity extraction from memory files |
| test_autograph.py | Self-contained tests (~193 cases, temp fixtures) |

## Files

| File | In package? | Purpose |
|------|------------|---------|
| schema.example.json | Yes | Template — copy and customize (includes domain_rates) |
| schema.json | No | Your vault's schema (generated) |
| schema.local.json | No | Local override (gitignored) |
| references/ | Yes | Bootstrap workflow, schema docs, card templates, linking protocol |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| **Skipping agent swarm in Phase 2** | **CRITICAL: always run Step 2B. Script alone cannot classify unstructured content. No exceptions.** |
| **Using deprecated `links` subcommand** | **`links` was removed (0.3% match rate). Only `swarm-links` is available — 81.6% match rate.** |
| **Creating cards without linking** | **Always follow Workflow 3 — link to hub + 2 siblings immediately. Orphan cards are wasted knowledge.** |
| **Touching archive cards to active directly** | **Use graduated recall — touch promotes one tier at a time (archive→cold→warm→active).** |
| Sending full vault to one agent | Use `swarm_prepare.py` — bin-packs into ~50K token batches. |
| Running Wave 2 without Wave 1 | `swarm_reduce.py prepare` needs JSONL in `.graph/swarm/classifications/`. |
| Using schema.example.json directly | Run discover → generate your own schema.json |
| Description = title repeat | Write specific search snippet |
| Status not in enum | Check schema's node_types |
| Skip dry run | Always run without --apply first |
| Running link enrich before dedup | Creates links to files that get merged/trashed. Dedup first. |
| Missing OPENROUTER_API_KEY | `enrich.py` reads from `OPENROUTER_API_KEY` env var. |
| Only running swarm-links once | Run again with `--force` to enrich ALL files. |

## Default Models

| Command | Default model | Override |
|---------|--------------|----------|
| tags | google/gemini-3-flash-preview | `--model` flag |
| swarm-links | google/gemini-2.0-flash-001 | `--model` flag |

Both are production-tested. Do not change defaults without benchmarking.

## Troubleshooting

**Error: Schema not found** → Create schema.json from discover output, or pass path: `enforce.py vault/ my-schema.json`

**Score drops after enforce** → New files without frontmatter. Run `engine.py init vault/`

**Dedup picks wrong canonical** → Content richness wins. Enrich the right file first, re-run.

**Low match rate on swarm-links (<60%)** → Check if LLM returns paths instead of stems. Try `--force` for second pass.

**swarm-links shows 0 matched for some batches** → Usually network errors. Results are cached — rerun and only failed batches retry.
