# Launch playbook — getting Iva to its first thousands of stars

Internal notes for the maintainer. Not linked from the README. Distilled from how recent
open-source dev tools (Preevy, Documenso, Twenty, QuestDB) grew on GitHub.

## The order that works

1. **Warm the first 100 stars before any public post.** A 0-star repo converts badly. Ask friends,
   colleagues, your channel, anyone who already knows the project. Cross this threshold first so
   public visitors don't land on an empty repo.
2. **Hacker News — the single highest-leverage channel.** Post a `Show HN: Iva — open-source personal
   AI agent with long-term memory`. Rules that matter:
   - Your own voice, not marketing copy. One clear sentence of what it does, then the backstory and
     the technical solution.
   - **No superlatives.** HN punishes "the best/fastest/revolutionary". State facts plainly.
   - Link **directly to the GitHub repo**, not a landing page — HN trusts repo links.
   - Post Tue–Thu, ~8–10am US Eastern. Be present all day, answer every comment fast and graciously.
   - Never seed booster comments from friends. It backfires.
3. **Reddit — niche subs, not generic ones.** `r/LocalLLaMA` (local/self-hosted/privacy-first is its
   whole ethos), `r/selfhosted`, `r/AI_Agents`, `r/opensource`, `r/SideProject`. Respect each sub's
   self-promo rule (many have a weekly showcase thread). Lead with a real result, not "please star".
4. **Product Hunt — second wave, not first.** A coordinated PH launch a few days after HN gives a
   second spike (+300% stars reported). Prep assets, a maker comment, and a small upvote network.
5. **X / build-in-public.** Demo GIFs, the memory-tree diagram, milestone posts. Tag adjacent projects
   and maintainers in honest "here's the landscape" threads so they re-share. Reply to everyone who engages.
6. **Dev content platforms with trending algorithms.** Dev.to (`#showdev`), Hashnode, Hackernoon,
   daily.dev. Drive traffic *to* these so their algorithms amplify; cross-post to your own domain after.
7. **GitHub's own surfaces.** PR Iva into relevant `awesome-*` lists. Get it onto GitHub Topics
   (must be added by a third party, not you). Stars-velocity in the first days feeds GitHub Trending —
   which is exactly why steps 1–2 are front-loaded.
8. **Newsletters / aggregators.** Console.dev, TLDR, Bytes, niche AI newsletters. Most list OSS for free.

## Assets to have ready before launch day

- [x] English README with a hero, one-command install, memory diagram, honest "what it does NOT do".
- [x] A polished OG/social card (`iva-og.png`) — this is the unit that travels on X/Reddit/Slack.
- [x] Bilingual landing with hreflang + sitemap for SEO.
- [ ] A 30–60s demo GIF/asciinema of the install + first chat + a memory recall. **This is the biggest
      gap — repos that hit 5k–50k fast lead with a working demo at the very top.**
- [ ] Star-history chart embedded (already in README; it populates as stars arrive).
- [ ] A crisp repo description + topics (see below).

## RU/CIS audience (the second funnel)

The Russian README keeps the real wedge: works from any IP including RU/BY without a VPN, payment via
local cards / resellers. Post the RU launch in the author's own channel and relevant RU dev communities.
This is a distinct, underserved audience — don't dilute the English launch with it, run it in parallel.

## Repo metadata

- **Description:** `Open-source personal AI agent with long-term memory. One command, your server, no lock-in.`
- **Topics:** `ai-agent`, `personal-assistant`, `llm`, `telegram-bot`, `self-hosted`, `open-source`,
  `long-term-memory`, `second-brain`, `deepseek`, `local-first`, `agentic-memory`.

## The honest framing that converts

The author earns nothing on this — direct provider links, you pick how to pay, the goal is more people
becoming power users. That altruistic, non-commercial voice is more shareable in dev communities than any
sales pitch. Keep it.
