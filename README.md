<div align="center">

**English | [Русский](README.ru.md)**

<img src="assets/iva-header.webp" alt="Iva — a personal AI agent with long-term memory" width="100%">

**A personal AI agent with long-term memory. One command installs it on a $4 server, and it remembers everything about you.**

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

Iva is a minimal personal AI agent with long-term memory, built on [eve](https://eve.dev/docs/introduction), the agent framework from Vercel. It lives in Telegram and runs on your own server. One command installs it, and there's almost nothing to set up — it's all been chosen for you.

The main thing here is memory. Iva breaks every conversation down into facts — about you, the people around you, your projects and decisions — and files them into a tree that it tidies up on its own every night. The longer you use it, the better it knows you.

And it's cheap. The minimum is one core, 512 MB of memory, 10 GB of disk: a $4 DigitalOcean droplet plus a model through OpenCode Go for $5. About $9 a month for an agent that sends you a morning digest and reminds you about meetings. The code and the memory are yours; you pick the key and the model. Fully open source.

---

## Why another agent

[OpenClaw](https://github.com/openclaw/openclaw), [Hermes](https://github.com/NousResearch/hermes-agent), [nanobot](https://github.com/HKUDS/nanobot) — there's already a choice, and a decent one. The problem is that each of them dumps the same pile of decisions on you: which model, which memory, which search, how to deploy, how to wire it all together. Too many options — that's the real pain.

So I made the choice myself. I'm always testing agents, models, stacks and harnesses, keeping what actually works, and folding it into Iva — so you don't have to dig through it yourself. The goal is simple: a cheap, fast, reliable agent for every day, one that sends you a morning digest on its own.

- **The best of different agents in one place.** I've been at this a long time — I pick out the good ideas and assemble them with simple defaults.
- **Open to extend.** Open code on open models — DeepSeek, Kimi, GLM are genuinely strong now, and you switch on the fly.
- **One command, and it works.** Telegram for chat, Deepgram for voice, tree-shaped memory, nightly summaries — already assembled and configured. Something like the Linux Mint of AI agents.

There are plenty of agents around. This one's mine. Now it's yours too.

---

## What it can do

| | |
|---|---|
| 🎙️ **Voice & video** | Transcribes voice notes and video messages in any language (Deepgram nova-3). |
| 🧠 **Long memory** | Remembers your conversations and tidies them up on its own at night. |
| 🔎 **Fast search** | Finds what you need in seconds, straight over the files — no index to rebuild. |
| ⏰ **On a schedule** | Day or week digests, recurring jobs; it can check your inbox and send you a summary. |
| 🔔 **Reminders** | Tell it what and when — it won't forget. |
| 🤖 **Your choice of model** | DeepSeek, Kimi, GLM and other open models — switch any time. |
| 🌐 **And a bit more** | Searches the web (free Tavily/Exa key), opens pages, drives a browser, connects to MCP. |
| 🎭 **A character** | Change its tone and rules right in the chat — it rewrites itself. |

Everything the best agents have — voice, search, skills, MCP — is here too. The difference is what's under Iva's hood.

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

This is low-context memory by design. Iva never loads its whole history into the model. Always in context is one tiny CORE file — who you are, your standing preferences, active goals. Everything else is pulled in for the specific task, found by a plain search over the files.

Memory is the part I've worked on longest: first [agent-second-brain](https://github.com/smixs/agent-second-brain), then the typed-graph skill [autograph](https://github.com/smixs/autograph/tree/main), and all of that experience is gathered here. The tree above is a hierarchical summary DAG: older days get compressed, but a pointer back to the original stays. At its core is the idea from the [LCM: Lossless Context Management](https://papers.voltropy.com/LCM) paper (Ehrlich & Blackman, 2026), plus my own work on top. One of the best memory designs a personal agent has today — and it runs on open models you own, no subscription.

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

## What Iva does not do

So you know exactly what you're getting.

- Telegram only. No web app, no dashboard — the chat is the whole interface.
- Replies in the language you chose at install. Switchable, but not two at once.
- Memory backup is a `git push` to a repo you set up once, not a managed cloud sync.
- Search is literal, not semantic. Iva greps your files; there's no vector search.
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
