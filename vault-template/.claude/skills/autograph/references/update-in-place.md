# Update-in-place: dedup-first, ADD / UPDATE / SUPERSEDE / NOOP

When new information arrives about something the vault may already track, the default
is **update the existing card, not create a new one**. A near-duplicate is the single
most common mistake. This is the contract for keeping one card = one subject.

## 1. Dedup-first (always, before creating)

Look up before you write:

```bash
uv run scripts/search.py "<entity name or key phrase>" --vault <vault-dir> --json
# fallback if search index is unavailable:
grep -ril "<entity name or key phrase>" <vault-dir>
```

- A hit that is the **same subject** → update it (below).
- No hit → create a new card via Workflow 3 (CREATE).

## 2. The operation model

For every fact, pick exactly one:

| Op | When | Action |
|----|------|--------|
| **ADD** | Genuinely new subject, no existing card | Create a card (Workflow 3) |
| **NOOP** | Already captured and unchanged | Do nothing |
| **UPDATE** | Same subject, new *enrichment* (no contradiction) | Sharpen `description`, add tags, append a dated line under `## Log`, re-`touch` |
| **SUPERSEDE** | New fact *contradicts* a current value | Rewrite current value + move old to `## History` (below) |

`type`, `status`, and the target folder come from **`schema.json` only** — never invent
a type or status. Folder = reverse-lookup of `domain_inference` for the card's domain.

## 3. Compiled Truth + History (the SUPERSEDE mechanic)

The frontmatter fields and the top of the description are **Compiled Truth** — the
living snapshot of what is true *now*. When a fact changes (job changed, moved city,
status flipped):

1. **Rewrite** the current value in place — the frontmatter field *and* the top of the
   description — to the new fact.
2. **Move the OLD value** to a `## History` section as a dated line:
   ```markdown
   ## History
   - 2026-03→2026-06 · company: TDI Group
   ```
3. Set `updated: YYYY-MM-DD` to the change date.

Rules:
- **Never leave two contradictory current values** on the same subject. Do NOT just
  append the new fact and leave the old one standing.
- `## History` is **append-only** — never edit or reorder existing lines.
- Date range: `{from YYYY-MM}→{to YYYY-MM} · {field}: {old value}`.

## 4. Whole-card obsolescence

When an entire card is retired (project renamed, decision reverted, entity merged into
another), don't delete it — mark it:

```yaml
status: superseded
superseded_by: [[replacement-card]]
```

Both `superseded` (in the type's status enum) and `superseded_by` must exist in your
schema. `search.py` demotes superseded cards in ranking; they stay findable as history.

## 5. Deterministic assist

The nightly conflict scan surfaces stacked contradictions for you:

```bash
uv run scripts/supersede.py <vault-dir>            # dry-run → .graph/supersede-candidates.json
```

Read `.graph/supersede-candidates.json` and resolve **every** listed same-entity
conflict by superseding the stale value (§3). `supersede.py --apply` will conservatively
stamp `status: superseded` + `superseded_by` only for unambiguous two-card, newer-by-date
groups; the frontmatter/description rewrite is your job.

## 6. Confidence (optional — only if your schema/vault uses it)

Tag each fact's certainty in frontmatter:
- **EXTRACTED** — stated directly (assert it when recalling).
- **INFERRED** — deduced (hedge when recalling).
- **AMBIGUOUS** — unclear/conflicting source (flag it).
