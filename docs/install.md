# Install

Everything between `curl` and a working bot. One command on a fresh server: the installer asks your language, walks you through five keys, and ends by messaging you from your own bot.

## Requirements

- 🖥️ **A server or your own machine** — Ubuntu/Debian is the tested path (apt); Fedora (dnf) and macOS (brew) work too. Any always-on box.
- 🧠 **512MB RAM is enough** — on boxes under 1.5GB the installer adds a 2GB swapfile so the build isn't OOM-killed (needs ~2.6GB free disk).
- 🔑 **sudo** — asked up front, and only if system packages are missing or a swapfile is needed; the Chromium step may ask once more.

> Never used a server? The host sends you an address (IP), a login and a password. On Mac or Linux open Terminal, on Windows PowerShell, type `ssh root@YOUR_ADDRESS`, enter the password. You're in.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva/main/install.sh | bash
```

The first question is your language — English or Russian — before anything touches the system. Input is read from `/dev/tty`, so the wizard stays interactive even piped through `curl`. If there's no terminal at all (Docker, CI), setup is skipped and the script prints how to run it later.

## Setup wizard

Five steps. Each key comes with a direct link to where it lives, and each is validated live — a bad key is rejected on the spot, not discovered at runtime. Enter keeps the current value, so re-running the wizard (`iva config`) changes only what you want.

1. **Provider and model.** Ollama Cloud or OpenCode Go ([comparison](providers.md)); the key is checked against the API, then you pick a model from the provider's live list.
2. **Voice, search, hybrid memory.** Deepgram key (free starter credit); recognition language `multi` auto-detects ru/uz/en. The same step picks a web-search provider — Tavily, Exa, Parallel or Brave; Enter skips and search stays off — and offers optional hybrid memory with an embedding key.
3. **Telegram bot.** Paste the token from @BotFather; the wizard validates it via `getMe` and detects the bot's username itself.
4. **Access.** Send your new bot any message — "hi" works. The wizard reads `getUpdates`, shows who wrote, and you pick yourself. Iva answers only these IDs; an empty list means it answers nobody.
5. **Timezone, vault, port.** IANA timezone so nightly jobs run on your clock, the vault directory, and the port — default 8723, probed for conflicts.

## What install.sh does

- 📦 **System packages** — `git gh python3 ffmpeg pandoc poppler-utils` (`poppler` on brew): `gh` backs your vault up to a private GitHub repo, pandoc and poppler extract text from incoming docx/pdf files, ffmpeg converts media the transcriber can't take directly.
- 🐍 **uv** — runs the vault's Python maintenance scripts.
- 🟢 **Node 24 via nvm** — no root needed; 24 is a hard floor because memory search uses the built-in `node:sqlite`.
- 🌐 **agent-browser + Chromium** — headless browser for web tasks; the longest step, 1–3 minutes of visible download output.
- 🗂️ **Vault init** — your memory is created from `vault-template/` as a separate git repo, so personal data never enters the code repo.
- ⚙️ **systemd user units** — the agent service, the Telegram bridge and 5 memory timers, with linger enabled so they survive logout. Details: [deploy.md](deploy.md).
- 🧰 **The `iva` command** — installed into `~/.local/bin`: `iva status`, `iva doctor`, `iva update`. Full reference: [cli.md](cli.md).
- ✅ **Telegram confirmation** — the last thing the installer does is message you from your own bot: "Iva is installed and online. Send me a message — I'll reply." That's the success signal.

Re-running the same command later is safe: it reuses the existing checkout, fast-forwards it, and keeps `.env` and the vault untouched.

### Flags and overrides

Flags pass through the pipe with `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva/main/install.sh | bash -s -- --skip-setup
```

| Option | Effect |
|---|---|
| `--skip-setup` | install everything, don't run the wizard |
| `--non-interactive` | no questions at all — defaults only, wizard skipped |
| `-h`, `--help` | show the built-in help and exit |
| `REPO_URL=…` | install from a fork (default `https://github.com/smixs/iva.git`) |
| `BRANCH=…` | install a branch (default `main`) |
| `INSTALL_DIR=…` | where the code goes (default `~/iva`) |

The last three are environment variables, read by the script at startup.

## If the wizard didn't run

Skipped setup, or no terminal at install time:

```bash
cd ~/iva && npm run setup
```

Then re-run the install command above — it finds the existing checkout and finishes the build, the systemd units and the confirmation.

## Next steps

- Every `.env` variable, defaults and warnings — [configuration.md](configuration.md)
- The `iva` server CLI and Telegram commands — [cli.md](cli.md)
- Transport, timers, webhook mode and operations — [deploy.md](deploy.md)
