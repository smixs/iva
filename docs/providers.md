# Providers & cost

Iva runs on your server with your keys. Here is every external service it talks to, with real prices: one paid model subscription, one paid box — everything else fits a free tier. Total: about $9/mo.

## Model providers

| Provider | Price | Text models | Vision |
|---|---|---|---|
| **OpenCode Zen Go** | ~$5/mo | `deepseek-v4-pro` (default), `deepseek-v4-flash`, `kimi-k2.7-code`, `glm-5.2`, `qwen3.7` | `gemini-3-flash` |
| **Ollama Cloud** | ~$20/mo | `deepseek-v4-pro` (default) | `gemma3:12b` |
| **OpenRouter** | pay-as-you-go | 300+ models across vendors — pick any slug (`vendor/model`) | `google/gemini-2.5-flash` |
| **OpenAI (ChatGPT subscription)** | your existing Plus/Pro/Team | the models your plan exposes (`gpt-5.x`, `-codex`), fetched live | same subscription (multimodal) |

The first three are plain API keys; the last rides your personal OpenAI subscription:

- 🔌 **OpenAI-compatible** — Zen, Ollama and OpenRouter share the same wire format, so switching is one line in `.env`
- 🌍 **Any IP** — all answer from any server location, no region blocks
- 💸 **No markup** — you pay the provider directly; Iva adds nothing on top

```bash
MODEL_PROVIDER=opencode   # or ollama / openrouter / codex, then `iva restart`
```

Start with Zen: a quarter of the price, five models to switch between. Keys, model pick and context-window settings live in [configuration.md](configuration.md).

### OpenAI by ChatGPT subscription (`codex`)

Use the OpenAI subscription you already pay for — no separate API key, no per-token bill. Iva signs in the same way the official `codex` CLI does (OAuth against `auth.openai.com`), stores a refreshable token in `data/codex-auth.json` (chmod 600), and calls the subscription's Responses backend directly. The access token is refreshed automatically before it expires.

```bash
iva login              # device code: opens a link + one-time code (works on a headless VPS)
iva login --browser    # PKCE flow: opens a browser on this machine
iva config             # pick the provider (option 3) and a model from your plan's live list
iva restart
```

Notes: the model list is pulled from your subscription at setup time, so you always see exactly what your plan allows. Set `CODEX_CONTEXT_WINDOW` to the real window of the model you picked (compaction derives its threshold from it). Routing a self-hosted assistant through the ChatGPT subscription backend is a grey area under OpenAI's terms — you are using your own subscription on your own server, but weigh that yourself.

### OpenRouter (`openrouter`)

One key, [300+ models](https://openrouter.ai/models) from every major vendor (Anthropic, OpenAI, Google, DeepSeek, Meta…), billed pay-as-you-go straight by OpenRouter. Because there are hundreds of models, setup doesn't show a picker — you paste the model **slug** yourself:

1. Grab a key at [openrouter.ai/keys](https://openrouter.ai/keys) (`sk-or-…`).
2. Open [openrouter.ai/models](https://openrouter.ai/models), pick a model, copy its slug — the `vendor/model` id shown under the name (e.g. `anthropic/claude-sonnet-4.5`, `openai/gpt-5.1`, `google/gemini-2.5-pro`). Optional routing suffixes like `:free`/`:nitro` are allowed. The model must support **tool / function calling** — Iva is an agent and sends tools every turn (image-only or chat-only models won't work).
3. `iva config` → provider `4` → paste the key, then the slug. **It sends a live test request that includes a tool call** and only moves on once the model actually answers with tools enabled — so a mistyped slug, or a model that can't do function calling, can't slip through and leave the bot silent.

Set `OPENROUTER_CONTEXT_WINDOW` to the real window of the model you picked. Images are described through `google/gemini-2.5-flash` (cheap, always multimodal) regardless of your text model, so vision works even if the text model you chose is text-only — those image calls bill to your OpenRouter credit too.

## Vision

Attachments are never inlined into the model request. A photo lands in the vault, the agent gets its file path, and the provider's own vision model writes the description — OCR plus visual detail — into the daily transcript. Same key as the text model, no extra subscription.

## VPS sizing

Any Ubuntu/Debian box for $4–5/mo. 512MB RAM works — the installer handles low-memory boxes ([install.md](install.md)). More than 1–2GB buys you little: the model runs in the cloud, not on your box.

## Voice — Deepgram

Transcription runs on Deepgram `nova-3` with `language=multi`: Russian, Uzbek and English are detected automatically, even mixed inside one voice note. A new account comes with a free starter credit — no card — that covers months of personal use. The one hard limit is Telegram's, not Deepgram's: the Bot API refuses downloads over 20MB, so a long video won't transcribe.

## Web search

| Provider | Free tier | Card |
|---|---|---|
| **tavily** (recommended) | ~1,000 searches/mo | not required |
| **exa** | ~20,000/mo | not required |
| **parallel** | starter credits | not required |
| **brave** | ~$5/mo credit | required |

Pick one, set `SEARCH_PROVIDER` and its key. No key means no web search — Iva says so instead of guessing. DuckDuckGo scraping was removed on purpose: server IPs get captchas, and a search tool that randomly hits a wall is worse than none.

Optional hybrid memory search adds one more key (Jina or DeepInfra embeddings) — covered in [memory.md](memory.md).

## Total cost

| Service | Monthly |
|---|---|
| VPS | $4–5 |
| OpenCode Zen Go | ~$5 |
| Deepgram voice | $0 — starter credit |
| Web search (tavily) | $0 — free tier |
| **Total** | **~$9/mo** |

Prefer Ollama Cloud and the same stack lands around $25/mo. Either way the bill is flat, predictable, and paid straight to the providers.
