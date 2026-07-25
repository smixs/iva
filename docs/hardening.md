# Hardened deployment (opt-in)

By default Iva installs under the account that runs the installer, with `.env` inside the code
checkout. That's simple, and fine for a box you use only for Iva. If Iva shares a host with your
own work — or just to tighten the blast radius of a hijacked agent turn — you can move it onto a
dedicated, non-login service user with its config kept out of the repo.

## What it changes

- **Dedicated user.** A non-login (`nologin`), **no-sudo** system user owns the install and runs
  the services. A hijacked turn is confined to that user — not your account. If the preferred name
  (`iva`) is taken, a numbered variant (`iva_001`, `iva_002`, …) is chosen.
- **Config out of the code.** `.env` moves to `/etc/iva/iva.env` (`0600`, owned by the service
  user). A `git`/update operation never touches secrets. The `iva` CLI reads the env file from
  `IVA_ENV_FILE` → `/etc/iva/iva.env` → the in-tree `.env`, in that order.
- **Resource caps** on every unit (`TasksMax`, `LimitNOFILE`) to contain a runaway process.

Note: the main service is *not* wrapped in systemd namespace/capability sandboxing — the eve
runtime's headless-browser sandbox is incompatible with it (the unit fails at the `CAPABILITIES`
step). The isolation is the dedicated no-sudo user plus the relocated secrets.

## How to run it

Hardening always needs root and is a one-time action, so it's **SSH-only** — a deliberate choice
that keeps it out of the Telegram bot (a sudo password must never go through chat). Open an SSH
session on the server and run:

```bash
iva harden
```

It's independent of `iva update` — no code update required. On a host where sudo needs a password
it prompts once in the terminal; with passwordless sudo it runs unattended. If run with no terminal
on a password host it refuses with a clear message instead of hanging.

Your integrations are preserved — the OAuth tokens and keys move with the config, so nothing needs
to be reconnected. Running it again is a no-op once the install is already on a dedicated user.
