# Troubleshooting

Every entry below is a real failure someone hit, and the fix that shipped. Find your symptom, run the command. Env-var details live in [configuration.md](configuration.md); the full command reference in [cli.md](cli.md).

## Common issues

### Build killed / exit 137

Cause: `eve build` needs more RAM than a small VPS has — the kernel OOM-kills it. The installer normally adds a swapfile to prevent this ([install.md](install.md)), but skips it when free disk is too low. Add one by hand:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
cd ~/iva && npm run build
```

### Bot silent after iva config

Cause: before 0.1.4 the wizard saw Iva's own port as "busy", moved `IVA_PORT` 8723 → 8724 and left `ASSISTANT_HOST` on the old one — the bridge talked to a port nobody listened on.

```bash
iva update                                       # 0.1.4+ keeps the port and syncs the host
grep -E '^(IVA_PORT|ASSISTANT_HOST)' ~/iva/.env  # the two ports must match
iva restart
```

### Turn stuck / no reply

Cause: a wedged turn lives in `.workflow-data`, and eve re-enqueues it on every start — plain `iva restart` brings it right back.

```bash
iva reset   # stop services, clear .workflow-data, restart
```

From Telegram, `/restart` does the same. The poll bridge handles it out-of-band, so it works even while the agent is busy.

### Model changed in .env but nothing happened

Cause: the model is read once, at process start.

```bash
iva restart
```

### Voice note over 20MB ignored

Cause: Telegram's Bot API download cap ([providers.md](providers.md)) — the bridge never receives the audio. Split before sending:

```bash
ffmpeg -i note.m4a -f segment -segment_time 600 -c copy part%02d.m4a
```

### iva update fails after force-push

Cause: old versions used a destructive recovery path when upstream history changed. Re-run the current installer; it creates a backup ref, stashes tracked and untracked customizations by exact OID, and refuses an unsafe merge:

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva/main/install.sh | bash
```

Do not reset or clean the checkout. If the histories cannot be combined safely, the existing version and user files remain in place and the full reason is recorded under `data/logs/`.

### gh not available warnings

Cause: the nightly doctor backs your vault up to a private `iva-vault` GitHub repo through `gh`; unauthenticated `gh` means no off-box backup.

```bash
gh auth login                                      # the installer already put gh on the box
systemctl --user start iva-memory-doctor.service   # backup now: creates the private repo and pushes
```

`iva doctor` only reports a missing vault origin — the repo creation and push happen in the nightly memory-doctor job; the second command runs it immediately instead of waiting for 05:00.

### agent-browser fails on Ubuntu 24.04

Cause: Ubuntu 23.10+ blocks unprivileged user namespaces (AppArmor), so Chromium dies with "No usable sandbox". The installer writes the workaround; if it's missing:

```bash
echo '{ "args": "--no-sandbox" }' > ~/.agent-browser/config.json
agent-browser open about:blank && agent-browser close --all   # launch check
```

## Lifecycle

### Migrate to a new server

The step-by-step procedure — what to copy off the old box and how to restore it on the new one — is in [deploy.md](deploy.md) ("Moving servers").

### Restore memory from the iva-vault repo

The doctor commits and pushes the vault nightly at 05:00, so the remote is at most a day behind.

```bash
rm -rf ~/iva/vault
gh repo clone <user>/iva-vault ~/iva/vault
iva restart
```

### Uninstall

`iva uninstall`, with `--purge` to also delete code and vault — push the vault first; there is no undo. Details: [cli.md](cli.md).
