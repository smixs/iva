# Phase 2: PROCESS

Turn the CAPTURE plan into card files. Create new cards or update existing ones.

## Input

- The `items` list from Phase 1.
- Existing cards under `cards/**` (and summaries) for dedup.

## Steps

For each item:

1. **Dedup first.** Search for an existing card before creating one:
   ```bash
   grep -ril "<entity name or key phrase>" cards/
   ```
   - Match found → **update** that card (sharpen description, add tags, bump status,
     append a dated line under `## Log`). Do not create a duplicate.
   - No match → **create** a new card.
2. **Path & filename.** Place by type (see SKILL layout table). Filenames are
   kebab-case slugs:
   - `cards/contacts/jane-doe.md`, `cards/projects/eva-memory.md`,
     `cards/ideas/layered-memory-with-decay.md`,
     `cards/decisions/2026-06-20-systemd-timers.md`,
     `cards/notes/deepgram-nova3-multi.md`
   - Decisions and dated notes may prefix the date for ordering.
3. **Frontmatter.** Use the template for the type (`references/card-templates.md`).
   - `type` and `status` MUST come from `schema.json` → `node_types`.
   - `description` is a search snippet (what/why), never a title repeat.
   - `tags`: 2–5, lowercase, kebab-case.
   - `created: YYYY-MM-DD` and `source: daily/YYYY-MM-DD.md`.
4. **Body.** A few sentences of context, then leave a `## Related` section for Phase 3.
   Quote the transcript only as needed; link back with
   `source: daily/YYYY-MM-DD.md` in frontmatter.

## Title-as-claim (for notes & ideas)

Prefer specific claims over topic labels, so links read naturally:

- weak: `Agent Memory` → strong: `Agents need layered memory that decays when unused`
- Test: "Because of [[title]], …" should read as a sentence.

## Output of this phase

A list of created/updated card paths, carried into Phase 3 (LINK):

```
created: [cards/decisions/2026-06-20-systemd-timers.md, ...]
updated: [cards/projects/eva-memory.md, ...]
```

Do not finish here — unlinked cards are orphans. Continue to LINK.
