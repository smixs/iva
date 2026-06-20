# Classification — what becomes a card

Decide per noteworthy item. When unsure, prefer **fewer, richer** cards over many thin
ones. Most transcript lines stay in the transcript and never become cards.

## Map content → type

| Signal in the transcript | type | folder |
|--------------------------|------|--------|
| A person/org that will recur ("met X", "from company Y") | `contact` | `cards/contacts/` |
| Ongoing effort with deliverables ("working on Z", "the X project") | `project` | `cards/projects/` |
| A choice made + reason ("decided to…", "going with… because…") | `decision` | `cards/decisions/` |
| A proposal/hypothesis worth revisiting ("what if…", "idea:") | `idea` | `cards/ideas/` |
| A durable fact / learning / reference ("turns out…", "TIL", a how-to) | `note` | `cards/notes/` |

## Stays in the transcript (do NOT card)

- Logistics, scheduling, acknowledgements, transient status.
- One-off questions already answered inline by Eva with no lasting fact.
- Emotional venting with no decision/idea/fact to keep.
- Anything already represented by an existing card → **update** that card instead.

## Topics (for the daily-summary)

Topics are 2–6 short labels describing what the day was *about* — broader than tags,
narrower than domains. Examples: `eva-memory`, `deepgram`, `vault-schema`, `family`,
`reading`. They populate the summary's `## Topics` and `topics:` frontmatter and are the
primary way weekly/monthly/yearly rollups understand the period.

## Decision vs. idea vs. note

- **decision** — irreversible-ish, has a rationale, can later be `superseded`/`reverted`.
- **idea** — not yet acted on; status `active` → `explored` → `archived`.
- **note** — a fact/learning with no action attached.

## Update vs. create

Update an existing card when the new info is the *same subject*. Signs you should update:
same person, same project, same decision being refined. Append a dated line under a
`## Log` section and sharpen the `description`. Creating a near-duplicate is the most
common mistake — grep first.
