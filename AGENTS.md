# AGENTS.md — Iva

Iva is a self-hosted personal Telegram assistant built on the eve agent framework
(TypeScript ESM). Core runtime lives in `agent/` (import alias `#*` → `./agent/*`),
operational scripts in `scripts/`, CLI entry in `bin/iva.mjs`.

Build: `npm run build` (eve build — required after any `agent/*` change; `eve start`
does NOT rebuild). Typecheck: `npm run typecheck`. Tests: `node --test` over
`*.test.mjs` (see `test:security`, `test:update-ui` scripts).

Commit messages must describe only the code change — no AI/tool attribution of any
kind (no Co-Authored-By bots, no "Generated with" footers). See CLAUDE.md.

## Code Review Rules

- **Secrets and machine-specific paths.** Credentials must never live in tracked
  files. Telegram bot tokens, API keys, and session strings load only from a
  local, untracked, gitignored `.env` or from runtime data outside the repo;
  `data/`, `attachments/`, and the vault stay untracked. `.gitignore` must keep
  ignoring `.env`, `.env.*`, `data`, and `/vault/` — flag any PR that removes or
  narrows these entries, and reject files from these paths if they appear in
  Git's index. Also flag any hardcoded secret, token-looking literal, or absolute
  path from a specific machine (e.g. `/home/<user>/...`).
- **Auth and permission gates.** `agent/lib/eve-auth.*` and `scripts/lib/*auth*`,
  `scripts/lib/listener-security.*` define who may talk to the assistant and which
  chats may trigger actions. Flag any change that widens an allow-list, removes a
  chat-type check (secrets/settings must stay private-chat-only), or bypasses these
  gates from a new code path.
- **User data stays out of the repo.** Runtime user data belongs to the vault and
  `data/` (both untracked). Flag code that writes user content, chat logs, or
  generated files into tracked repo paths, and any PR that commits files from
  `data/`, `attachments/`, or a vault.
- **Self-host update path.** `iva update` runs under the OLD installed CLI: new
  update-flow steps only take effect starting from the NEXT release. Flag update
  logic that assumes the just-pulled code is already executing, and any change to
  `data/settings.json` or other persisted formats that is not
  backward-compatible — self-host users upgrade from arbitrary older versions.
- **Rebuild-sensitive changes.** Changes under `agent/` alter runtime behavior only
  after `eve build` (`eve start` does not rebuild). Any PR touching `agent/*` must
  account for a rebuild in its deploy/testing story; flag runtime-testing claims
  for `agent/*` changes that lack a rebuild step, and update-flow or deploy scripts
  that start the service after changing `agent/*` without running `eve build`.
- **Tool inputs are validated — and constrained.** Agent tools take zod-validated
  inputs, but schema validation alone is not input safety: a validated string can
  still carry command injection or path traversal. Flag new or changed tool
  parameters that skip zod validation; enum-like parameters without an allowlist
  of accepted values; file-path parameters not resolved and bounds-checked against
  their allowed base directory; and any handler that interpolates user-controlled
  strings into shell commands instead of passing them as arguments.

Safe areas needing no deep review: `docs/` static site, `README*` wording,
`deploy/*.service` unit descriptions. Mechanical style issues are left to CI.
