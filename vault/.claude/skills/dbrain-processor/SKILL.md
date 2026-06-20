---
name: dbrain-processor
description: >-
  Eva's daily-memory processor. Reads the day's two-sided transcript
  (vault/daily/YYYY-MM-DD.md), distills noteworthy entities / decisions / ideas
  into typed autograph cards, links them into the graph, and produces a
  daily-summary card (topics + MOC) that navigates down to the raw transcript and
  up to the week. Model-agnostic — runs on any LLM driving the vault (Eva uses
  DeepSeek). Triggered by the daily rollup (scripts/memory/rollup.ts daily).
depends_on: [autograph]
---

# dbrain-processor — daily transcript → cards + summary

Turn one day of raw conversation into durable, navigable memory.

This skill is **judgment-first**: the model (you) does the classification, tagging,
and linking. The autograph Python scripts are used only for mechanical work
(enforce schema, repair links, generate MOCs, decay, touch). `enrich.py` is **never**
used — you are the enrichment.

## Inputs

- `vault/daily/YYYY-MM-DD.md` — the day's raw two-sided transcript
  (`## HH:MM [text|voice|video|photo|forward from: …]` for the user,
  `## HH:MM [eva]` for Eva's replies). See `.claude/rules/daily-format.md`.
- `vault/.claude/skills/autograph/schema.json` — the vault schema (types, domains, decay).
- Existing cards under `vault/cards/**` and prior summaries under
  `vault/summaries/`, `vault/weekly|monthly|yearly/` — for linking and dedup.

## Outputs

1. Zero or more **entity/decision/idea cards** under `vault/cards/<kind>/`.
2. One **daily-summary card** at `vault/summaries/daily/YYYY-MM-DD.md`.
3. A processing marker appended to the raw daily file (never edit existing entries).

## Layout & types (from schema.json)

| What | Folder | type |
|------|--------|------|
| Raw transcript (read-only log) | `daily/YYYY-MM-DD.md` | — (not a card) |
| Daily summary | `summaries/daily/YYYY-MM-DD.md` | `daily-summary` |
| Weekly / monthly / yearly summary | `weekly/`, `monthly/`, `yearly/` | `*-summary` |
| Knowledge note / thought | `cards/notes/` | `note` |
| Person / org | `cards/contacts/` | `contact` |
| Project | `cards/projects/` | `project` |
| Idea / proposal | `cards/ideas/` | `idea` |
| Decision | `cards/decisions/` | `decision` |

Always pick `type` and `status` from `schema.json` → `node_types`. Never invent a status.

## Flow (4 phases)

1. **CAPTURE** (`phases/capture.md`) — read the transcript, segment it, and decide
   what is noteworthy: which entities, decisions, ideas, and topics the day produced.
2. **PROCESS** (`phases/process.md`) — create / update cards for the noteworthy items,
   choosing type + description-snippet + tags + status; dedup against existing cards.
3. **LINK** (`phases/link.md`) — wire every new card to its domain hub + 2–3 neighbors.
4. **SUMMARIZE** (`phases/summarize.md`) — write the daily-summary card: the day's
   TOPICS plus a MOC linking up to the week, down to the created cards, and down to
   the raw daily transcript. Then run the mechanical autograph pass.

## Mechanical pass (after writing cards & summary)

Run from the vault root. Scripts live under `.claude/skills/autograph/scripts/`
(reference them by this relative path):

```bash
# dry-run first, then --apply
uv run .claude/skills/autograph/scripts/enforce.py . --apply        # schema compliance + autofix
uv run .claude/skills/autograph/scripts/graph.py fix . --apply      # repair broken wiki-links
uv run .claude/skills/autograph/scripts/engine.py touch summaries/daily/YYYY-MM-DD.md
uv run .claude/skills/autograph/scripts/moc.py generate .           # regenerate domain MOCs
uv run .claude/skills/autograph/scripts/engine.py decay .           # recompute relevance/tiers
uv run .claude/skills/autograph/scripts/graph.py health .           # confirm score
```

If `uv` / Python is unavailable, still produce the cards and summary (they are plain
Markdown) and let the nightly doctor run the mechanical pass later.

## Hard rules

- **Never modify existing transcript entries.** Append only a processing marker (see
  `.claude/rules/daily-format.md`).
- **No orphans.** Every card created here must link to a hub and ≥2 neighbors before
  you finish (`phases/link.md`).
- **description is a search snippet, not the title.** One line, what/why, ~150 chars.
- **tags:** 2–5, lowercase, kebab-case.
- **Idempotent.** If the daily file already carries a processing marker and a
  `summaries/daily/YYYY-MM-DD.md` exists, only reconcile new entries; do not duplicate cards.
- **Quiet days are fine.** No noteworthy entities → still write a short daily-summary
  with topics and the MOC down to the raw transcript. Do not manufacture cards.

## References

- `references/classification.md` — what becomes a card vs. stays in the transcript.
- `references/card-templates.md` — frontmatter templates per type.
- `references/linking.md` — hub + neighbor linking protocol.
- `references/daily-summary.md` — the daily-summary card spec (topics + MOC).
- `.claude/skills/autograph/SKILL.md` — the typed vault engine (graph, decay, MOC, dedup).
- `.claude/rules/{daily,weekly,monthly,yearly}-format.md` — format + DAG navigation rules.
