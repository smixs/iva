#!/usr/bin/env bash
#
# Установка ассистента (Ева) одной командой на голом VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/smixs/eve-assistant/main/install.sh | bash
#
# Ставит системные зависимости (git, gh, python3, ffmpeg), uv, Node 24+ (nvm),
# npm-зависимости, проводит интерактивную настройку (Ollama + модель + Telegram +
# Deepgram + часовой пояс + vault), собирает агента и заводит systemd user-сервис
# плюс таймеры памяти. Vault инициализируется как git-репо для бэкапа.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/smixs/eve-assistant.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/eve-assistant}"
NODE_MAJOR_MIN=24

c_blue=$'\033[34m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_reset=$'\033[0m'
step() { echo "${c_blue}▸ $*${c_reset}"; }
ok()   { echo "${c_green}✓ $*${c_reset}"; }
warn() { echo "${c_yellow}! $*${c_reset}"; }
die()  { echo "${c_red}✗ $*${c_reset}" >&2; exit 1; }

# Интерактивный ввод даже при запуске через `curl | bash`
if [ ! -t 0 ] && [ -r /dev/tty ]; then exec < /dev/tty; fi

echo
echo "  ${c_green}Ева${c_reset} — личный ассистент на eve + Ollama Cloud (bare-VPS)"
echo "  ─────────────────────────────────────────────"

# root запускает напрямую; иначе через sudo (один раз кешируем пароль).
run_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

# ─────────────────────────────────────────────────────────────────────────
# 1. Системные зависимости (git, gh, python3, ffmpeg). Detect-then-install.
#    curl/git нужны заранее; ffmpeg опционален (nova-3 обычно принимает
#    видео-контейнеры напрямую — берёт аудиодорожку; ffmpeg = страховка).
# ─────────────────────────────────────────────────────────────────────────
command -v curl >/dev/null || die "нужен curl (установи: apt/brew install curl)"

PM="none"
if   command -v apt-get >/dev/null 2>&1; then PM="apt"
elif command -v dnf     >/dev/null 2>&1; then PM="dnf"
elif command -v brew    >/dev/null 2>&1; then PM="brew"
fi

need_pkgs=()
command -v git    >/dev/null 2>&1 || need_pkgs+=("git")
command -v gh     >/dev/null 2>&1 || need_pkgs+=("gh")
command -v python3>/dev/null 2>&1 || need_pkgs+=("python3")
command -v ffmpeg >/dev/null 2>&1 || need_pkgs+=("ffmpeg")

if [ "${#need_pkgs[@]}" -gt 0 ]; then
  if [ "$PM" = "none" ]; then
    warn "не найден пакетный менеджер — установи вручную: ${need_pkgs[*]}"
    command -v git >/dev/null 2>&1 || die "git обязателен для установки"
  else
    step "Нужны системные пакеты: ${need_pkgs[*]} (через $PM)"
    # Кешируем sudo-пароль один раз в начале (если не root и нужен sudo).
    if [ "$(id -u)" -ne 0 ] && [ "$PM" != "brew" ]; then
      sudo -v || warn "sudo недоступен — системные пакеты могут не установиться"
    fi
    case "$PM" in
      apt)
        run_root apt-get update -qq || warn "apt-get update не прошёл"
        for p in "${need_pkgs[@]}"; do
          if [ "$p" = "gh" ]; then
            # gh нет в базовых репах Debian/Ubuntu — добавляем официальный источник.
            run_root mkdir -p -m 755 /etc/apt/keyrings
            curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
              | run_root tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
            run_root chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
            echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
              | run_root tee /etc/apt/sources.list.d/github-cli.list >/dev/null
            run_root apt-get update -qq
            run_root apt-get install -y -qq gh || warn "не удалось поставить gh"
          else
            run_root apt-get install -y -qq "$p" || warn "не удалось поставить $p"
          fi
        done
        ;;
      dnf)
        run_root dnf install -y -q "${need_pkgs[@]}" || warn "часть пакетов не установилась (${need_pkgs[*]})"
        ;;
      brew)
        for p in "${need_pkgs[@]}"; do brew install "$p" || warn "не удалось поставить $p"; done
        ;;
    esac
  fi
fi
command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || die "git так и не установлен"
command -v gh  >/dev/null 2>&1 && ok "gh готов" || warn "gh нет — vault-бэкап в git настроишь позже"
command -v ffmpeg >/dev/null 2>&1 && ok "ffmpeg готов" || warn "ffmpeg нет (nova-3 обычно принимает видео напрямую)"

# ─────────────────────────────────────────────────────────────────────────
# 2. uv (Python-менеджер для autograph-скриптов vault)
# ─────────────────────────────────────────────────────────────────────────
if command -v uv >/dev/null 2>&1 || [ -x "$HOME/.local/bin/uv" ]; then
  ok "uv уже установлен"
else
  step "Устанавливаю uv…"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null 2>&1 && ok "uv $(uv --version 2>/dev/null | awk '{print $2}')" || warn "uv не на PATH — открой новый шелл"

# ─────────────────────────────────────────────────────────────────────────
# 3. Node 24+ (через nvm, без root)
# ─────────────────────────────────────────────────────────────────────────
need_node=1
if command -v node >/dev/null; then
  major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  [ "$major" -ge "$NODE_MAJOR_MIN" ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  step "Устанавливаю Node $NODE_MAJOR_MIN+ через nvm…"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_MAJOR_MIN"
  nvm use "$NODE_MAJOR_MIN"
fi
ok "Node $(node -v)"

# ─────────────────────────────────────────────────────────────────────────
# 4. Код проекта (текущий каталог / обновление / клон)
# ─────────────────────────────────────────────────────────────────────────
SOURCE="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [ -n "$SOURCE" ] && [ -f "$SOURCE" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
fi
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] && grep -q '"eve"' "$SCRIPT_DIR/package.json"; then
  PROJECT_DIR="$SCRIPT_DIR"
  step "Использую текущий каталог: $PROJECT_DIR"
elif [ -d "$INSTALL_DIR/.git" ]; then
  PROJECT_DIR="$INSTALL_DIR"
  step "Обновляю $PROJECT_DIR…"
  git -C "$PROJECT_DIR" pull --ff-only origin "$BRANCH"
else
  step "Клонирую $REPO_URL → $INSTALL_DIR…"
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  PROJECT_DIR="$INSTALL_DIR"
fi
cd "$PROJECT_DIR"

# ─────────────────────────────────────────────────────────────────────────
# 5. npm-зависимости
# ─────────────────────────────────────────────────────────────────────────
step "Ставлю зависимости…"
if [ -f package-lock.json ]; then npm ci; else npm install; fi
ok "Зависимости установлены"

# ─────────────────────────────────────────────────────────────────────────
# 6. Интерактивная настройка (Ollama + модель + Telegram + Deepgram + TZ + vault)
# ─────────────────────────────────────────────────────────────────────────
step "Настройка…"
node scripts/setup.mjs

# ─────────────────────────────────────────────────────────────────────────
# 7. Сборка
# ─────────────────────────────────────────────────────────────────────────
step "Собираю агента (eve build)…"
npm exec -- eve build
ok "Сборка готова → .output"

# ─────────────────────────────────────────────────────────────────────────
# 8. Vault как приватный git-репо (память + бэкап + Obsidian)
# ─────────────────────────────────────────────────────────────────────────
VAULT_DIR_REL="$(grep -E '^ASSISTANT_VAULT_DIR=' .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"' || true)"
VAULT_DIR_REL="${VAULT_DIR_REL:-vault}"
case "$VAULT_DIR_REL" in
  /*) VAULT_PATH="$VAULT_DIR_REL" ;;
  *)  VAULT_PATH="$PROJECT_DIR/$VAULT_DIR_REL" ;;
esac
mkdir -p "$VAULT_PATH"
if [ ! -d "$VAULT_PATH/.git" ]; then
  step "Инициализирую vault git-репо: $VAULT_PATH"
  git -C "$VAULT_PATH" init -q
  [ -f "$VAULT_PATH/.gitignore" ] || printf '.DS_Store\n.obsidian/workspace*\n' > "$VAULT_PATH/.gitignore"
  ok "vault git-репо создан"
else
  ok "vault уже git-репо"
fi

# ─────────────────────────────────────────────────────────────────────────
# 9. systemd: основной сервис + таймеры памяти (Linux)
# ─────────────────────────────────────────────────────────────────────────
if command -v systemctl >/dev/null 2>&1; then
  read -r -p "Завести автозапуск через systemd (сервис + таймеры памяти)? (y/N) " a
  if echo "${a:-}" | grep -qi '^y'; then
    NODE_BIN="$(command -v node)"
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"

    # Основной сервис агента
    cat > "$UNIT_DIR/eve-assistant.service" <<EOF
[Unit]
Description=eve assistant (Ева)
After=network-online.target

[Service]
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=$PROJECT_DIR/.env
ExecStart=$NODE_BIN $PROJECT_DIR/.output/server/index.mjs
Environment=PORT=3000
Restart=always

[Install]
WantedBy=default.target
EOF

    # Таймеры/сервисы памяти из deploy/ (создаются компонентом памяти).
    # Подставляем пути проекта/Node, если в юнитах есть плейсхолдеры.
    timers_installed=0
    if compgen -G "$PROJECT_DIR/deploy/eve-memory-*.service" >/dev/null 2>&1; then
      step "Устанавливаю таймеры памяти из deploy/…"
      for f in "$PROJECT_DIR"/deploy/eve-memory-*.service "$PROJECT_DIR"/deploy/eve-memory-*.timer; do
        [ -e "$f" ] || continue
        sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
            -e "s|__NODE_BIN__|$NODE_BIN|g" \
            "$f" > "$UNIT_DIR/$(basename "$f")"
      done
      timers_installed=1
    else
      warn "deploy/eve-memory-*.{service,timer} не найдены — таймеры памяти пропущены"
    fi

    systemctl --user daemon-reload
    systemctl --user enable --now eve-assistant.service
    if [ "$timers_installed" -eq 1 ]; then
      for t in "$PROJECT_DIR"/deploy/eve-memory-*.timer; do
        [ -e "$t" ] || continue
        systemctl --user enable --now "$(basename "$t")" || warn "не удалось включить $(basename "$t")"
      done
      ok "Таймеры памяти включены: systemctl --user list-timers"
    fi
    loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "не удалось включить linger (сервис не стартует до логина)"
    ok "Сервис запущен: systemctl --user status eve-assistant"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────
# 10. Финал
# ─────────────────────────────────────────────────────────────────────────
echo
ok "Готово."
echo
echo "  Запуск вручную:   cd $PROJECT_DIR && npm start"
echo "  Локальный диалог: npm run dev   (TUI)"
echo "  Проверка:         npm run smoke"
echo
echo "  ${c_yellow}Vault-бэкап в git:${c_reset} один раз авторизуйся и привяжи приватный remote:"
echo "    gh auth login"
echo "    gh repo create <user>/eva-vault --private --source=\"$VAULT_PATH\" --remote=origin --push"
echo "    # или вручную: git -C \"$VAULT_PATH\" remote add origin git@github.com:<user>/eva-vault.git"
echo
echo "  Telegram webhook (после публичного HTTPS-домена) и таймеры памяти — см. DEPLOY.md"
echo
