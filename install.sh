#!/usr/bin/env bash
#
# Установка ассистента (Ева) одной командой на голом VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/smixs/eve-assistant/main/install.sh | bash
#
# Ставит системные зависимости (git, gh, python3, ffmpeg, pandoc, poppler), uv, Node 24+ (nvm),
# npm-зависимости, проводит интерактивную настройку (Ollama + модель + Telegram +
# Deepgram + часовой пояс + vault), собирает агента и заводит systemd user-сервис плюс
# таймеры памяти. Live-vault инициализируется как отдельный git-репо для бэкапа.
#
# Интерактивная настройка читает ввод из /dev/tty — работает и при `curl | bash`
# (по SSH с реальным терминалом). Если терминала нет (Docker/CI), настройка пропускается,
# и в конце печатается команда запустить её вручную (`npm run setup`).
#
# Флаги (через `curl ... | bash -s -- <флаги>`):
#   --skip-setup        не запускать мастер настройки (запустишь сам: npm run setup)
#   --non-interactive   не задавать никаких вопросов (берёт дефолты; настройку пропускает)
#   -h, --help          показать эту справку
# Мгновенная реассурация: первый вывод сразу, чтобы не было тишины на старте.
printf '\n  \033[36m⏳ Идёт подготовка окружения — это может занять до минуты. Не прерывай процесс…\033[0m\n'
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/smixs/eve-assistant.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/eve-assistant}"
NODE_MAJOR_MIN=24

c_blue=$'\033[34m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_bold=$'\033[1m'; c_reset=$'\033[0m'
step() { echo "${c_blue}▸ $*${c_reset}"; }
ok()   { echo "${c_green}✓ $*${c_reset}"; }
warn() { echo "${c_yellow}! $*${c_reset}"; }
die()  { echo "${c_red}✗ $*${c_reset}" >&2; exit 1; }

# Громкий обработчик ошибок: больше никаких молчаливых выходов из-за set -e.
# Вынесен в функцию, чтобы временно снимать/возвращать его вокруг чужого кода
# (nvm внутри штатно делает `return <non-zero>` — без снятия trap это ложная тревога).
on_err() {
  local rc=$?
  echo >&2
  echo "${c_red}✗ Установка прервалась (код $rc). Упала команда: ${BASH_COMMAND}${c_reset}" >&2
  echo "${c_yellow}  Скопируй вывод выше и пришли — разберёмся.${c_reset}" >&2
}
trap on_err ERR

# ── Режим интерактивности (по образцу NousResearch/hermes-agent) ───────────
# НЕ делаем `exec < /dev/tty`: при `curl | bash` bash читает САМ скрипт из stdin-пайпа,
# и переназначение FD0 сломало бы чтение остатка. Вместо этого ввод подаём точечно
# каждому интерактивному потребителю из /dev/tty, а наличие терминала пробуем открытием.
RUN_SETUP=true
NON_INTERACTIVE=false
if [ -t 0 ]; then IS_INTERACTIVE=true; else IS_INTERACTIVE=false; fi

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-setup)      RUN_SETUP=false ;;
    --non-interactive) NON_INTERACTIVE=true; RUN_SETUP=false ;;
    -h|--help)
      sed -n '2,19p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) warn "неизвестный флаг: $1 (игнорирую)" ;;
  esac
  shift
done

# Терминал реально открывается? (в Docker-build узел /dev/tty есть, но open даёт ENXIO).
have_tty() { (: < /dev/tty) 2>/dev/null; }

# y/n-вопрос с дефолтом; источник ввода: stdin-tty → /dev/tty → дефолт.
prompt_yes_no() {
  local question="$1" default="${2:-no}" suffix answer=""
  case "$default" in [yY]*|1|true) suffix="[Y/n]" ;; *) suffix="[y/N]" ;; esac
  if   [ "$NON_INTERACTIVE" = true ]; then answer=""
  elif [ "$IS_INTERACTIVE" = true ]; then read -r -p "$question $suffix " answer || answer=""
  elif have_tty; then printf '%s %s ' "$question" "$suffix" > /dev/tty; IFS= read -r answer < /dev/tty || answer=""
  else answer=""; fi
  answer="$(printf '%s' "$answer" | tr -d '[:space:]')"
  if [ -z "$answer" ]; then
    case "$default" in [yY]*|1|true) return 0 ;; *) return 1 ;; esac
  fi
  case "$answer" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

echo
echo "  ${c_green}Ева${c_reset} — личный ассистент на eve + Ollama Cloud (bare-VPS)"
echo "  ─────────────────────────────────────────────"

# root запускает напрямую; иначе через sudo (один раз кешируем пароль).
run_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

# ─────────────────────────────────────────────────────────────────────────
# 1. Системные зависимости. Detect-then-install.
#    ffmpeg опционален (nova-3 обычно принимает видео напрямую); pandoc/poppler —
#    извлечение текста из присланных docx/pdf.
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
command -v pandoc >/dev/null 2>&1 || need_pkgs+=("pandoc")
if ! command -v pdftotext >/dev/null 2>&1; then
  # Имя пакета зависит от менеджера: brew → poppler, apt/dnf → poppler-utils.
  case "$PM" in brew) need_pkgs+=("poppler") ;; *) need_pkgs+=("poppler-utils") ;; esac
fi

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
  if [ "$major" -ge "$NODE_MAJOR_MIN" ]; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  step "Устанавливаю Node $NODE_MAJOR_MIN+ через nvm…"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # ВАЖНО: nvm внутри штатно делает `return <non-zero>` (особенно при npm `prefix`
  # в ~/.npmrc — частый случай с ~/.npm-global). Чтобы это НЕ роняло установку и НЕ
  # печатало ложную «ошибку», на время nvm снимаем ERR-trap и errexit. `nvm use` не
  # зовём вовсе — node берём прямо из каталога версии.
  trap - ERR
  set +e
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_MAJOR_MIN"
  NODE_BIN_DIR="$(nvm which "$NODE_MAJOR_MIN" 2>/dev/null | xargs -r dirname 2>/dev/null)"
  set -e
  trap on_err ERR
  if [ -z "${NODE_BIN_DIR:-}" ]; then
    NODE_BIN_DIR="$(ls -d "$NVM_DIR"/versions/node/v"$NODE_MAJOR_MIN"*/bin 2>/dev/null | sort -V | tail -1)"
  fi
  if [ -n "${NODE_BIN_DIR:-}" ]; then export PATH="$NODE_BIN_DIR:$PATH"; fi
fi
command -v node >/dev/null 2>&1 || die "Node $NODE_MAJOR_MIN+ не установился. Поставь вручную (nvm install $NODE_MAJOR_MIN) и перезапусти."
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
#    Читает /dev/tty → работает и при `curl | bash`. Без терминала — откладываем.
# ─────────────────────────────────────────────────────────────────────────
SETUP_DONE=false
if [ "$RUN_SETUP" = false ]; then
  warn "Настройка пропущена (флаг). Запусти потом: cd $PROJECT_DIR && npm run setup"
elif have_tty; then
  step "Настройка…"
  node scripts/setup.mjs < /dev/tty && SETUP_DONE=true
else
  warn "Нет терминала (/dev/tty) — пропускаю мастер. Запусти потом: cd $PROJECT_DIR && npm run setup"
fi

# ─────────────────────────────────────────────────────────────────────────
# 7. Сборка
# ─────────────────────────────────────────────────────────────────────────
step "Собираю агента (eve build)…"
npm exec -- eve build
ok "Сборка готова → .output"

# ─────────────────────────────────────────────────────────────────────────
# 8. Live-vault: ОТДЕЛЬНЫЙ приватный git-репо (память + бэкап + Obsidian)
#    Создаётся из vault-template/ (скелет в код-репо); личные данные в код-репо не идут.
# ─────────────────────────────────────────────────────────────────────────
VAULT_DIR_REL="$(grep -E '^ASSISTANT_VAULT_DIR=' .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"' || true)"
VAULT_DIR_REL="${VAULT_DIR_REL:-vault}"
case "$VAULT_DIR_REL" in
  /*) VAULT_PATH="$VAULT_DIR_REL" ;;
  *)  VAULT_PATH="$PROJECT_DIR/$VAULT_DIR_REL" ;;
esac
step "Готовлю live-vault из шаблона…"
ASSISTANT_VAULT_DIR="$VAULT_DIR_REL" node scripts/init-vault.mjs || warn "init-vault не отработал — проверь vault вручную"

# ─────────────────────────────────────────────────────────────────────────
# 9. systemd: основной сервис + таймеры памяти (Linux). Нужен настроенный .env.
# ─────────────────────────────────────────────────────────────────────────
if ! command -v systemctl >/dev/null 2>&1; then
  : # не Linux/systemd — пропускаем тихо
elif [ ! -f .env ]; then
  warn "Нет .env — автозапуск не настраиваю. Сначала: npm run setup, потом перезапусти install.sh."
elif prompt_yes_no "Завести автозапуск через systemd (сервис + таймеры памяти)?" yes; then
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

  # Таймеры/сервисы памяти из deploy/ с подстановкой плейсхолдеров путей.
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

# ─────────────────────────────────────────────────────────────────────────
# 10. Финал
# ─────────────────────────────────────────────────────────────────────────
echo
echo "${c_green}${c_bold}┌──────────────────────────────────────────┐${c_reset}"
echo "${c_green}${c_bold}│            ✓ Установка завершена          │${c_reset}"
echo "${c_green}${c_bold}└──────────────────────────────────────────┘${c_reset}"
echo
if [ "$SETUP_DONE" != true ]; then
  echo "  ${c_yellow}${c_bold}Сначала настрой ключи:${c_reset}  cd $PROJECT_DIR && npm run setup"
  echo "  Затем пересобери и запусти: npm run build && (systemctl --user restart eve-assistant)"
  echo
fi
echo "  ${c_bold}Команды:${c_reset}"
echo "    npm start         запуск агента (порт 3000)"
echo "    npm run dev       локальный TUI-диалог (порт 2000)"
echo "    npm run setup     мастер настройки (ключи/модель/TZ/vault)"
echo "    npm run smoke     проверка tool-loop"
echo
echo "  ${c_yellow}${c_bold}Vault-бэкап в git${c_reset} (один раз — приватный remote для памяти):"
echo "    gh auth login"
echo "    gh repo create <user>/eva-vault --private --source=\"$VAULT_PATH\" --remote=origin --push"
echo
echo "  ${c_yellow}${c_bold}Telegram webhook${c_reset}: нужен публичный HTTPS на порт 3000 (reverse-proxy + TLS),"
echo "  затем setWebhook с секретом. Подробности и таймеры памяти — в DEPLOY.md."
echo
