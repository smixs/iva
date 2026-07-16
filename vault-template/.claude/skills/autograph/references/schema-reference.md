# Schema Reference

Full documentation for `schema.json` — generated per vault, never shipped with hardcoded values.

## Structure

```json
{
  "node_types": { ... },
  "type_aliases": { ... },
  "field_fixes": { ... },
  "domain_inference": { ... },
  "path_type_hints": { ... },
  "status_order": { ... },
  "status_defaults": { ... },
  "richness_fields": { ... },
  "entity_extraction": { ... },
  "decay": { ... },
  "ignore_tags": [ ... ]
}
```

## node_types

Map of type name → definition. Each type has:
- `description` — what this type represents
- `required` — fields that must be present (e.g. `["description", "tags", "status"]`)
- `status` — valid status enum values for this type
- Optional: `priority`, `potential`, `source` — additional enum fields

Example:
```json
"project": {
  "description": "Project with deliverables",
  "required": ["description", "tags", "status"],
  "status": ["draft", "active", "done", "paused", "cancelled", "superseded"]
}
```

**Keep `superseded` in every type's status enum.** `enforce.py` remaps any status not
in the enum back to the first valid one, so without `superseded` there, a retired card
would be silently reverted to `active` on the next enforce run.

## Update-in-place fields

Autograph keeps **one card per subject**: when a fact changes, the existing card is
updated in place rather than duplicated (see `references/update-in-place.md`). Three
frontmatter/body conventions support this:

| Field / section | Meaning |
|-----------------|---------|
| `updated: YYYY-MM-DD` | Date a Compiled-Truth value last changed. Recency key for dedup merges (`updated > created > last_accessed`). |
| `status: superseded` | Whole card retired. Must be present in the type's status enum. |
| `superseded_by: [[card]]` | Pointer to the replacement card. |
| `## History` (body section) | Append-only log of old values, one dated line each: `- 2026-03→2026-06 · company: TDI Group`. Never edited or reordered. |

Optional: `confidence: EXTRACTED | INFERRED | AMBIGUOUS` — certainty of a captured fact.

## type_aliases

Map of old type values → canonical type. Auto-fixed on enforce.

Example: `"blog-post": "note"` — any card with `type: blog-post` gets rewritten to `type: note`.

## field_fixes

Map of field name → {old_value: fixed_value}. Catches typos.

Example: `"status": {"actve": "active"}` — fixes a common typo across the vault.

## domain_inference

Map of folder prefix → domain name. Used when a card has no explicit `domain:` field.

Example: `"projects/": "work"` — any file under `projects/` gets `domain: work`.

## decay

Controls relevance decay over time.

| Parameter | Description | Default |
|-----------|-------------|---------|
| rate | Relevance loss per day | 0.015 |
| floor | Minimum relevance | 0.1 |
| tiers.active | Days threshold for "active" | 7 |
| tiers.warm | Days threshold for "warm" | 21 |
| tiers.cold | Days threshold for "cold" | 60 |

Formula: `relevance = max(floor, 1.0 - rate × days_since_access)`

Tier beyond cold = "archive".

Special tier `core` = manual only, never auto-demoted.

## path_type_hints

Map of folder substring → type name. Used by `infer_type()` when a card has no explicit `type:` field.

Example: `"leads/": "lead"` — files in a `leads/` folder get `type: lead`.

## status_order

Map of status name → sort priority (integer). Used by `moc.py` for MOC generation ordering. Lower number = higher priority.

Example: `"active": 0, "draft": 9, "cancelled": 11`

## status_defaults

Default status assigned when a card has no `status:` field. Key = type name, `"default"` = fallback.

Example: `"default": "active"` — all types default to `active` unless overridden per type.

## richness_fields

Configuration for dedup content scoring.

- `bonus_fields` — list of frontmatter field names that indicate content richness. Each present field adds 15 points to the richness score.

Example: `"bonus_fields": ["telegram", "email", "company", "role"]`

## entity_extraction

Configuration for `daily.py` entity extraction.

- `noise_words` — list of words to filter out when detecting **Bold Name** patterns in daily files (e.g. `"TODO"`, `"FIX"`).

## ignore_tags

List of tags to skip during processing (e.g. bulk import artifacts).

## System Fields (auto-managed by engine.py)

| Field | Values | Description |
|-------|--------|-------------|
| tier | core, active, warm, cold, archive | Decay tier |
| relevance | 0.0–1.0 | Decay score |
| last_accessed | ISO date | Last touched |
| domain | (from domain_inference) | Auto-inferred from path |

## Generating Your Schema

1. Run `discover.py <vault>` → save discovery JSON
2. Run `generate_schema.py discovery.json schema.json` → draft schema
3. Review the generated schema, adjust as needed
4. Run `enforce.py <vault> schema.json` to validate
5. Iterate: add missing values, fix typos, re-run
