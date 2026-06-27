#!/usr/bin/env bash
#
# Install Iva (a personal long-term-memory agent) with one command on a bare VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/smixs/iva/main/install.sh | bash
#
# Installs system dependencies (git, gh, python3, ffmpeg, pandoc, poppler), uv, Node 24+ (nvm),
# npm dependencies, runs an interactive setup (Ollama + model + Telegram +
# Deepgram + timezone + vault), builds the agent and sets up a systemd user service plus
# memory timers. The live vault is initialized as a separate git repo for backup.
#
# The interactive setup reads input from /dev/tty — so it works with `curl | bash` too
# (over SSH with a real terminal). If there's no terminal (Docker/CI), setup is skipped,
# and the command to run it manually is printed at the end (`npm run setup`).
#
# Flags (via `curl ... | bash -s -- <flags>`):
#   --skip-setup        don't run the setup wizard (run it yourself: npm run setup)
#   --non-interactive   don't ask any questions (use defaults; skip setup)
#   -h, --help          show this help
# Instant reassurance: print something right away so there's no silence at startup.
printf '\n  \033[36m⏳ Preparing environment / Идёт подготовка окружения — up to a minute, do not interrupt…\033[0m\n'
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/smixs/iva.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/iva}"
NODE_MAJOR_MIN=24

c_blue=$'\033[34m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_bold=$'\033[1m'; c_reset=$'\033[0m'
step() { echo "${c_blue}▸ $*${c_reset}"; }
ok()   { echo "${c_green}✓ $*${c_reset}"; }
warn() { echo "${c_yellow}! $*${c_reset}"; }
die()  { echo "${c_red}✗ $*${c_reset}" >&2; exit 1; }

# Installer language and the agent's default reply language. Default is English (global audience);
# asked as the FIRST question (pick_language below). t en ru — picks a string by language.
IVA_LANG=en
t() { if [ "$IVA_LANG" = ru ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }

show_tree() {
  [ -t 1 ] || return 0   # only in a real terminal (not in logs/CI)
  printf '%b' "$(cat <<'IVA_TREE'
                \033[38;2;126;141;74mc\033[38;2;142;186;43mx\033[38;2;157;146;41ma\033[38;2;78;154;73m!\033[38;2;105;103;79mi\033[38;2;105;53;79m:\033[0m
           \033[38;2;61;177;90m;\033[38;2;84;91;111mc\033[38;2;46;77;117mi\033[38;2;25;73;134m!\033[38;2;50;158;114mi\033[38;2;109;178;62ma\033[38;2;31;143;143mc\033[38;2;116;161;70ma\033[38;2;185;151;29ma\033[38;2;135;164;52mc\033[38;2;172;114;30m*\033[38;2;177;51;35mo\033[38;2;194;55;32m. \033[38;2;178;195;26m!\033[38;2;121;179;30m!\033[0m
         \033[38;2;144;202;31m:\033[38;2;70;148;87mi\033[38;2;159;160;50ma\033[38;2;44;90;138mc\033[38;2;30;79;146mc\033[38;2;34;60;145mc\033[38;2;75;171;81ma\033[38;2;111;178;62mc\033[38;2;49;165;113ma\033[38;2;132;131;56m*\033[38;2;190;60;31mx\033[38;2;153;98;45m*\033[38;2;168;105;40m*\033[38;2;198;72;31mx\033[38;2;195;98;29m*\033[38;2;92;147;88mi\033[38;2;83;149;91mc\033[38;2;120;175;50ma\033[38;2;123;192;41mo\033[38;2;98;178;67mc\033[38;2;113;184;37m!\033[38;2;173;51;35m:\033[0m
         \033[38;2;68;160;103m:\033[38;2;39;145;139mc\033[38;2;46;120;130ma\033[38;2;25;99;153mc\033[38;2;21;138;157mc\033[38;2;48;120;121mo\033[38;2;140;192;34ma\033[38;2;67;162;96mo\033[38;2;107;175;68ma\033[38;2;81;152;93ma\033[38;2;172;140;29mx\033[38;2;167;108;48mo\033[38;2;177;71;45mi\033[38;2;194;106;33ma\033[38;2;183;145;31mx\033[38;2;126;194;47m*\033[38;2;44;150;120mo\033[38;2;31;85;148m;\033[38;2;83;165;83mo\033[38;2;43;169;124mo\033[38;2;80;161;76mc\033[38;2;102;119;80mc\033[38;2;205;111;26m;\033[0m
       \033[38;2;194;82;33m.\033[38;2;108;130;89m!\033[38;2;70;130;106mi\033[38;2;23;114;158mc\033[38;2;22;130;163mo\033[38;2;87;174;87mo\033[38;2;41;153;133mc\033[38;2;29;111;152mi\033[38;2;74;152;105ma\033[38;2;22;139;150mo\033[38;2;37;118;134mi\033[38;2;72;179;80ma\033[38;2;65;184;93ma\033[38;2;119;178;61m*\033[38;2;148;151;57ma\033[38;2;155;137;52m*\033[38;2;135;181;56m*\033[38;2;70;185;88ma\033[38;2;35;143;133mc\033[38;2;156;113;55mo\033[38;2;73;170;80m*\033[38;2;84;132;78mo\033[38;2;133;129;68mc\033[38;2;76;175;81mo\033[38;2;121;186;58mo\033[0m
      \033[38;2;145;105;59m!\033[38;2;155;131;52m*\033[38;2;116;174;50ma\033[38;2;93;179;67ma\033[38;2;130;167;43m*\033[38;2;100;175;65ma\033[38;2;40;119;131mc\033[38;2;29;81;141mi\033[38;2;36;149;135mc\033[38;2;45;162;133ma\033[38;2;41;167;137mc\033[38;2;54;152;119mc\033[38;2;54;140;107mc\033[38;2;44;118;132mc\033[38;2;55;151;128mc\033[38;2;104;157;74mo\033[38;2;112;174;55ma\033[38;2;125;183;48ma\033[38;2;60;186;109mo\033[38;2;37;167;126mo\033[38;2;157;167;38m*\033[38;2;69;125;116ma\033[38;2;115;153;80mc\033[38;2;30;121;146mi\033[38;2;92;183;73mo\033[38;2;147;169;52mc\033[0m
     \033[38;2;109;71;70m.\033[38;2;167;139;51m*\033[38;2;206;132;24m*\033[38;2;191;162;23m*\033[38;2;110;158;76mo\033[38;2;65;74;118mi\033[38;2;45;109;139mc\033[38;2;45;91;125mi\033[38;2;48;57;93m.\033[38;2;24;110;150mi\033[38;2;35;181;141mc\033[38;2;47;150;127mc\033[38;2;52;87;130mi\033[38;2;34;103;142mi\033[38;2;43;138;127ma\033[38;2;90;165;86mo\033[38;2;102;157;90mo\033[38;2;28;126;153mc\033[38;2;52;161;110mo\033[38;2;31;132;136mi\033[38;2;53;171;106mi\033[38;2;84;182;71ma\033[38;2;165;168;28mx\033[38;2;146;175;50ma\033[38;2;57;176;98mc\033[38;2;36;141;137mo\033[38;2;43;122;119mo\033[38;2;33;52;137mi\033[38;2;34;62;122m:\033[38;2;105;93;84mi\033[38;2;149;79;55m;\033[0m
    \033[38;2;185;52;32m:\033[38;2;176;72;40m*\033[38;2;139;163;48mo\033[38;2;146;166;57ma\033[38;2;172;135;35mx\033[38;2;129;129;69mc\033[38;2;31;83;156mi\033[38;2;38;83;136mo\033[38;2;35;46;138m;\033[38;2;29;85;147m!\033[38;2;32;69;156mi\033[38;2;37;124;131mo\033[38;2;43;101;123mc\033[38;2;29;83;138m:\033[38;2;46;23;116m.\033[38;2;43;21;104m:\033[38;2;47;77;108m!\033[38;2;87;125;81mi\033[38;2;63;153;107ma\033[38;2;55;121;121mo\033[38;2;25;109;161mc\033[38;2;36;142;122mc\033[38;2;81;156;107ma\033[38;2;125;178;57ma\033[38;2;122;129;62ma\033[38;2;125;138;59ma\033[38;2;73;160;108ma\033[38;2;41;135;118mo\033[38;2;26;133;151mc\033[38;2;28;102;148mi\033[38;2;30;98;143mi\033[38;2;48;140;127ma\033[38;2;50;74;107m.\033[0m
   \033[38;2;173;114;31mo\033[38;2;182;104;29ma\033[38;2;183;93;29mx\033[38;2;122;149;61ma\033[38;2;70;149;105mc\033[38;2;154;116;39m*\033[38;2;149;103;36m*\033[38;2;103;127;88ma\033[38;2;107;103;89mi\033[38;2;82;147;84mo\033[38;2;67;164;98mo\033[38;2;66;153;99ma\033[38;2;87;178;87ma\033[38;2;136;132;64m*\033[38;2;142;144;50m*\033[38;2;63;164;97mi\033[38;2;133;176;45mc\033[38;2;128;158;64mc\033[38;2;61;112;110mi\033[38;2;63;138;123mo\033[38;2;61;152;117mo\033[38;2;44;118;132mo\033[38;2;106;127;64mo\033[38;2;86;96;112ma\033[38;2;59;162;100mc\033[38;2;27;93;147m!\033[38;2;35;137;137mo\033[38;2;59;161;102mo\033[38;2;85;160;85ma\033[38;2;44;142;121mc\033[38;2;73;154;83mc\033[38;2;54;167;112mo\033[38;2;121;175;66m*\033[38;2;57;130;114mi\033[38;2;32;159;140m:\033[0m
   \033[38;2;144;173;31m*\033[38;2;157;171;30m*\033[38;2;177;138;33m*\033[38;2;112;118;75ma\033[38;2;63;117;127mo\033[38;2;103;174;76mo\033[38;2;85;184;64mc\033[38;2;143;175;51ma\033[38;2;172;186;33m*\033[38;2;102;186;58ma\033[38;2;35;86;137m;\033[38;2;39;86;144mc\033[38;2;141;188;46ma\033[38;2;74;165;84mo\033[38;2;92;139;67mi\033[38;2;58;149;102mo\033[38;2;102;151;59mo\033[38;2;121;191;57ma\033[38;2;87;170;80ma\033[38;2;33;124;136mo\033[38;2;28;88;143ma\033[38;2;110;145;65mo\033[38;2;158;159;39ma\033[38;2;172;87;42m*\033[38;2;139;126;61mo\033[38;2;34;126;132mo\033[38;2;49;171;111mc\033[38;2;63;174;89mc\033[38;2;51;171;111mc\033[38;2;44;166;126mc\033[38;2;47;152;114mc\033[38;2;52;140;110mi\033[38;2;40;171;130mo\033[38;2;79;174;86ma\033[38;2;57;170;113mc\033[38;2;31;44;151m.\033[0m
  \033[38;2;159;51;42m;\033[38;2;191;64;32mx\033[38;2;170;142;44m*\033[38;2;70;170;95mo\033[38;2;124;163;69mo\033[38;2;35;148;138mc\033[38;2;60;176;99mo\033[38;2;43;149;111mc\033[38;2;157;153;50m*\033[38;2;127;158;50ma\033[38;2;33;79;143mi\033[38;2;24;102;156mi\033[38;2;32;51;153mc\033[38;2;27;64;147mi\033[38;2;28;90;146mi\033[38;2;35;43;146mc\033[38;2;33;43;151mi\033[38;2;87;98;93mi\033[38;2;85;143;100ma\033[38;2;27;117;149mi\033[38;2;28;149;149mo\033[38;2;33;105;143m!\033[38;2;44;137;122mc\033[38;2;41;149;128mo\033[38;2;40;153;123mo\033[38;2;139;76;72m*\033[38;2;109;158;74ma\033[38;2;24;95;153mc\033[38;2;26;96;164mi\033[38;2;35;143;139mo\033[38;2;33;99;135mc\033[38;2;28;74;158m!\033[38;2;28;74;148mi\033[38;2;30;138;144mc\033[38;2;28;141;136mi\033[38;2;31;57;142m!\033[38;2;34;46;137m:\033[0m
 \033[38;2;154;130;43m!\033[38;2;60;165;104mc\033[38;2;156;194;28m*\033[38;2;185;128;28mw\033[38;2;169;158;27mx\033[38;2;94;138;93ma\033[38;2;24;101;156mc\033[38;2;43;140;124mo\033[38;2;45;148;128mc\033[38;2;48;155;124ma\033[38;2;39;126;138mo\033[38;2;33;47;157mi\033[38;2;30;47;154m;\033[38;2;24;110;161mi\033[38;2;35;34;133mi\033[38;2;37;45;131m:\033[38;2;30;50;140mi\033[38;2;34;53;151mi\033[38;2;27;89;149mi\033[38;2;28;76;149mi\033[38;2;27;72;145mi\033[38;2;31;55;162mi\033[38;2;28;72;162mi\033[38;2;49;99;113mc\033[38;2;42;52;121m!\033[38;2;81;169;72ma\033[38;2;78;163;98ma\033[38;2;48;153;121mc\033[38;2;35;41;152mi\033[38;2;28;80;152mo\033[38;2;23;124;153mi\033[38;2;39;95;136mo\033[38;2;48;108;123mc\033[38;2;33;55;144m!\033[38;2;40;30;130m:\033[38;2;29;82;147m!\033[38;2;32;43;149m!\033[38;2;40;42;132m!\033[38;2;92;150;82m*\033[0m
 \033[38;2;184;130;33ma\033[38;2;39;131;131mo\033[38;2;90;189;82ma\033[38;2;35;146;138mo\033[38;2;84;172;83mi\033[38;2;80;163;102mo\033[38;2;61;154;115ma\033[38;2;109;180;62ma\033[38;2;44;123;118mc\033[38;2;34;45;145m!\033[38;2;35;40;144m!\033[38;2;40;33;138m;\033[38;2;28;74;138mo\033[38;2;159;148;52mx\033[38;2;113;158;70ma\033[38;2;62;47;119mc\033[38;2;143;71;60m!\033[38;2;66;135;118mi\033[38;2;163;168;41m:\033[38;2;45;117;132m;\033[38;2;54;124;104m;\033[38;2;35;36;139m!\033[38;2;89;73;96mo\033[38;2;131;111;65mo\033[38;2;46;59;139mi\033[38;2;143;142;59mx\033[38;2;81;187;69ma\033[38;2;29;138;138mo\033[38;2;38;100;137m!\033[38;2;65;167;85mo\033[38;2;54;152;106mo\033[38;2;41;92;137mi\033[38;2;35;54;127m:\033[38;2;37;26;112m:\033[38;2;34;37;140mi\033[38;2;32;59;159mi\033[38;2;27;71;155m!\033[38;2;26;90;151mi\033[38;2;32;133;140mo\033[0m
\033[38;2;147;126;69m;\033[38;2;70;143;115mc\033[38;2;28;155;143mc\033[38;2;78;165;91mo\033[38;2;159;169;39m*\033[38;2;110;179;59ma\033[38;2;71;151;103mo\033[38;2;55;175;123mo\033[38;2;66;170;100mo\033[38;2;73;177;82mo\033[38;2;51;80;108mi\033[38;2;27;97;155mi\033[38;2;30;61;140m!\033[38;2;30;90;149mi\033[38;2;157;107;55ma\033[38;2;162;122;29m;\033[38;2;39;43;132m!\033[38;2;36;35;122m:\033[38;2;24;108;162m.\033[38;2;32;32;122m.\033[38;2;47;105;124mi\033[38;2;53;137;118mi\033[38;2;35;74;149mi\033[38;2;35;44;149m.\033[38;2;30;130;135m:\033[38;2;36;122;125m;\033[38;2;91;150;89mo\033[38;2;172;103;40m*\033[38;2;163;150;42mi\033[38;2;189;117;44m!\033[38;2;138;146;60m!\033[38;2;45;98;127m;\033[38;2;42;53;131m!\033[38;2;54;103;111m!\033[38;2;50;134;113m!\033[38;2;31;71;141m;\033[38;2;99;102;101mc\033[38;2;44;78;129mi\033[38;2;27;108;158mc\033[38;2;25;88;150mc\033[38;2;178;115;34m!\033[0m
\033[38;2;31;58;153m.\033[38;2;21;106;145m!\033[38;2;29;121;150mc\033[38;2;117;154;84m*\033[38;2;86;159;91ma\033[38;2;35;88;130mi\033[38;2;27;108;153m:\033[38;2;40;148;125mo\033[38;2;79;106;105mo\033[38;2;141;150;57mo\033[38;2;73;114;115m!\033[38;2;34;105;151m!\033[38;2;23;114;160mi\033[38;2;69;168;78mc\033[38;2;30;66;150m; \033[38;2;28;92;150m;\033[38;2;42;40;118m:\033[38;2;36;48;137m.\033[38;2;40;42;139m:\033[38;2;35;38;145m.\033[38;2;105;110;84m!\033[38;2;60;116;117mo\033[38;2;29;97;157m:\033[38;2;90;161;65m;\033[38;2;50;70;130m;\033[38;2;56;151;115mc\033[38;2;168;159;49mi  \033[38;2;128;161;54m!\033[38;2;75;143;95ma\033[38;2;115;89;70m;\033[38;2;113;193;63m;\033[38;2;120;157;69mo\033[38;2;60;123;131mo\033[38;2;27;86;154mo\033[38;2;26;90;139m!\033[38;2;27;85;156mi\033[38;2;38;34;130m;\033[38;2;165;135;32mo\033[0m
\033[38;2;145;86;60m:\033[38;2;42;87;137m;\033[38;2;27;117;141mc\033[38;2;40;162;129ma\033[38;2;39;148;131mo\033[38;2;73;144;84mi\033[38;2;28;67;158m:\033[38;2;28;94;167mc\033[38;2;29;85;155mo\033[38;2;29;114;148m;  \033[38;2;95;144;69m;  \033[38;2;141;123;62mc\033[38;2;117;154;61m!\033[38;2;152;148;55m*\033[38;2;97;103;89mc\033[38;2;82;180;72m;  \033[38;2;74;127;78m;\033[38;2;107;191;41m. \033[38;2;163;175;31mi\033[38;2;25;85;156m.   \033[38;2;39;111;133mi\033[38;2;58;97;92m;\033[38;2;38;36;135m!\033[38;2;30;68;155mi\033[38;2;30;53;131m!\033[38;2;42;26;120m:\033[38;2;30;77;154m!\033[38;2;36;31;106m:\033[38;2;47;75;107mc\033[38;2;36;49;142m;\033[0m
\033[38;2;147;89;62ma\033[38;2;66;105;121mc\033[38;2;143;160;57m*\033[38;2;36;107;147mi\033[38;2;122;114;77mo\033[38;2;146;121;75mi\033[38;2;27;95;174m.\033[38;2;26;95;151mi\033[38;2;91;85;86m!\033[38;2;166;179;31m.  \033[38;2;128;88;74m;     \033[38;2;115;180;35m.\033[38;2;201;156;18m: \033[38;2;187;188;23m.        \033[38;2;34;40;142m:\033[38;2;26;85;145m!\033[38;2;105;133;82mo\033[38;2;155;149;40m*\033[38;2;61;148;103mc\033[38;2;33;74;130mi\033[38;2;30;59;154mc\033[38;2;34;33;116m:\033[38;2;45;158;126mi\033[38;2;37;117;145mc\033[38;2;194;121;31m:\033[0m
 \033[38;2;182;144;36ma\033[38;2;95;181;57m*\033[38;2;84;180;66mo\033[38;2;171;182;26mo  \033[38;2;29;129;142m:\033[38;2;49;124;118m;   \033[38;2;165;64;49mc\033[38;2;189;78;35mo\033[38;2;26;65;150m.   \033[38;2;44;107;132m.\033[38;2;71;127;113mc\033[38;2;71;65;116m:          \033[38;2;54;123;121m;\033[38;2;68;141;115m;\033[38;2;186;53;32m.\033[38;2;140;58;71mi\033[38;2;157;55;50m!\033[38;2;155;127;65mo\033[38;2;63;126;112mc\033[38;2;46;159;127mo\033[38;2;85;189;64mo\033[38;2;175;156;30mo\033[0m
 \033[38;2;201;148;21ma\033[38;2;76;156;84m;\033[38;2;77;179;79ma\033[38;2;123;142;59mi  \033[38;2;44;90;124m:\033[38;2;108;148;68mc\033[38;2;128;188;45m:        \033[38;2;57;115;118m:\033[38;2;111;155;90mo\033[38;2;135;141;56m;\033[38;2;66;160;89m:\033[38;2;65;147;83m:       \033[38;2;90;145;74m:\033[38;2;122;72;88ma\033[38;2;31;85;148m: \033[38;2;145;91;74m.\033[38;2;51;97;127mi \033[38;2;106;138;74mi\033[38;2;125;119;62mo \033[38;2;207;68;32m.\033[0m
 \033[38;2;205;154;20m: \033[38;2;108;140;74ma    \033[38;2;112;156;73m!\033[38;2;131;179;51m;         \033[38;2;77;164;74m;\033[38;2;85;124;96mi\033[38;2;122;167;74mc\033[38;2;69;106;105m:         \033[38;2;87;184;58m.  \033[38;2;37;134;134m!\033[38;2;38;41;122m.\033[0m
   \033[38;2;125;107;64mc                \033[38;2;61;141;102m:\033[38;2;112;155;57mi\033[38;2;59;77;117mi\033[38;2;33;35;129m.           \033[38;2;132;161;66m!\033[38;2;64;73;108m.\033[0m
                  \033[38;2;95;136;46m.\033[38;2;144;120;72m!\033[38;2;74;154;89mc\033[38;2;156;121;39ma\033[38;2;148;125;59ma\033[38;2;100;142;99m;\033[0m
             \033[38;2;81;139;69m;\033[38;2;60;129;109mi\033[38;2;101;115;96mc  \033[38;2;92;162;60m.\033[38;2;163;141;61mo\033[38;2;119;121;90mo\033[38;2;30;59;146mi\033[38;2;29;68;155mo\033[38;2;28;79;151mi\033[38;2;44;23;114m.\033[38;2;132;124;77m!\033[38;2;33;85;148m.\033[0m
           \033[38;2;177;126;31mi\033[38;2;98;144;90ma\033[38;2;122;114;82mc\033[38;2;68;162;101mo\033[38;2;135;189;29m;\033[38;2;202;141;23m;\033[38;2;154;131;35m;\033[38;2;152;175;42mc\033[38;2;169;108;33mo\033[38;2;164;78;49mx\033[38;2;122;74;88mc\033[38;2;56;127;117mi\033[38;2;165;128;44mo\033[38;2;54;101;114mc\033[38;2;39;31;119m:\033[38;2;105;101;92mc\033[38;2;30;61;157m!\033[38;2;130;45;68mc\033[38;2;149;70;57mc\033[38;2;95;121;87mc\033[38;2;73;145;95mo\033[38;2;159;151;51mx\033[38;2;194;126;39mx\033[38;2;176;127;38ma\033[38;2;174;136;31m:\033[0m
      \033[38;2;82;178;68m.\033[38;2;99;141;69m;\033[38;2;68;90;118mc\033[38;2;138;126;73mo\033[38;2;97;100;81m:\033[38;2;56;31;110m.\033[38;2;21;124;154m:\033[38;2;204;112;34m;    \033[38;2;147;181;28m.\033[38;2;165;110;48m;\033[38;2;71;162;79m;\033[38;2;54;151;110m:\033[38;2;64;104;121m!\033[38;2;94;104;90m: \033[38;2;42;173;128m: \033[38;2;69;136;84m!\033[38;2;32;49;134mi\033[38;2;31;73;152m;\033[38;2;73;110;99mc\033[38;2;120;77;81mo\033[38;2;91;53;99m!\033[38;2;37;63;159m:\033[38;2;27;78;148m!\033[38;2;27;123;152m!\033[38;2;88;174;65mi\033[0m
                           \033[38;2;25;81;150m.\033[38;2;38;37;139m.     \033[38;2;36;37;144m. \033[38;2;116;166;54m!\033[38;2;65;78;109m:\033[38;2;107;97;90mc\033[0m
IVA_TREE
)"
  echo
}

# Loud error handler: no more silent exits from set -e.
# Pulled into a function so it can be temporarily removed/restored around foreign code
# (nvm normally does `return <non-zero>` internally — without removing the trap that's a false alarm).
on_err() {
  local rc=$?
  echo >&2
  echo "${c_red}✗ $(t "Install aborted (code $rc). Failing command: ${BASH_COMMAND}" "Установка прервалась (код $rc). Упала команда: ${BASH_COMMAND}")${c_reset}" >&2
  echo "${c_yellow}  $(t "Copy the output above and send it over — we'll sort it out." "Скопируйте вывод выше и пришлите — разберёмся.")${c_reset}" >&2
}
trap on_err ERR

# ── Interactivity mode (modeled on NousResearch/hermes-agent) ──────────────
# Do NOT `exec < /dev/tty`: with `curl | bash`, bash reads the script ITSELF from the stdin pipe,
# and reassigning FD0 would break reading the rest of it. Instead, feed input pointwise
# to each interactive consumer from /dev/tty, and probe for a terminal by trying to open it.
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
    *) warn "$(t "unknown flag: $1 (ignoring)" "неизвестный флаг: $1 (игнорирую)")" ;;
  esac
  shift
done

# Does the terminal actually open? (in a Docker build the /dev/tty node exists, but open gives ENXIO).
have_tty() { (: < /dev/tty) 2>/dev/null; }

# y/n question with a default; input source: stdin-tty → /dev/tty → default.
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

# Language is the VERY FIRST question, before any system work. Bilingual prompt, default English.
# We store the choice in AGENT_LANGUAGE and export it → setup.mjs and init-vault.mjs pick it up,
# so the language is asked exactly once.
pick_language() {
  local ans=""
  if [ "$NON_INTERACTIVE" != true ]; then
    printf '\n  %b🌐 Language / Язык%b\n' "${c_bold}${c_blue}" "$c_reset"
    printf '    [1] English  %b(default)%b\n    [2] Русский\n' "$c_green" "$c_reset"
    if   [ "$IS_INTERACTIVE" = true ]; then read -r -p "  > " ans || ans=""
    elif have_tty; then printf '  > ' > /dev/tty; IFS= read -r ans < /dev/tty || ans=""
    else ans=""; fi
  fi
  case "$(printf '%s' "$ans" | tr -d '[:space:]')" in
    2|ru|RU|[Рр]ус*) IVA_LANG=ru ;;
    *) IVA_LANG=en ;;
  esac
  export AGENT_LANGUAGE="$IVA_LANG"
}

echo
show_tree
pick_language   # ← first question: language (default English), before any install
echo "  ${c_green}Iva${c_reset} — $(t "your personal long-term-memory agent that just works" "личный агент с долговременной памятью, который просто работает")"
echo "  ─────────────────────────────────────────────"

# root runs directly; otherwise via sudo (cache the password once).
run_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

# ── Swap for weak VPSes ($4 DigitalOcean droplet = 512MB RAM) ──────────────
# On low RAM without swap, npm install and especially `eve build` (rolldown+nitro+node)
# fail with OOM — the kernel kills the process (Killed, code 137). If RAM < ~1.5GB and
# there's no swap — set up a 2GB swapfile BEFORE the heavy steps. Idempotent: don't touch
# active swap, just enable an existing /swapfile, and don't duplicate it in fstab.
ensure_swap() {
  local ram_mb swap_mb free_mb total
  ram_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
  swap_mb=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
  [ "${ram_mb:-0}" -ge 1500 ] && return 0          # enough memory
  [ "${swap_mb:-0}" -ge 1024 ] && return 0          # swap already present
  step "$(t "Low RAM (${ram_mb}MB), no swap — adding a 2GB swapfile so the build won't get OOM-killed…" "Мало RAM (${ram_mb}МБ), свопа нет — добавляю swapfile 2GB, чтобы сборку не убил OOM…")"
  if [ ! -f /swapfile ]; then
    free_mb=$(df -Pm / 2>/dev/null | awk 'NR==2{print $4}')
    if [ "${free_mb:-0}" -lt 2600 ]; then
      warn "$(t "Not enough free disk for a 2GB swapfile (${free_mb}MB free) — skipping. The build may OOM; free up space or use a bigger droplet." "Мало места под swapfile 2GB (свободно ${free_mb}МБ) — пропускаю. Сборка может упасть по OOM; освободите место или возьмите дроплет побольше.")"
      return 0
    fi
    run_root sh -c 'fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none' \
      || { warn "$(t "couldn't allocate /swapfile — skipping swap" "не смог создать /swapfile — пропускаю своп")"; return 0; }
    run_root chmod 600 /swapfile
    run_root mkswap /swapfile >/dev/null 2>&1 || { warn "mkswap failed — skipping swap"; return 0; }
  fi
  run_root swapon /swapfile 2>/dev/null || { warn "swapon failed — skipping swap"; return 0; }
  grep -qE '^[[:space:]]*/swapfile[[:space:]]' /etc/fstab 2>/dev/null \
    || echo '/swapfile none swap sw 0 0' | run_root tee -a /etc/fstab >/dev/null
  total=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo "?")
  ok "$(t "Swap on (${total}MB total) — build will have headroom" "Своп включён (всего ${total}МБ) — сборке хватит памяти")"
}
ensure_swap

# ─────────────────────────────────────────────────────────────────────────
# 1. System dependencies. Detect-then-install.
#    ffmpeg is optional (nova-3 usually accepts video directly); pandoc/poppler are for
#    extracting text from incoming docx/pdf files.
# ─────────────────────────────────────────────────────────────────────────
command -v curl >/dev/null || die "$(t "curl is required (install: apt/brew install curl)" "нужен curl (установи: apt/brew install curl)")"

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
  # The package name depends on the manager: brew → poppler, apt/dnf → poppler-utils.
  case "$PM" in brew) need_pkgs+=("poppler") ;; *) need_pkgs+=("poppler-utils") ;; esac
fi

if [ "${#need_pkgs[@]}" -gt 0 ]; then
  if [ "$PM" = "none" ]; then
    warn "$(t "no package manager found — install manually: ${need_pkgs[*]}" "не найден пакетный менеджер — установи вручную: ${need_pkgs[*]}")"
    command -v git >/dev/null 2>&1 || die "$(t "git is required to install" "git обязателен для установки")"
  else
    step "$(t "Need system packages: ${need_pkgs[*]} (via $PM)" "Нужны системные пакеты: ${need_pkgs[*]} (через $PM)")"
    # Cache the sudo password once up front (if not root and sudo is needed).
    if [ "$(id -u)" -ne 0 ] && [ "$PM" != "brew" ]; then
      sudo -v || warn "$(t "sudo unavailable — system packages may not install" "sudo недоступен — системные пакеты могут не установиться")"
    fi
    case "$PM" in
      apt)
        run_root apt-get update -qq || warn "$(t "apt-get update failed" "apt-get update не прошёл")"
        for p in "${need_pkgs[@]}"; do
          if [ "$p" = "gh" ]; then
            # gh isn't in the base Debian/Ubuntu repos — add the official source.
            run_root mkdir -p -m 755 /etc/apt/keyrings
            curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
              | run_root tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
            run_root chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
            echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
              | run_root tee /etc/apt/sources.list.d/github-cli.list >/dev/null
            run_root apt-get update -qq
            run_root apt-get install -y -qq gh || warn "$(t "couldn't install gh" "не удалось поставить gh")"
          else
            run_root apt-get install -y -qq "$p" || warn "$(t "couldn't install $p" "не удалось поставить $p")"
          fi
        done
        ;;
      dnf)
        run_root dnf install -y -q "${need_pkgs[@]}" || warn "$(t "some packages didn't install (${need_pkgs[*]})" "часть пакетов не установилась (${need_pkgs[*]})")"
        ;;
      brew)
        for p in "${need_pkgs[@]}"; do brew install "$p" || warn "$(t "couldn't install $p" "не удалось поставить $p")"; done
        ;;
    esac
  fi
fi
command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || die "$(t "git still not installed" "git так и не установлен")"
command -v gh  >/dev/null 2>&1 && ok "$(t "gh ready" "gh готов")" || warn "$(t "no gh — set up the vault git backup later" "gh нет — vault-бэкап в git настроишь позже")"
command -v ffmpeg >/dev/null 2>&1 && ok "$(t "ffmpeg ready" "ffmpeg готов")" || warn "$(t "no ffmpeg (nova-3 usually accepts video directly)" "ffmpeg нет (nova-3 обычно принимает видео напрямую)")"

# ─────────────────────────────────────────────────────────────────────────
# 2. uv (Python manager for the vault's autograph scripts)
# ─────────────────────────────────────────────────────────────────────────
if command -v uv >/dev/null 2>&1 || [ -x "$HOME/.local/bin/uv" ]; then
  ok "$(t "uv already installed" "uv уже установлен")"
else
  step "$(t "Installing uv…" "Устанавливаю uv…")"
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null 2>&1 && ok "uv $(uv --version 2>/dev/null | awk '{print $2}')" || warn "$(t "uv not on PATH — open a new shell" "uv не на PATH — откройте новый шелл")"

# ─────────────────────────────────────────────────────────────────────────
# 3. Node 24+ (via nvm, no root)
# ─────────────────────────────────────────────────────────────────────────
need_node=1
if command -v node >/dev/null; then
  major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$major" -ge "$NODE_MAJOR_MIN" ]; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  step "$(t "Installing Node $NODE_MAJOR_MIN+ via nvm…" "Устанавливаю Node $NODE_MAJOR_MIN+ через nvm…")"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # IMPORTANT: nvm normally does `return <non-zero>` internally (especially with an npm `prefix`
  # in ~/.npmrc — common with ~/.npm-global). So that this does NOT crash the install or
  # print a false "error", remove the ERR trap and errexit for the duration of nvm. We don't
  # call `nvm use` at all — we take node straight from the version directory.
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
command -v node >/dev/null 2>&1 || die "$(t "Node $NODE_MAJOR_MIN+ failed to install. Install it manually (nvm install $NODE_MAJOR_MIN) and re-run." "Node $NODE_MAJOR_MIN+ не установился. Поставьте вручную (nvm install $NODE_MAJOR_MIN) и перезапустите.")"
ok "Node $(node -v)"

# ─────────────────────────────────────────────────────────────────────────
# 4. Project code (current directory / update / clone)
# ─────────────────────────────────────────────────────────────────────────
SOURCE="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [ -n "$SOURCE" ] && [ -f "$SOURCE" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
fi
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] && grep -q '"eve"' "$SCRIPT_DIR/package.json"; then
  PROJECT_DIR="$SCRIPT_DIR"
  step "$(t "Using current directory: $PROJECT_DIR" "Использую текущий каталог: $PROJECT_DIR")"
elif [ -d "$INSTALL_DIR/.git" ]; then
  PROJECT_DIR="$INSTALL_DIR"
  step "$(t "Updating $PROJECT_DIR…" "Обновляю $PROJECT_DIR…")"
  git -C "$PROJECT_DIR" fetch --prune origin "$BRANCH"
  # Fast-forward when possible; on a rewritten upstream (force-push) the branches
  # diverge and ff is impossible — hard-reset to the remote instead of aborting.
  # Untracked files (.env, vault, …) are preserved by reset --hard.
  if git -C "$PROJECT_DIR" merge --ff-only "origin/$BRANCH" 2>/dev/null; then
    :
  else
    warn "$(t "Upstream history was rewritten — resetting to origin/$BRANCH (local commits to tracked files are discarded)." "История на сервере переписана — сбрасываю на origin/$BRANCH (локальные правки отслеживаемых файлов будут потеряны).")"
    git -C "$PROJECT_DIR" reset --hard "origin/$BRANCH"
  fi
else
  step "$(t "Cloning $REPO_URL → $INSTALL_DIR…" "Клонирую $REPO_URL → $INSTALL_DIR…")"
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  PROJECT_DIR="$INSTALL_DIR"
fi
cd "$PROJECT_DIR"

# ─────────────────────────────────────────────────────────────────────────
# 5. npm dependencies
# ─────────────────────────────────────────────────────────────────────────
step "$(t "Installing dependencies…" "Ставлю зависимости…")"
if [ -f package-lock.json ]; then npm ci; else npm install; fi
ok "$(t "Dependencies installed" "Зависимости установлены")"

# ─────────────────────────────────────────────────────────────────────────
# 5b. agent-browser (web automation: forms, logins, screenshots, scraping)
# ─────────────────────────────────────────────────────────────────────────
# The binary installs into npm-global; the path is needed here and in the service PATH (below).
NPM_GLOBAL_BIN="$(npm prefix -g 2>/dev/null)/bin"
export PATH="$NPM_GLOBAL_BIN:$PATH"
step "$(t "Installing the agent-browser (for web tasks)" "Ставлю браузер agent-browser (для веб-задач)")"
echo "  ${c_yellow}$(t "Next it downloads Chromium and system libraries — the longest step (1–3 min)." "Дальше скачается Chromium и системные библиотеки — это дольше всего (1–3 мин).")${c_reset}"
echo "  ${c_yellow}$(t "The output below = work under the hood, do NOT interrupt. It may ask for the sudo password again." "Поток вывода ниже = работа идёт под капотом, НЕ прерывай. Может снова спросить пароль sudo.")${c_reset}"
# Refresh the sudo cache ahead of time (a visible prompt here, not a hidden one mid-install).
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then sudo -v 2>/dev/null || true; fi
# Don't silence the output: the user should see progress (download/apt), otherwise it looks frozen.
if npm i -g agent-browser; then
  step "$(t "Downloading Chromium + system libraries…" "Скачиваю Chromium + системные библиотеки…")"
  agent-browser install --with-deps \
    || warn "$(t "agent-browser install --with-deps failed — finish later: agent-browser install --with-deps" "agent-browser install --with-deps не прошёл — доставишь позже: agent-browser install --with-deps")"
  # Chrome won't start on Ubuntu 23.10+/24.04: the kernel forbids unprivileged user
  # namespaces (AppArmor) → "No usable sandbox". On Linux, enable --no-sandbox by
  # default for all agent-browser calls (idempotent, without clobbering an existing config).
  if [ "$(uname -s)" = "Linux" ]; then
    node -e 'const fs=require("fs"),os=require("os"),p=require("path");const d=p.join(os.homedir(),".agent-browser"),f=p.join(d,"config.json");fs.mkdirSync(d,{recursive:true});let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}const w="--no-sandbox";const cur=typeof c.args=="string"?c.args:Array.isArray(c.args)?c.args.join(","):"";if(!cur.split(/[,\n]/).map(s=>s.trim()).filter(Boolean).includes(w)){c.args=cur?cur+","+w:w;fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")}' \
      2>/dev/null || warn "$(t "couldn't configure ~/.agent-browser/config.json — add \"args\": \"--no-sandbox\" manually" "не настроил ~/.agent-browser/config.json — добавь \"args\": \"--no-sandbox\" вручную")"
  fi
  # A real launch check: doctor ignores config args and falsely complains about the sandbox.
  if agent-browser open about:blank >/dev/null 2>&1; then
    agent-browser close --all >/dev/null 2>&1 || true
    ok "$(t "agent-browser ready" "agent-browser готов")"
  else
    warn "$(t "agent-browser installed but Chrome didn't start — check later: agent-browser open about:blank" "agent-browser поставлен, но Chrome не запустился — проверьте позже: agent-browser open about:blank")"
  fi
else
  warn "$(t "couldn't install agent-browser — browser tasks unavailable, everything else works" "не удалось поставить agent-browser — браузерные задачи недоступны, остальное работает")"
fi

# ─────────────────────────────────────────────────────────────────────────
# 6. Interactive setup (provider + model + Telegram + Deepgram + TZ + vault)
#    Reads /dev/tty → works with `curl | bash` too. Without a terminal — defer it.
# ─────────────────────────────────────────────────────────────────────────
SETUP_DONE=false
if [ "$RUN_SETUP" = false ]; then
  warn "$(t "Setup skipped (flag). Run it later: cd $PROJECT_DIR && npm run setup" "Настройка пропущена (флаг). Запустите потом: cd $PROJECT_DIR && npm run setup")"
elif have_tty; then
  step "$(t "Setup…" "Настройка…")"
  node scripts/setup.mjs < /dev/tty && SETUP_DONE=true
else
  warn "$(t "No terminal (/dev/tty) — skipping the wizard. Run it later: cd $PROJECT_DIR && npm run setup" "Нет терминала (/dev/tty) — пропускаю мастер. Запустите потом: cd $PROJECT_DIR && npm run setup")"
fi

# ─────────────────────────────────────────────────────────────────────────
# 7. Build
# ─────────────────────────────────────────────────────────────────────────
step "$(t "Building the agent (eve build)…" "Собираю агента (eve build)…")"
npm exec -- eve build
ok "$(t "Build ready → .output" "Сборка готова → .output")"

# ─────────────────────────────────────────────────────────────────────────
# 8. Live vault: a SEPARATE private git repo (memory + backup + Obsidian)
#    Created from vault-template/ (a skeleton in the code repo); personal data never enters the code repo.
# ─────────────────────────────────────────────────────────────────────────
VAULT_DIR_REL="$(grep -E '^ASSISTANT_VAULT_DIR=' .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"' || true)"
VAULT_DIR_REL="${VAULT_DIR_REL:-vault}"
case "$VAULT_DIR_REL" in
  /*) VAULT_PATH="$VAULT_DIR_REL" ;;
  *)  VAULT_PATH="$PROJECT_DIR/$VAULT_DIR_REL" ;;
esac
step "$(t "Preparing the live vault from the template…" "Готовлю live-vault из шаблона…")"
ASSISTANT_VAULT_DIR="$VAULT_DIR_REL" node scripts/init-vault.mjs || warn "$(t "init-vault didn't run — check the vault manually" "init-vault не отработал — проверьте vault вручную")"

# ─────────────────────────────────────────────────────────────────────────
# 8.5. The `iva` command in ~/.local/bin (update/config/doctor/uninstall/...).
#     A wrapper with hardcoded node+project paths — works from any shell.
# ─────────────────────────────────────────────────────────────────────────
step "$(t "Installing the iva command in ~/.local/bin…" "Ставлю команду iva в ~/.local/bin…")"
mkdir -p "$HOME/.local/bin"
printf '#!/usr/bin/env bash\nexec "%s" "%s/bin/iva.mjs" "$@"\n' "$(command -v node)" "$PROJECT_DIR" > "$HOME/.local/bin/iva"
chmod +x "$HOME/.local/bin/iva"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ok "$(t "The iva command is ready — try: iva help" "Команда iva готова — попробуй: iva help")" ;;
  *) warn "$(t "Add ~/.local/bin to PATH to call iva directly (or: \$HOME/.local/bin/iva help)" "Добавь ~/.local/bin в PATH, чтобы звать iva напрямую (или: \$HOME/.local/bin/iva help)")" ;;
esac

# ─────────────────────────────────────────────────────────────────────────
# 9. systemd: the main service + memory timers (Linux). Requires a configured .env.
# ─────────────────────────────────────────────────────────────────────────
if ! command -v systemctl >/dev/null 2>&1; then
  : # not Linux/systemd — skip silently
elif [ ! -f .env ]; then
  warn "$(t "No .env — not setting up autostart. First: npm run setup, then re-run install.sh." "Нет .env — автозапуск не настраиваю. Сначала: npm run setup, потом перезапустите install.sh.")"
elif prompt_yes_no "$(t "Set up autostart via systemd (service + memory timers)?" "Завести автозапуск через systemd (сервис + таймеры памяти)?")" yes; then
  # Delegate writing the units to the iva CLI — the single source of truth (see bin/iva.mjs writeUnits).
  step "$(t "Installing systemd units (via the iva CLI)…" "Ставлю systemd-юниты (через iva CLI)…")"
  node "$PROJECT_DIR/bin/iva.mjs" _install-units || die "$(t "couldn't write the systemd units" "не удалось записать systemd-юниты")"
  poll_installed=1
  timers_installed=1

  systemctl --user enable --now iva.service
  if [ "$poll_installed" -eq 1 ]; then
    systemctl --user enable --now iva-telegram-poll.service \
      && ok "$(t "Bot enabled and online" "Бот включён и на связи")" \
      || warn "$(t "couldn't start iva-telegram-poll (manually: npm run poll)" "не удалось запустить iva-telegram-poll (вручную: npm run poll)")"
  fi
  if [ "$timers_installed" -eq 1 ]; then
    for t in "$PROJECT_DIR"/deploy/iva-memory-*.timer; do
      [ -e "$t" ] || continue
      tname="$(basename "$t")"
      systemctl --user enable --now "$tname" || warn "$(t "couldn't enable $tname" "не удалось включить $tname")"
    done
    ok "$(t "Memory timers enabled: systemctl --user list-timers" "Таймеры памяти включены: systemctl --user list-timers")"
  fi
  loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "$(t "couldn't enable linger (the service won't start before login)" "не удалось включить linger (сервис не стартует до логина)")"
  ok "$(t "Service started: systemctl --user status iva" "Сервис запущен: systemctl --user status iva")"

  # Instant confirmation in Telegram (direct Bot API — doesn't depend on the server).
  _bot="$(grep -E '^TELEGRAM_BOT_TOKEN=' .env | head -n1 | cut -d= -f2- | tr -d '"' || true)"
  _chat="$(grep -E '^TELEGRAM_DIGEST_CHAT_ID=' .env | head -n1 | cut -d= -f2- | tr -d '"' || true)"
  if [ -z "$_chat" ]; then
    _chat="$(grep -E '^TELEGRAM_ALLOWED_USER_IDS=' .env | head -n1 | cut -d= -f2- | tr -d '"' | cut -d, -f1 || true)"
  fi
  if [ -n "$_bot" ] && [ -n "$_chat" ]; then
    curl -s "https://api.telegram.org/bot$_bot/sendMessage" \
      --data-urlencode "chat_id=$_chat" \
      --data-urlencode "text=$(t "✅ Iva is installed and online. Send me a message — I'll reply." "✅ Iva установлена и на связи. Напишите мне сообщение — отвечу.")" >/dev/null 2>&1 \
      && ok "$(t "Sent you a confirmation in Telegram — open the chat with the bot" "Отправил вам подтверждение в Telegram — откройте чат с ботом")" \
      || warn "$(t "couldn't send the confirmation (the bot still works — just message it)" "не смог отправить подтверждение (бот всё равно работает — просто напишите ему)")"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────
# 10. Final
# ─────────────────────────────────────────────────────────────────────────
echo
echo "${c_green}${c_bold}┌──────────────────────────────────────────┐${c_reset}"
echo "${c_green}${c_bold}│            $(t "✓ Installation complete   " "✓ Установка завершена      ")│${c_reset}"
echo "${c_green}${c_bold}└──────────────────────────────────────────┘${c_reset}"
echo
if [ "$SETUP_DONE" != true ]; then
  echo "  ${c_yellow}${c_bold}$(t "Configure the keys first:" "Сначала настройте ключи:")${c_reset}  cd $PROJECT_DIR && npm run setup"
  echo "  $(t "Then rebuild and start:" "Затем пересоберите и запустите:") npm run build && (systemctl --user restart iva)"
  echo
fi
echo "  ${c_bold}$(t "Commands (${c_green}iva${c_reset}${c_bold} — from anywhere):" "Команды (${c_green}iva${c_reset}${c_bold} — из любого места):")${c_reset}"
echo "    iva update        $(t "update (git pull + build + restart)" "обновить (git pull + сборка + рестарт)")"
echo "    iva config        $(t "configure (model/Telegram/Deepgram/TZ/vault)" "настройка (модель/Telegram/Deepgram/TZ/vault)")"
echo "    iva doctor        $(t "diagnose and auto-fix the install" "диагностика и авто-починка установки")"
echo "    iva status        $(t "services and timers status" "статус сервисов и таймеров")"
echo "    iva help          $(t "all commands" "все команды")"
echo
echo "  ${c_yellow}${c_bold}$(t "Vault backup in git" "Vault-бэкап в git")${c_reset} $(t "(one-time — a private remote for your memory):" "(один раз — приватный remote для памяти):")"
echo "    gh auth login"
echo "    gh repo create <user>/iva-vault --private --source=\"$VAULT_PATH\" --remote=origin --push"
echo
echo "  ${c_green}${c_bold}$(t "✅ The bot is ready" "✅ Бот готов")${c_reset} — $(t "just message it in Telegram." "просто напишите ему в Telegram.")"
echo "    $(t "Bot status:" "Статус бота:")  systemctl --user status iva-telegram-poll"
echo "    $(t "Bot logs:" "Логи бота:")    journalctl --user -u iva-telegram-poll -f"
echo
