# Daily → cards processor

Turn a day's raw notes (`daily/YYYY-MM-DD.md`) into durable, linked cards. This is
**judgment-first**: you (the model) classify, tag, and link; the Python scripts do only
mechanical work (extract candidates, repair links, MOC, decay, touch). It is a specific
application of Workflow 3 (CREATE / UPDATE) run over a whole day of notes.

## Inputs

- `daily/YYYY-MM-DD.md` — the day's raw log. (Format is vault-specific; autograph does
  not prescribe one. `daily.py` finds **Bold Name** patterns as a starting point.)
- `schema.json` — types, statuses, domains (single source of truth).
- Existing cards under the vault — for dedup and linking.

## Idempotency

Append a marker to the **end** of the daily file when done; never edit existing lines:

```
<!-- autograph-processed: YYYY-MM-DDTHH:MM cards=N -->
```

On a re-run, treat content **above the last marker** as already processed — only pick up
new lines. If a card for an item already exists, UPDATE/NOOP it (see below), never
duplicate.

## Phase 1 — CAPTURE

```bash
uv run scripts/daily.py extract <daily-dir> <vault-dir> [YYYY-MM-DD]   # mechanical candidates → .graph/daily-extract-<date>.json
uv run scripts/supersede.py <vault-dir>                                # refresh conflict scan
```

Read the day's notes and the extract JSON, read `schema.json` `node_types`, then list the
**noteworthy items** — a person/org/project that recurs, a decision with a reason, an idea
worth revisiting, a durable fact. Skip logistics, small talk, transient status. When
unsure, prefer fewer, richer cards. Also note the day's 2–6 **topics**.

## Phase 2 — PROCESS (per item)

For each item, run the Workflow 3 **Step 0 dedup-first** decision
(`references/update-in-place.md`):

- **ADD** — no existing card → create it (`type`/`status`/folder from schema only).
- **NOOP** — already captured, unchanged → skip.
- **UPDATE** — same subject, new enrichment → sharpen `description`, add tags, append a
  dated `## Log` line.
- **SUPERSEDE** — new fact contradicts a current value → rewrite Compiled Truth, old value
  to append-only `## History`.

Resolve **every** entry in `.graph/supersede-candidates.json` while you are here.

## Phase 3 — LINK

Apply the Workflow 3 linking protocol to each created/updated card: a `## Related`
section with the domain hub + 2–3 sibling cards, then `engine.py touch`. No orphans.

## Phase 4 — SUMMARIZE (schema-gated, optional)

**Only if** the schema's `node_types` defines a summary type (e.g. a `daily-summary`):
write one summary card for the day with its `## Topics` and a MOC linking down to the
cards created today and to the raw daily file (and up to the week, if the schema defines
that layer). No hardcoded summary DAG — if the schema has no summary type, skip this
phase.

## Mechanical pass (after writing cards)

```bash
uv run scripts/enforce.py <vault-dir> --apply     # schema compliance + autofix
uv run scripts/graph.py fix <vault-dir> --apply   # repair broken wikilinks
uv run scripts/moc.py generate <vault-dir>        # regenerate MOCs
uv run scripts/engine.py decay <vault-dir>        # recompute relevance/tiers
uv run scripts/graph.py health <vault-dir>        # confirm score
```

## Return

A short report: `created` / `updated` / `superseded` counts + the day's topics.
Quiet day (no noteworthy items) is fine — record the topics, do not manufacture cards.
