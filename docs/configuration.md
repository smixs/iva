# Configuration

Iva is configured by one file: `.env` in the install directory. The setup wizard fills it in for you — run `iva config` any time to redo a step ([cli.md](./cli.md)). `.env.example` in the repo root is the template. This page documents every variable.

**Every change needs a restart.** Iva reads `.env` once at startup. After editing:

```bash
iva restart
```

No rebuild. Swapping a model, key or provider is edit → restart.

## Model provider

Two providers, both OpenAI-compatible. Pick one with `MODEL_PROVIDER` and fill only that block. Prices and full model lists: [providers.md](./providers.md).

| Variable | Default | Notes |
|---|---|---|
| `MODEL_PROVIDER` | `ollama` | `ollama` (Ollama Cloud) or `opencode` (OpenCode Zen). |
| `OLLAMA_API_KEY` | — | Key from ollama.com. |
| `OLLAMA_MODEL` | `deepseek-v4-pro` | Any model on your Ollama Cloud plan. |
| `OLLAMA_CONTEXT_WINDOW` | `131072` | See warning below. |
| `OPENCODE_API_KEY` | — | Key from opencode.ai/auth. |
| `OPENCODE_MODEL` | `opencode-go/deepseek-v4-pro` | Any Zen Go model. |
| `OPENCODE_CONTEXT_WINDOW` | `131072` | Same warning. |

**Don't inflate the context window.** Compaction triggers at 70% of this number. Set it above the model's real window and the compactor fires too late — the request overflows before history gets trimmed. When you switch models, enter the new model's actual window, not a rounder bigger one.

## Telegram

| Variable | Default | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | From [@BotFather](https://t.me/BotFather). |
| `TELEGRAM_BOT_USERNAME` | — | Your bot's username. The wizard verifies the token via `getMe` and detects this itself. |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | — | Shared secret between the long-poll bridge and the local webhook. Any long random string. |
| `TELEGRAM_ALLOWED_USER_IDS` | *(empty)* | Comma-separated numeric user IDs allowed to talk to Iva. |
| `TELEGRAM_DIGEST_CHAT_ID` | — | Chat that receives the morning digest and nightly memory reports. Usually your own chat ID. |

The allowlist is **fail-closed: empty means Iva answers nobody.** The wizard auto-discovers your ID the moment you message the bot; or ask [@userinfobot](https://t.me/userinfobot). Why fail-closed matters: [security.md](./security.md).

## Voice

| Variable | Default | Notes |
|---|---|---|
| `DEEPGRAM_API_KEY` | — | From console.deepgram.com. Transcribes voice notes, video circles and audio files. Free tier: [providers.md](./providers.md). |
| `DEEPGRAM_LANGUAGE` | `multi` | `multi` auto-detects the language per message (ru/uz/en and others). Pin a single code like `en` only if auto-detection trips on your mix. |

## Search

| Variable | Default | Notes |
|---|---|---|
| `SEARCH_PROVIDER` | `tavily` | `tavily`, `exa`, `parallel` or `brave`. |
| `TAVILY_API_KEY` `EXA_API_KEY` `PARALLEL_API_KEY` `BRAVE_API_KEY` | — | Key for the matching provider. Keys can coexist; switching providers is just the flag. |

No key for the active provider means `web_search` returns a clear error — nothing crashes. Free tiers and the comparison table: [providers.md](./providers.md).

## Memory

| Variable | Default | Notes |
|---|---|---|
| `MEMORY_SEARCH_MODE` | `grep` | `grep` = BM25 over Node's built-in SQLite FTS5 plus graph rerank. Zero external deps, zero keys, runs on a $4 box. `hybrid` adds dense embeddings — one external key. |
| `JINA_API_KEY` | — | For hybrid. Jina `jina-embeddings-v3`: no-train policy, EU hosting. |
| `DEEPINFRA_API_KEY` | — | For hybrid. Cheaper, serves `BAAI/bge-m3`. One of the two keys is enough. |
| `MEMORY_EMBED_PROVIDER` | *(auto)* | Override auto-pick: `jina` or `deepinfra`. |
| `MEMORY_EMBED_MODEL` | `jina-embeddings-v3` | Embedding model name. |
| `MEMORY_EMBED_URL` | — | Any OpenAI-compatible embeddings endpoint, e.g. a local Ollama at `http://127.0.0.1:11434/v1/embeddings` — then no external key at all. |

The nightly doctor builds the hybrid index; to build it now, run `node --env-file=.env scripts/memory/embed-index.ts`. How search actually works: [memory.md](./memory.md).

## System

| Variable | Default | Notes |
|---|---|---|
| `AGENT_LANGUAGE` | `ru` | `en` or `ru`. Sets Iva's reply language, date locale, and which CORE.md seed `init-vault` uses. |
| `ASSISTANT_TIMEZONE` | `Asia/Almaty` | IANA name. Sets daily-transcript dates, the 5 nightly memory timers, and the date/time Iva sees each turn. Exported as `TZ`. |
| `ASSISTANT_VAULT_DIR` | `vault` | The live memory: a separate private git repo, opens in Obsidian. |
| `ASSISTANT_DATA_DIR` | `data` | Runtime data: `tasks.json`, token log `usage.jsonl`. |
| `IVA_PORT` | `8723` | Local eve server port. Deliberately unfashionable — 3000/8000/8080 are usually taken on a stock VPS by docker and friends. Change it via `iva config`, not by hand: the systemd unit pins the port literally and must match ([deploy.md](./deploy.md)). |
| `ASSISTANT_HOST` | `http://127.0.0.1:${IVA_PORT}` | Where the poll bridge and memory scripts reach the server. Change only if the agent runs on another host. |
| `ASSISTANT_BEARER` | *(empty)* | Only when the eve HTTP channel requires a bearer token — the Vercel variant in [deploy.md](./deploy.md). |
| `AGENT_BROWSER_MAX_OUTPUT` | `24000` | Character cap on agent-browser output, so one page dump can't eat the context window. |
