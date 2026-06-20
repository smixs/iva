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
