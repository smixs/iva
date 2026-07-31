# Changelog

## [Unreleased]

## [0.3.8] - 2026-07-31

- ✅ **Google Задачи через `gws`** (#108) — агент умеет смотреть/добавлять/закрывать/удалять задачи (generic `gws tasks …`, без отдельного кода интеграции); tasks-скоуп запрашивается при подключении Google, давно подключённым — кнопка «Переподключить» в /menu → Google.

[0.3.8]: https://github.com/smixs/iva/releases/tag/v0.3.8

## [0.3.7] - 2026-07-31

Надёжность обновлений и установки — обе идеи предложил и обкатал в своём форке [@mamysh](https://github.com/mamysh) (#102, reference-реализации mamysh/iva#7 и mamysh/iva#15):

- 🧪 **Replica gate в CI** (#103) — каждый PR проходит одноразовую изолированную установку с mock-провайдером: прод-билд, старт, первый реальный ответ, рестарт. Заодно поймана регрессия резюма сессий через рестарт на eve 0.27.13 (#104).
- 🛡️ **`iva update` собирает кандидата в отдельном worktree** (#105) — сломанное обновление больше не трогает живую установку: билд проверяется в `.iva-update/staging`, и только после успеха артефакты переносятся atomically-rename'ом. Активируется со следующего релиза.
- 🩹 **Ночная память переживает рестарт сервера** (#104) — таймаут хода и свежая сессия вместо молчаливого зависания.
- 🛡️ **TimeoutStartSec на memory-юнитах** — зависшая ночь убивается по таймауту и видна в `iva doctor`.

[0.3.7]: https://github.com/smixs/iva/releases/tag/v0.3.7

## [0.3.6] - 2026-07-30

Fix: оборвавшиеся ходы видимы и не глушат бота, ошибки провайдера читаемы, память и её бэкап держат себя в форме.

- 🩹 **Мост видит ошибки доставки мгновенно** — все доставки сообщений идут через acceptance-роут: зависший чат сбрасывается сразу, а не через 30 минут реапером.
- 🧹 **eve обновлён до 0.27.13** — ретраи на обрыв стрима провайдера, ограничение локального trace-хранилища; патч детерминированных ошибок перенесён.
- 🩹 **Telegram сам освобождает чат после оборвавшегося хода** (#85, #87, #91) - раньше бот молчал до 30 минут; теперь мост сбрасывает зависший статус, освобождает сессию и сообщает об ошибке.
- 🧠 **CORE.md больше не распухает** (#86) — ночной doctor детерминированно ужимает файл до капа, вытесняя старейшие пункты предпочтений и не трогая указатели; rollup проверяет свою работу.
- 🩹 **Ошибки провайдера теперь доходят до чата человеческим языком** (#85) — лимит, баланс, ключ и сбой провайдера больше не превращаются в молчание или «контекст переполнился».
- 🧠 **Алерты памяти теперь доходят без `TELEGRAM_DIGEST_CHAT_ID`** — фолбэк на первого доверенного пользователя (часть #88).
- 🩹 **Закрыты остатки #88 в Python-обработке карточек** — Python-писатель frontmatter приведён к TS-диалекту: однопробельный отступ и пустая строка внутри folded-описания больше не теряют и не реанимируют текст; `enforce.py` пропускает гигантские файлы вместо OOM.
- 🛡️ **Ночной бэкап vault больше не травит git-историю гигантскими файлами** — oversize-файлы останавливают коммит до `git add`, отказ push честно различает лимит GitHub, авторизацию и прочие ошибки; `iva doctor` показывает упавшие memory-юниты и проблемы ночного отчёта.
- 🧹 **Первое сообщение после ответа больше не попадает в ложную очередь** (#78) — Telegram-мост очищает in-flight запись чата, когда последний элемент durable-очереди обработан и ход завершён, поэтому следующий текст сразу доставляется вместо «В очереди: 1».
- 📸 **Альбомы и разрезанные сообщения — один ход** (#80) — Telegram-мост собирает последовательные части от одного отправителя в одном чате/топике после тихого окна (800 мс, 1500 мс для альбомов), а очередь хранит весь burst одним элементом. `TELEGRAM_COLLECT_QUIET_MS=0` возвращает прежний passthrough; offset сохраняется при буферизации, поэтому аварийная остановка в тихом окне может потерять один текущий in-memory burst.

[0.3.6]: https://github.com/smixs/iva/releases/tag/v0.3.6

## [0.3.5] - 2026-07-28

Fix: busy Telegram messages survive restarts, configuration changes roll back safely, and slow or truncated input is visible.

- 📬 **Durable follow-up queue** (#51) - per-chat FIFO, atomic writes, automatic drain and restart recovery.
- 💬 **Earlier Telegram feedback** (#53, #57, #59) - immediate working status, structured reply context and explicit truncation markers.
- ⚙️ **Safe configuration changes** (#54, #55, #56) - live model validation, atomic `.env`, health check and rollback.
- 🩺 **Real userbot health** (#58) - one bounded probe for CLI and Telegram, with redacted diagnostics.
- 🧹 **Complete subprocess cleanup** (#52) - timeouts reap the shell and its descendants.
- ⛔ **The agent can no longer restart itself out from under you** (#68) — asked in chat, the model would happily run `iva restart` from its own shell tool, killing its own turn mid-flight. That turn then stays `running` forever, eve re-enqueues it on every startup ("Re-enqueued N active run(s)"), replays it up to the same restart command and dies again — an endless restart loop, with the Telegram continuation-hook never released (`HookConflictError`, mute bot) as a bonus. The prompt already forbade this; models ignore prompts, so the bash tool now hard-blocks self-lethal commands (`iva restart|stop|reset|update`, `systemctl … restart|stop|kill iva.service`, `pkill`/`killall` aimed at `node`/`eve`) before execution and tells the model to offer `/restart` or `/update` in chat instead. Diagnostics (`status`, `journalctl`), memory timers and the polling bridge stay unrestricted. Note: a time-based "don't replay stale running runs" guard was deliberately NOT added — parked sessions legitimately stay `running` for weeks, and such a TTL would sever them.
- 🔒 **Two high-severity DoS advisories closed in dependencies** — `brace-expansion` 5.0.6 → 5.0.8 (CVE-2026-14257: exponential-time expansion of `{}` groups; reported in #69, thanks [@anupamme](https://github.com/anupamme)) and `fast-xml-parser` 5.9.3 → 5.10.1 (GHSA-8r6m-32jq-jx6q: repeated DOCTYPE declarations reset entity-expansion limits). Both reach Iva transitively through `just-bash`; the fix is lockfile-only, `npm audit` is clean again.
- 🖼️ **Photo descriptions were dead on both cheap providers** — vision runs on a hardcoded model per provider, and both had been retired out from under it: Ollama Cloud answered `410 gemma3:12b was retired at 2026-07-15`, OpenCode Go answered `401 Model gemini-3-flash is not supported`. Every photo silently landed in the vault with no description. Vision now uses `gemma4:31b` (Ollama) and `qwen3.7-plus` (Go), both re-verified against the live endpoints.
- 🤖 **Kimi K3 in the model lists** — the new 1M-context Moonshot model is offered by `/model` and `iva config` on all three key-based providers: `kimi-k3` on OpenCode Go and Ollama Cloud, `moonshotai/kimi-k3` on OpenRouter (replacing the older `kimi-k2`). The offline fallback lists were re-synced with the live catalogs while we were there — Go gained `minimax-m3` and `grok-4.5`, and the Ollama list dropped two ids that provider never actually served (`qwen3.7-max`, `gemma3:12b`). Note that on Ollama Cloud `kimi-k3` bills as extra usage on top of the plan: with an empty extra balance it returns `402`.
- ✅ **Every pull request now runs the release gate** (#61) - Node 24 tests, typecheck, Eve build, autograph tests, userbot guardrails and whitespace checks run in GitHub Actions before merge.

[0.3.5]: https://github.com/smixs/iva/releases/tag/v0.3.5

## [0.3.4] - 2026-07-28

Fix: memory cards survive updates, recovery targets the right Telegram conversation, thinking controls work across cloud providers, and private routes and files are locked down. Big thanks to the contributors whose reports and patches drove this release: [@AndyShaman](https://github.com/AndyShaman) (#34, #35, #36, #38, #42, #43 - the recovery fixes #35/#42 are merged with his authorship) and [@yakovmakovets](https://github.com/yakovmakovets) (#37, #39).

- 🗂️ **`write_card` merges instead of overwriting** (#43) — updating a card used to REPLACE the whole file: fields the tool doesn't know (phones, telegram ids, decay metadata) and the old body were silently lost, and `created:` was re-stamped. Cards are now read and merged — unknown frontmatter keys survive, the body is appended (no duplicates), the reply honestly says created/updated/merged. Identity no longer relies on the exact slug: a legacy Latin-slug card is found by its H1/name/aliases, and an ambiguous match refuses to write. Type aliases (person/company → contact) finally work; `write_file` refuses to overwrite an existing card in `cards/**` (use `write_card`); `read_file` understands the vault-relative paths `memory_search` returns.
- 🔧 **Recovery is real and scoped** - the old commands targeted `ROOT/.workflow-data`, a path that does not exist, so a stuck run always came back after "successful" recovery (#36, fixed by #35/#42). With Eve 0.27.8, `/new` now retires only the exact session for the current private chat, group conversation or forum topic; `/restart` does the same and restarts the process. The explicit server-side `iva reset` still quarantines the whole workflow store.
- 🗑️ **Quarantine instead of delete** — the store is renamed to `.workflow-data.trash-<stamp>` (two most recent kept) rather than removed, so an accidental reset can be undone by renaming it back. If stopping the service fails, nothing is touched; if quarantine fails, the bot says so instead of reporting a clean reset.
- 🌙 **Nightly memory no longer leaks runs** — every rollup opened a fresh eve session whose backing run stayed "running" forever, piling up one zombie per night ("Re-enqueued N active run(s)" on every start). Rollups now park and reuse one session per period. Already-accumulated zombies are cleared by the next `iva reset`.
- 📮 **rich-post is finally in the repo** (#38) — the persona demanded a skill that was never committed, so every install improvised its own sender with an arbitrary recipient. The published version locks the recipient to the digest chat / allowlist, takes the token only from the environment (no `--token` in argv), uploads local media to tmpfiles.org only behind an explicit `--allow-upload` — and only real image/video/audio files from inside the repo or data dir, so `.env`, logs and vault notes can't be exfiltrated — and `--dry-run` is fully offline.
- 📡 **The bridge survives bad updates and broken config** — a permanent 4xx from eve no longer freezes delivery for every chat (poisoned updates are dropped with an owner alert); 401/403/404 (secret/route misconfig) retry forever on a long backoff instead of throwing messages away; the ESC-stop buffer is cleared only after eve accepted the update, so a crash can no longer lose queued messages.
- 🔐 **Secrets and files are private now** - Eve binds to loopback and requires one internal bearer on its session routes; `.env` is written 0600, every iva unit runs with `UMask=0077`, and updates chmod `.env`/`data/` on old installs. Google client-secret attachments are intercepted before they can reach the model or vault. The gws login flow reaps its detached process and the temp log with the OAuth URL.
- 🧠 **Thinking controls work on cloud providers** - the existing model and thinking screens now offer model-aware levels for OpenAI subscriptions and the common `low` / `medium` / `high` contract for Ollama Cloud and OpenCode Go. The selected value reaches their OpenAI-compatible APIs as `reasoning_effort`.
- ⏰ **Memory timers respect your timezone** — `OnCalendar` used to fire in server time (UTC on a stock VPS), so "04:00" was really 09:00 in Tashkent; all memory timers now carry `ASSISTANT_TIMEZONE`, share one lock (no more simultaneous CORE.md rewrites on Jan 1), and the weekly rollup fires on Monday so its window is exactly the ISO week. The tasks tool locks its store and backs up a damaged `tasks.json` instead of silently emptying it; `iva usage` works with an absolute `ASSISTANT_DATA_DIR`.

[0.3.4]: https://github.com/smixs/iva/releases/tag/v0.3.4

## [0.3.3] - 2026-07-26

Fix: the 🧹 Vault cleanup button works on every install — and the vault is now pure data, with all code and prompts shipped in the repo.

- 🧹 **Cleanup button fixed** — in 0.3.2 it pointed at a script *inside the vault* that many installs didn't have yet (the sync that delivered it only ran one release later), failing with "Failed to spawn … (os error 2)". It now runs the repo's own copy by absolute path — present on every install the moment the update lands. Also fixed: the result summary silently degraded to a generic "Done" instead of showing files/MB cleaned.
- 📦 **The vault is data, the repo is code** — the autograph maintenance scripts, the nightly-memory format rules and the dbrain-processor prompts moved out of `vault/.claude/` into the repo (`scripts/autograph/`, `scripts/memory/instructions/`). They now update with the app instead of rotting inside every vault, and the `.claude` layout — a leftover of the tooling the memory engine was first built with, never a runtime dependency — is gone from new vaults entirely. The per-vault `schema.json` moves to the vault root (a one-time automatic migration copies it; the legacy folder in existing vaults is left untouched).
- 🧭 **Skills go to `agent/skills/` only** — Iva's always-on instructions now state where skills live, so "install this skill" can never land files in a `.claude` folder.

[0.3.3]: https://github.com/smixs/iva/releases/tag/v0.3.3

## [0.3.2] - 2026-07-25

Feature: a 🛠 Maintenance screen in `/menu` — the install's technical commands right in chat.

- 🛠 **Maintenance in `/menu`** — 🩺 Doctor (`iva doctor`), 🧹 Vault cleanup (the 0.3.1 streaming cleaner), 🌙 Night memory cycle (runs the nightly doctor unit right now instead of 05:00) and 🔄 Update (hands off to the existing `/update` flow). Confirmation before every run, live progress in the same message — an animated loader from the update flow's emoji pack, one color per command, the current step and elapsed time, a ✖ Cancel button — and a one-line summary with numbers at the end.
- 🚦 **Safe by construction** — one command at a time, doctor/cleanup refuse to start while an update is running, timeouts on everything, and the night cycle runs as its own systemd unit so a bridge restart can't orphan it.

[0.3.2]: https://github.com/smixs/iva/releases/tag/v0.3.2

## [0.3.1] - 2026-07-25

Fix: vault memory files no longer grow to gigabytes — and existing installs self-heal.

- 🐛 **Root cause fixed** — the frontmatter writer in the vendored autograph scripts kept the old folded `description` line whenever it contained a `:`, doubling the value on every nightly rewrite (2^N growth: a card crossed 100 MB in two weeks and could reach gigabytes). Bloated cards OOM-killed both Iva and the nightly memory doctor. The writer now replaces folded values by indentation, `enforce` collapses any repeated description, and a hard cap keeps descriptions one-line forever.
- 🧹 **New `cleanup` module in autograph** — a surgical, bounded-memory cleaner: it streams even gigabyte .md files (peak RAM ~25 MB), collapses the duplicated garbage in the description block, copies the card body byte-for-byte and touches nothing else. Dry-run by default, `--apply` to fix; runs automatically as the first step of the nightly doctor and during `iva update`, so bloated vaults shrink back without manual steps.
- 🔄 **Vendored skill scripts now follow the template** — live vaults are created from `vault-template` once and never used to receive script fixes. `iva update`, the nightly doctor and `init-vault` now sync the skill *code* (never `schema.json`, cards or any user data) from the template into the live vault, so every existing install picks up this fix — and future ones — automatically.

[0.3.1]: https://github.com/smixs/iva/releases/tag/v0.3.1

## [0.3.0] - 2026-07-23

Feature: a control center in chat — `/menu` configures everything, a button-driven test gives Iva a character, and the whole interface speaks two languages.

- 🎛 **`/menu` — every setting in one place** — a nested inline menu covers what used to need SSH and `.env` editing: model & thinking effort (the existing wizards, embedded), the web-search provider with in-chat API-key intake and "where to get a key" links, interface language, Iva's character, her core memory, the personal userbot, Google Workspace, cron timers, the full skill list and a live status card (model, search, language, today's token spend). It runs out-of-band in the poll bridge — works even while Iva is busy, costs zero model tokens — and registers Telegram's blue command menu on start.
- 🎭 **Character test** — 10 statements about the Iva *you* want (yes / rather yes / rather no / no), scored deterministically over four axes — tone, expression, initiative, thinking style — into one of 16 named archetypes, from Big Sister to Strategist. Accept the portrait and it lands in `vault/PERSONA.md`, injected into the system prompt every turn: the character applies from the very next message, no rebuild, no restart. Retake anytime.
- 💾 **Core-memory interview** — six free-form questions about you; raw answers are archived to the vault and handed to Iva to distill into `CORE.md` herself, so the always-on memory core stays small and honest.
- 🌐 **Two languages everywhere** — every service string in the bridge and the channel now exists in English and Russian, and the language switches instantly from the menu: the setting lives in `data/settings.json`, read at runtime by both processes and by the model's language instruction. No restart, no rebuild.
- ⏹️ **Stop a running turn** — the working-status message carries a ⏹ Stop button (and `/stop` works as a command): the turn aborts mid-generation, finished steps stay in history. Messages sent while Iva is busy queue up with a 👀 reaction and are processed together with your next message instead of vanishing or firing mid-turn. The status message got an animated loader.
- 🔑 **Secrets stay secret** — API keys, userbot credentials and the Google client JSON are accepted only in private chats; the message with the secret is deleted first, and the value never reaches the model, the logs or an error text.

[0.3.0]: https://github.com/smixs/iva/releases/tag/v0.3.0

## [0.2.6] - 2026-07-22

Feature: civilized updates and a personal-account userbot (beta).

- ⬆️ **Quiet daily update check** — once a day Iva checks for a newer stable release without spending model tokens; if one exists, Telegram offers **Update / Later** once, all progress lands in one animated message, and the phased update preserves your local edits with rollback on failure. Legacy installs were moved to a working update channel; `/restart` and `/update` replies now show the current model, and emotional venting no longer lands in your identity facts.
- 🧪 **Personal Telegram userbot (beta)** — read and send from your *own* account, not just the bot; onboarding fully in chat (QR, no terminal) with a server-enforced anti-ban guardrail (FloodWait compliance, randomized pacing, circuit-breaker). Opt-in, at your own risk.

[0.2.6]: https://github.com/smixs/iva/releases/tag/v0.2.6

## [0.2.5] - 2026-07-15

Feature: Telegram rich messages.

- 🧾 **Tables, checklists, spoilers and math render natively** — replies containing these constructs go out via Bot API 10.1 `sendRichMessage`; everything else keeps the proven HTML path, and any rejection falls back gracefully, so the worst case equals prior behavior.

[0.2.5]: https://github.com/smixs/iva/releases/tag/v0.2.5

## [0.2.4] - 2026-07-09

Feature: Iva now works with Google Workspace out of the box, and picking a model on OpenRouter tells you what actually went wrong.

- 📮 **Google Workspace from chat** — Gmail, Calendar, Drive, Sheets and Docs are now first-class. The installer sets up the [`gws`](https://github.com/googleworkspace/cli) CLI for you (idempotently — a re-run or `iva update` keeps it current), the agent routes any Google task through it with structured JSON, and when it isn't connected yet Iva walks you through registering the key step by step, right in the conversation — no console spelunking on your own.
- 🩹 **OpenRouter errors that tell the truth** — the setup wizard used to reject a perfectly good model with a misleading "needs tool/function calling". It now unwraps the real upstream reason (e.g. "this model isn't available in your region") from OpenRouter's error envelope — handling both string and nested-object shapes — and only mentions function calling when that's genuinely the problem.

[0.2.4]: https://github.com/smixs/iva/releases/tag/v0.2.4

## [0.2.0] - 2026-07-04

Feature: memory that finds things by meaning and keeps facts current, plus deterministic hardening against prompt injection and secret leaks.

- 🧠 **Search by meaning, not the exact word** — recall used to be a raw `grep`: type the wrong synonym or a different word-form and the fact stayed hidden. Memory is now a ranked search — BM25 over your cards and summaries (built in on `node:sqlite`, no dependency, no index to babysit) plus a rerank by the **links between cards**, so asking about a person surfaces the people and projects connected to them. It's language-agnostic by design: term weight comes from your own vault, so it works the same in Russian, English, Chinese, or a mix — no hardcoded word lists.
- ♻️ **Facts that change get rewritten, not stacked** — when today contradicts an old card (you changed jobs, moved city, a decision was reverted), the nightly rollup now **rewrites the current value** and files the old one under a dated `## History`, instead of leaving two contradictory facts for search to trip over. A deterministic nightly pass flags same-entity conflicts; each fact is tagged `EXTRACTED` (you said it) or `INFERRED` (deduced) so Iva can hedge when it's guessing. The longer you use it, the fewer stale contradictions it carries.
- 🔒 **Strictly typed cards** — a new `write_card` path validates type and schema at write time, so the model can't invent a card type or smuggle in stray fields; the nightly maintenance coerces anything written the old way back into schema.
- 🛡️ **Untrusted content is gated** — forwarded messages, attachments, voice transcripts and web pages now pass through deterministic gates before and after the model: hidden prompt-injection (invisible characters, homoglyph tricks, override phrases) is defused on the way in, and API keys, tokens and exfiltration URLs are scrubbed from replies on the way out. Legitimate non-Latin text is never mangled — normalization is used only to detect, never to rewrite what you wrote.
- 🔌 **Optional semantic search** — for a large vault or genuinely fuzzy/cross-language queries, an opt-in hybrid mode adds vector search fused with the keyword ranking (RRF). One external key (Jina — no-train/EU, or DeepInfra — cheapest), or point it at a local Ollama endpoint and use no external key at all. Off by default; the installer asks once. Base memory needs nothing.

[0.2.0]: https://github.com/smixs/iva/releases/tag/v0.2.0

## [0.1.7] - 2026-06-29

Feature: Iva sees images, takes any attachment, and learns your corrections — plus the stability fixes that make all of it reliable.

- 👁️ **Iva sees images** — the main model (DeepSeek) is text-only, so an incoming picture used to be saved but never understood. Now every still image (photo, sticker, image document) is described by the provider's own vision model on the **same key** — `gemma3:12b` on Ollama, `gemini-3-flash` on OpenCode — with OCR of any text in the frame. The description is written into the day's memory and handed to the main model, so Iva answers by what's actually in the image. No extra subscription, no config; without a key the turn just continues without vision.
- 📎 **Any attachment, never a crash** — forwarding a photo or file used to kill the whole turn (Telegram serves files as `application/octet-stream`, which failed the upload policy with a fatal throw). Now every attachment type — photos, stickers, voice, video, and documents of any format — reaches the handler, and the model is always handed a **file path** rather than an inlined blob. Provider-agnostic and crash-proof: a bad media type can no longer take down the conversation.
- 🧠 **Learns your corrections** — the nightly rollup now scans the day for repeatable "do it this way" lessons and records them into CORE, which is read on every turn. A correction you make today is followed tomorrow — a procedural-memory loop with no new moving parts.
- 🌍 **English-first terminal** — the CLI (`iva update/doctor/status/config`) and every background job (poll bridge, memory rollup/doctor, daily digest) now print in English instead of mixed Russian. The installer stays bilingual and asks your language once.
- 🌳 **A new tree** — the ANSI willow is now a compact relay tree that shimmers in place while idle.

Stability — the fixes that make images and attachments dependable:

- 🩹 **A poisoned chat can't go silent anymore** — a malformed reasoning part from the provider could fail the model-message schema and wedge a whole thread until a manual restart. Reasoning is now stripped from the model's output before it's stored, so it can't poison the history; and deterministic errors (bad prompt, unknown tool) park the turn cleanly instead of burning three pointless retries.
- 🩹 **Attachments stop crashing the sandbox** — Iva now pins the lightweight `just-bash` sandbox (eve used to auto-pick Docker on any host with a daemon and then fail to provision it) and starts via `eve start`, so the sandbox template is actually built on every boot. Staging an image or file no longer throws.
- 🩹 **Updates survive a rewritten history** — `iva update` and the installer used `git pull --ff-only`, which aborted whenever `main` was force-pushed. They now fast-forward when possible and hard-reset to the remote on divergence, preserving your `.env` and vault.
- 🩹 **Vault wires itself** — `iva doctor` now creates the private `iva-vault` repo over `gh` itself instead of nagging every night, and only warns when `gh` is genuinely unavailable.

[0.1.7]: https://github.com/smixs/iva/releases/tag/v0.1.7

## [0.1.6] - 2026-06-24

Patch: usage reports in English.

- 🌍 **English `/usage` output** — `/usage` and `iva usage` now report in English (`in` / `out` / `cached`, plus window and source labels), matching the project's English-first surface. The source label also normalizes the raw channel kind (e.g. `channel:telegram` → `chat`).

[0.1.6]: https://github.com/smixs/iva/releases/tag/v0.1.6

## [0.1.5] - 2026-06-24

Feature: local token-usage accounting (issue #7).

- 📊 **See where your tokens go** — every model call now logs its real usage (input/output/cache tokens, model, source) to a plain local `data/usage.jsonl`. No dashboard, no SaaS meter, no external billing — just a file you can grep, diff, and back up. A single agent hook captures everything that spends tokens through Iva: foreground chat, the morning digest, and the nightly memory rollups, plus the `planner` subagent — with no double counting.
- 💬 **`/usage` in Telegram** — `/usage last` (the last turn), `/usage today`, `/usage week`, `/usage month`, `/usage by-model`, `/usage by-source`. The command is handled out-of-band by the poll bridge, so it costs zero tokens and works even while the agent is busy. Source attribution separates interactive chat from background jobs.
- 🖥️ **`iva usage` in the terminal** — the same summaries over the same log (`iva usage today`, `iva usage by-model`, `iva usage tail` for raw lines), for watching a VPS from the shell.
- Tokens only for now — Ollama/OpenCode are flat-rate subscriptions, so a fabricated dollar figure would mislead. Budget guardrails and a large-context heads-up are deferred to a later release.

[0.1.5]: https://github.com/smixs/iva/releases/tag/v0.1.5

## [0.1.4] - 2026-06-24

Patch: model switching no longer mutes the bot, and a real reset for stuck background work.

- 🔇 **Reconfigure no longer mutes the bot** — running `iva config` while Iva is up used to see Iva's own port as "busy" and move it (`8723 → 8724`), but `ASSISTANT_HOST` stayed on the old port. The poll bridge then talked to a port nobody listened on and the bot went silent. Now the current port is kept (it's Iva itself), and `ASSISTANT_HOST` always follows `IVA_PORT` for local setups — the server and its clients can't drift apart.
- ♻️ **`iva reset` and a real `/restart`** — a stuck or bloated turn lived in `.workflow-data`, which eve re-enqueues on every startup, so `iva restart` (and even a reboot) brought it right back. New `iva reset` stops the services, clears `.workflow-data`, and restarts; the Telegram `/restart` `/new` `/clear` `/compact` commands now do the same. This is the "reset that finally sticks."
- 🧠 **Honest about reminders** — Iva no longer improvises background `nohup sleep`/`curl` timers (the thing that ballooned `.workflow-data` and pegged the CPU). It has no push/scheduler, says so plainly, and stores "remind me later" requests as tasks instead.
- 📝 **Correct way to switch models** — the model is read from `.env` at process start, so a chat-time change applies only after `iva restart`; Iva now explains this instead of silently self-restarting mid-turn.

[0.1.4]: https://github.com/smixs/iva/releases/tag/v0.1.4

## [0.1.3] - 2026-06-22

Patch: Telegram formatting, an English-first installer, low-end VPS support, and the OpenCode model fix.

- 💬 **Telegram formatting everywhere** — a single hardened markdown → Telegram-HTML converter now handles EVERY message: chat replies, nightly reports, the morning digest. Cron reports used to arrive as raw `**text**` with `---` and backticks. The converter never throws on any input and always emits valid HTML (balanced tags, escaping, rich formatting per the Telegram docs); on a Telegram rejection it self-heals without losing the message and without loops.
- 🌍 **Bilingual installer** — language is the very first question (English by default), and all of `install.sh` prints in the chosen language. The choice flows into the agent and the vault, so it's asked only once.
- 💾 **Auto-swap for low-end VPS** — on a box with <1.5 GB RAM and no swap, `eve build` was OOM-killed (exit 137, "Killed"). The installer now creates a 2 GB swapfile before building (idempotent, with a disk-space check). Iva installs even on a $4 DigitalOcean droplet (512 MB).
- 🤖 **OpenCode Go model fix** — Iva sent the model ID with the `opencode-go/` prefix and the endpoint replied "Model … is not supported". It now sends the bare ID (`deepseek-v4-pro`); existing `.env` files with the prefix are fixed automatically after `iva update`.
- 🌳 **Tree on update** — `iva update` shows the same ANSI willow as the install.

[0.1.3]: https://github.com/smixs/iva/releases/tag/v0.1.3

## [0.1.2] - 2026-06-21

Patch: reliable startup and web search.

- 🔌 **Your own port** — the server runs on a configurable `IVA_PORT` (default `8723`) instead of the commonly-taken `3000`. The bot no longer goes silent over a port conflict; old installs migrate automatically on `iva update`.
- 🔎 **Web search with a provider picker** — Tavily / Exa / Parallel / Brave, chosen at install (or `iva config`), one key per provider. DuckDuckGo was dropped — it served a captcha from server IPs.
- 🩺 **Diagnostics** — `iva doctor` checks the port and the active search key; a preflight port-availability check during setup.
- 🧹 **Green typecheck** — fixed `parse_mode` in the Telegram channel.

[0.1.2]: https://github.com/smixs/iva/releases/tag/v0.1.2

## [0.1.0] - 2026-06-20

First release. A personal AI agent with memory in Telegram, set up with a single command.

- 🎙️ Voice and video — transcribes speech in any language
- 🧠 Tree-shaped memory (day, week, month, year) — tidies itself up at night
- 🔎 Fast search over memory
- 🤖 Choice of model — which AI runs inside (OpenCode Go from $5/mo or Ollama Cloud, DeepSeek recommended)
- 🧩 Skills and connections via MCP
- 🎛️ Telegram commands: `/help` `/task` `/tasks` `/digest` `/new` `/restart`
- 🔒 Replies only to you, memory stays with you
- 🎭 Personality changes right in the conversation

[0.1.0]: https://github.com/smixs/iva/releases/tag/v0.1.0
