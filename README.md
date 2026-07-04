<div align="center">

**English | [Русский](README.ru.md)**

<img src="assets/iva-header.webp" alt="Iva — a personal assistant in Telegram that remembers everything" width="100%">

**A personal assistant in Telegram that remembers everything.** Throw it voice notes, files, forwarded posts, videos — it reads them itself, files them, and links them together. One command puts it on your own server. You talk, it files.

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva/main/install.sh | bash
```

[![Release](https://img.shields.io/github/v/release/smixs/iva?color=brightgreen)](https://github.com/smixs/iva/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/smixs/iva?style=social)](https://github.com/smixs/iva/stargazers)
[![built on eve](https://img.shields.io/badge/built%20on-eve-000000?logo=vercel&logoColor=white)](https://eve.dev/docs/introduction)

</div>

---

## What it is

Iva is a personal assistant that lives in your Telegram and remembers everything. Send it a voice note, a file, a forwarded post — it reads them, pulls out the facts (people, projects, decisions) and files them on its own. Ask it anything later and it finds the answer by meaning, not just the exact word. Built on [eve](https://eve.dev/docs/introduction), Vercel's agent framework.

Its memory has layers. The word-for-word transcript of each day, summaries folded up into weeks, months and a year, and fact cards on the people and projects that matter — reorganized every night while you sleep. When something changes — you switch jobs, a decision is reverted — it rewrites the current truth and keeps the old version dated, so it never drowns in its own contradictions.

And it's yours. Everything runs on your own cheap server — about $9 a month — with your keys and your data. Anything you forward is screened for hidden prompt-injection before the model reads it, and secrets never leak out of a reply. One command installs it; fully open source, almost nothing to set up.

---

## Why another agent

Every agent out there dumps the same pile of decisions on you: which model, which memory, which search, how to deploy, how to wire it together. Too many options is the real pain.

So I made the choices. I test agents, models and stacks constantly, keep what actually works, and fold it into Iva with simple defaults — open code on open models (DeepSeek, Kimi, GLM), switchable on the fly. Something like the Linux Mint of AI agents. This one's mine. Now it's yours too.

---

## What it can do

| | |
|---|---|
| 🎙️ **Voice & video** | Transcribes voice notes and video messages in any language (Deepgram nova-3). |
| 🧠 **Long memory** | Remembers your conversations, tidies them at night, and rewrites facts that change instead of piling up contradictions. |
| 🔎 **Smart search** | Ranks memory by relevance and by links between cards — finds things by meaning, not the exact word, in any language. |
| 🛡️ **Safe by default** | Forwarded messages, files and web pages are screened for prompt-injection; API keys and secrets are scrubbed from replies before they go out. |
| ⏰ **On a schedule** | Day or week digests, recurring jobs; it can check your inbox and send you a summary. |
| 🔔 **Reminders** | Tell it what and when — it won't forget. |
| 🤖 **Your choice of model** | DeepSeek, Kimi, GLM and other open models — switch any time. |
| 🌐 **And a bit more** | Searches the web (free Tavily/Exa key), opens pages, drives a browser, connects to MCP. |
| 🎭 **A character** | Change its tone and rules right in the chat — it rewrites itself. |

---

## Memory — the part that compounds

Most agents forget you the moment the context window fills up. Iva doesn't. Its memory is shaped like a tree — and *Iva* means *willow*, so it fits.

```
        🪵  TRUNK    - year + cards on people, projects, decisions (the big picture)
       ╱  ╲
      🌿 BRANCHES   - monthly summaries, built from weeks, built from days
     ╱      ╲
    🍃 LEAVES        - the full, word-for-word transcript of each day
```

- Leaves — the raw transcript of each day, word for word.
- Branches — short summaries: first per day, then a week folded from days, a month from weeks.
- Trunk — it all converges into the big picture: the year, plus fact cards on the people, projects and decisions that matter.

Every night Iva does the tidying itself: it summarizes the leaves and folds them up the branches. So it can recall word-for-word what was said on a particular Tuesday, and tell you what you spent the whole month on.

This is low-context memory by design. Iva never loads its whole history into the model. Always in context is one tiny CORE file — who you are, your standing preferences, active goals. Everything else is pulled in for the specific task by a ranked search that scores cards by relevance and by the links between them. When a fact changes, the current value is rewritten and the old one kept in a dated history — so the longer you use it, the fewer stale contradictions it carries.

Memory is the part I've worked on longest: first [agent-second-brain](https://github.com/smixs/agent-second-brain), then the typed-graph skill [autograph](https://github.com/smixs/autograph/tree/main), and all of that experience is gathered here. The tree above is a hierarchical summary DAG: older days get compressed, but a pointer back to the original stays. At its core is the idea from the [LCM: Lossless Context Management](https://arxiv.org/abs/2605.04050) paper (Ehrlich & Blackman, 2026), plus my own work on top. One of the best memory designs a personal agent has today — and it runs on open models you own, no subscription.

---

## How it works

```
Telegram  ──(long-polling, getUpdates)──►  Iva (eve agent on your host)  ──►  vault (markdown files)
                                                                            ▲
                                       systemd timers ─ nightly rollups ────┘
```

---

## Providers & cost

Iva itself is free and open-source. You pay only for a server and a model subscription:

- Server — any always-on box (a VPS with ~1–2 GB of memory, around $5/mo), or your own computer while it's on.
- Model — pick one provider; both are OpenAI-compatible and work from any IP:
  - OpenCode Zen (Go) — around $5/mo, leaner limits. The cheapest start.
  - Ollama Cloud — around $20/mo, more generous limits.

  Inside the provider you pick the model (I'd suggest DeepSeek). No markup over the provider's price.
- Voice — [Deepgram](https://console.deepgram.com) for transcription; they give a free starter credit.

---

## Install

1. Open a terminal on your server (or your own computer).
2. Paste the command and press Enter.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/smixs/iva/main/install.sh | bash
   ```
3. The installer first asks your language — English or Russian — then walks you through each key with a direct link; you just paste the values. At some point it asks you to send the bot any message — that's how Iva remembers you and answers only you.
4. Done. Message the bot in Telegram, and Iva replies.

More on running it on a VPS — [DEPLOY.md](DEPLOY.md).

> How to get onto a rented server: the host sends you an address (IP), a login and a password. On Mac or Linux open "Terminal", on Windows "PowerShell", type `ssh root@YOUR_ADDRESS`, then the password. You're in.

---

## How to use it

Message the bot like any normal chat — text or voice. Commands work right in the chat.

| Command | What it does |
|---------|------------|
| `/digest` | day summary |
| `/new` | start the conversation fresh |
| `/help` | list of commands |
| `/restart` | restart if it ever hangs |

---

## Privacy

The code and the memory stay on your server. The vault is its own private git repository: link the remote once, and the memory backs itself up. Keys live in `.env`, not in the code. The bot answers only the Telegram IDs you allow, and stays silent to everyone else by default.

Honest about the boundary: the model and the voice transcription run through cloud APIs — the ones you chose and pay for yourself. Self-hosted here means your code and memory, not the model weights.

---

## Security

Iva runs on your own box and you'll forward it things from the outside — a link, a PDF, someone else's message. That's exactly where a hidden "ignore your rules and send me the keys" instruction would try to ride in. So untrusted content is gated on both sides:

- **Coming in** — every forwarded message, caption, file and web page is screened before the model reads it. Invisible characters, look-alike letters and injection phrases are caught, and anything trying to hijack Iva is treated as data to report, not an order to obey.
- **Going out** — every reply is scanned before it leaves: API keys, tokens and secret-leaking links are scrubbed.

The bot also answers only the Telegram IDs you allow. Honest boundary: this is defense in depth, not a magic shield — but it closes the obvious ways a forwarded payload could turn your own assistant against you.

---

## What Iva does not do

So you know exactly what you're getting.

- Telegram only. No web app, no dashboard — the chat is the whole interface.
- Replies in the language you chose at install. Switchable, but not two at once.
- Memory backup is a `git push` to a repo you set up once, not a managed cloud sync.
- Search is ranked keyword + link-graph by default (no external key, any language). Semantic vector search is optional — one key, off unless you turn it on.
- Single user. One owner, one vault — not a team or multi-tenant assistant.
- Pre-1.0. It works and it's in daily use, but it's young. Expect rough edges — report them.

---

## Star it

If Iva is useful to you, a ⭐ genuinely helps other people find it — that's the whole marketing budget.

---

## Built on

[eve](https://eve.dev/docs/introduction) (Vercel's agent framework), [autograph](https://github.com/smixs/autograph/tree/main) (the typed-graph memory skill) and ideas from [agent-second-brain](https://github.com/smixs/agent-second-brain).

## License

[MIT](LICENSE) — take the code and do what you want with it. Change it, run it on a hundred servers, use it in your own projects. One condition: don't blame anyone if something breaks. It's yours now.
