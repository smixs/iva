# Linking protocol

Orphan cards are wasted knowledge. Every card gets a hub + 2–3 neighbors before the day
is done.

## 1. Hub (domain index)

Resolve domain from path via schema `domain_inference`:

| Path | domain | hub |
|------|--------|-----|
| `cards/projects/` | work | `cards/projects/_index.md` |
| `cards/decisions/` | work | `cards/decisions/_index.md` |
| `cards/contacts/` | personal | `cards/contacts/_index.md` |
| `cards/notes/` | knowledge | `cards/notes/_index.md` |
| `cards/ideas/` | knowledge | `cards/ideas/_index.md` |

Hubs (`_index.md`) are generated/maintained by
`uv run .claude/skills/autograph/scripts/moc.py generate .`. Link the hub even if it does
not exist yet — the mechanical pass materializes it.

## 2. Neighbors (2–3)

Find siblings of the same type+domain:

```bash
grep -rl "type: <type>" cards/<kind>/
uv run .claude/skills/autograph/scripts/graph.py backlinks . cards/<kind>/_index
```

Link the 2–3 most relevant, each with a context phrase explaining the relationship:

```markdown
## Related
- [[cards/projects/_index|Projects]]
- [[cards/projects/eva-memory|Eva memory]] — this decision picks its scheduler
- [[cards/notes/deepgram-nova3-multi|Deepgram nova-3 multi]] — feeds the same pipeline
```

## 3. Reciprocity

If A strongly relates to B, add the reverse link on B too. Keep the graph navigable in
both directions.

## 4. Touch & verify

```bash
uv run .claude/skills/autograph/scripts/engine.py touch cards/<kind>/<file>.md
uv run .claude/skills/autograph/scripts/graph.py health .   # broken links should be 0
```

## Wiki-link form (Obsidian)

- `[[path/to/card|Display Text]]` — path is vault-relative, no `.md`.
- Inside tables, escape the pipe: `[[path\|Display]]`.
- See `.claude/rules/obsidian-markdown.md` if present, or the autograph references.
