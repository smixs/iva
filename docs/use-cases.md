# Use cases

Iva is not a bot with buttons — it's a personal agent that lives in your Telegram 24/7 and takes the routine off your hands. The README lists features; this page shows what people actually do with them: business owners, specialists, executives and regular humans.

## The highlight reel

- One message in the morning — and back comes the day's plan: tasks, inbox, industry news.
- "What did we agree with client X about the last shipment?" — found in seconds, months later.
- A five-minute voice note from the car → a task list, a draft email, a meeting card.
- A 4,000-line price list reconciled in minutes instead of a day.
- Tired of paying for Perplexity — research with links to sources, done by Iva.
- A photo of a business card → a contact card with what you agreed on.
- A Gmail reply and a calendar invite sent without opening the laptop.
- A bedtime story for your daughter — and tomorrow Iva remembers where the plot left off.

## For business owners

**🧠 Memory and context.** Iva remembers what was discussed, when and with whom. Ask "what did we decide with client X about the last shipment?" — she finds the thread, pulls up the agreements and reminds you what's due.

**📎 Files and documents.** Clients send price lists, specs and invoices; Iva takes them apart and files them by project and deal in your vault. Everything findable, nothing lost in chat scroll.

**📊 Data at volume.** Price lists, sales reports, reconciliations — she processes them right on your server. What takes a day by hand takes her minutes.

**📰 Industry digests.** What's new with your suppliers, competitors and market — collected on request, with topics and sources tuned to you.

**🔎 Background checks.** Before a deal, Iva gathers what open sources say about the company and the people across the table.

**📮 Mail and calendar.** Gmail, meetings with invites — straight from the chat, via the `gws` CLI she sets up with you.

## For specialists

**🔎 Research with receipts.** Not a retelling — an answer with links to sources, on any of four search providers.

**📊 Tables and exports.** Send a ten-thousand-row CSV; she parses it, runs the numbers and returns a summary.

**🎙 Voice and call recordings.** Voice notes, audio and video messages become text, decisions and tasks. Language auto-detected (ru/uz/en).

**✍️ Drafts in your voice.** Emails, documents, replies — she has months of your context to draw from.

**🌐 Browser errands.** Fill a form, pull data off a page, take a screenshot — Iva drives a real browser.

**🗂 A knowledge base you own.** All memory is plain markdown cards in an Obsidian-compatible vault. Open it in Obsidian, grep it, take it with you.

## For executives

**🧭 Decision cards.** What you chose, when and why — old versions stay in a dated history. No more "why did we do it this way?" archaeology.

**📇 Personal CRM.** Who promised what, what you agreed on, when to follow up.

**🤝 Meeting prep.** A brief on the company and the person across the table, a couple of minutes before the call.

**📮 Inbox and calendar from chat** — handled between meetings, from the phone.

**🔐 Confidentiality.** Your server, your keys; memory is a private git repository you own. Deal talk doesn't live in someone else's SaaS — for an executive this tends to be the deciding argument.

**📊 Transparent spend.** Every model step is logged; `/usage` reports the burn for free.

## For everyday life

Voice notes and shopping lists. People and dates she actually remembers. Search and purchases researched with sources. Bedtime stories that continue tonight's plot tomorrow. The interface speaks Russian or English, switched with one button in `/menu`; voice notes are understood in Russian, English and Uzbek.

## Iva grows around you

Out of the box Iva ships with six skills: web research, a browser, Google Workspace, a morning digest, a personal-account userbot (beta) and injection defense. The rest is yours to add — and adding is cheap:

- a **skill** is one markdown file with a procedure;
- an **MCP connector** to your CRM, database or internal service is one config file;
- a **subagent** for a recurring pipeline is one folder.

The author's own install has grown past 80 skills: Iva runs a Telegram channel, compiles weekly reports, generates images, digests social media exports. Give her a skill with your expertise — and she becomes a second brain that takes the routine off your plate. How to extend: [docs/extending.md](extending.md).

## Honest limits

Iva won't ping you first at 3 p.m. — the only scheduled things are the nightly memory rollups and a quiet daily update check; the morning digest arrives when you ask (`/digest`). The model and voice transcription are cloud APIs you choose and pay for directly, with no markup. The userbot mode (acting from your personal account) is a beta, at your own risk.

## Try it

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva/main/install.sh | bash
```

[Quick start](../README.md#quick-start) · [Features](../README.md#features) · [Docs](README.md)
