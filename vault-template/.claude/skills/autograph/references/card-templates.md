# Card Templates

Generic templates. Adapt types/statuses to your schema.json.

## Note

```yaml
---
type: note
description: >-
  [One-line search snippet — what this knowledge is about]
tags: [topic, subtopic]
status: active
source: article
created: 2026-01-01
---
```

## Contact

```yaml
---
type: contact
description: >-
  [Who they are, relationship context]
tags: [network, role]
status: active
---
```

## Project

```yaml
---
type: project
description: >-
  [What the project delivers, for whom]
tags: [client, type]
status: active
---
```

Optional fields on any card: `updated: YYYY-MM-DD` (set when a Compiled-Truth value
changes), `confidence: EXTRACTED | INFERRED | AMBIGUOUS` (certainty of the fact).

## Superseded card (whole card retired)

When an entire card is obsolete (project renamed, decision reverted, entity merged),
don't delete it — mark it and point to the replacement:

```yaml
---
type: project
description: >-
  [Old project, replaced by the new one]
tags: [client, type]
status: superseded
superseded_by: [[new-project-card]]
---
```

## Card with History (a fact changed — see references/update-in-place.md)

Compiled Truth (frontmatter + top of description) holds the current value; old values
move to an append-only `## History` section, never edited:

```markdown
---
type: contact
description: >-
  Creative director at Globex (since 2026-06)
tags: [network, creative]
status: active
updated: 2026-06-01
---

# Jane Doe

Creative director at Globex.

## History
- 2026-03→2026-06 · company: TDI Group
- 2026-01→2026-06 · role: Art Director
```

## Linking Protocol (ОБЯЗАТЕЛЬНО при создании карточки)

После создания файла — СРАЗУ свяжи:

1. **Hub link:** Добавь `## Related` с [[hub]] файлом домена
   - Определи домен из path → schema `domain_inference`
   - Hub = _index.md или MEMORY.md домена
2. **Sibling links:** Найди 2-3 карточки того же type+domain
   - `python3 scripts/graph.py backlinks <vault> <hub>` → найди siblings
   - Или: прочитай vault-graph.json → filter nodes by type+domain
3. **Touch:** `python3 scripts/engine.py touch <new-file>`
4. **Verify:** Карточка должна иметь ≥2 links в `## Related`

### Checklist
- [ ] Hub linked?
- [ ] 2+ related cards found?
- [ ] description ≠ title repeat?
- [ ] tags: 2-5, lowercase, kebab-case?
- [ ] status ∈ schema enum?

## Anti-Patterns

❌ `description: "Contact"` — useless for search, write a real snippet
❌ `status: "interested"` — not in enum, use what your schema defines
❌ `tags: []` — empty tags add nothing, pick 2-5 relevant ones
❌ No frontmatter — every file needs `---` block
❌ Creating a near-duplicate instead of updating — grep/`search.py` first
❌ Two contradictory current values on one subject — supersede the old one into `## History`
