#!/usr/bin/env python3
"""
Text sanitizer for untrusted input.
Strips invisible Unicode, wallet-draining chars, lookalikes.
Runs BEFORE any LLM sees the text. Zero API calls, instant.

Usage:
    echo "untrusted text" | python3 sanitizer.py
    python3 sanitizer.py --file input.txt
    python3 sanitizer.py --text "some text"
    python3 sanitizer.py --json  # structured output

Exit codes: 0=clean, 1=blocked, 2=error
"""

import sys
import re
import json
import unicodedata
import argparse
from pathlib import Path
from typing import NamedTuple


class SanitizeResult(NamedTuple):
    text: str
    blocked: bool
    reason: str
    stats: dict


# --- Invisible characters (zero-width, control, format) ---
# These are readable by LLMs but invisible to humans
INVISIBLE_CHARS = set()
for cp in range(0x110000):
    try:
        c = chr(cp)
        cat = unicodedata.category(c)
        # Cf = format, Cc = control (except \n\r\t), Mn with no base
        if cat == 'Cf' and cp not in (0xFEFF,):  # keep BOM for detection
            INVISIBLE_CHARS.add(c)
        elif cat == 'Cc' and c not in '\n\r\t':
            INVISIBLE_CHARS.add(c)
    except (ValueError, OverflowError):
        pass

# Add specific zero-width and invisible chars
INVISIBLE_CHARS.update({
    '\u200b',  # zero-width space
    '\u200c',  # zero-width non-joiner
    '\u200d',  # zero-width joiner
    '\u200e',  # left-to-right mark
    '\u200f',  # right-to-left mark
    '\u2060',  # word joiner
    '\u2061',  # function application
    '\u2062',  # invisible times
    '\u2063',  # invisible separator
    '\u2064',  # invisible plus
    '\ufeff',  # BOM / zero-width no-break space
    '\u00ad',  # soft hyphen
    '\u034f',  # combining grapheme joiner
    '\u061c',  # arabic letter mark
    '\u115f',  # hangul choseong filler
    '\u1160',  # hangul jungseong filler
    '\u17b4',  # khmer vowel inherent aq
    '\u17b5',  # khmer vowel inherent aa
    '\u180e',  # mongolian vowel separator
    '\uffa0',  # halfwidth hangul filler
})

# --- Wallet-draining characters ---
# Characters that tokenize to 3-10+ tokens while appearing as single char
# Tibetan, Yi, CJK rare, mathematical symbols
WALLET_DRAIN_RANGES = [
    (0x0F00, 0x0FFF),   # Tibetan
    (0xA000, 0xA4CF),   # Yi
    (0x1D400, 0x1D7FF), # Mathematical Alphanumeric Symbols
    (0x2800, 0x28FF),   # Braille
    (0x10000, 0x1003F), # Linear B Syllabary
    (0x10080, 0x100FF), # Linear B Ideograms
    (0x10300, 0x1032F), # Old Italic
    (0x10330, 0x1034F), # Gothic
]

def is_wallet_drain(c: str) -> bool:
    cp = ord(c)
    return any(start <= cp <= end for start, end in WALLET_DRAIN_RANGES)


# --- Lookalike characters ---
# Homoglyphs: visually identical to Latin but different codepoints
# Cyrillic, Greek, and other scripts that bypass regex
LOOKALIKES = {
    'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H',
    'К': 'K', 'М': 'M', 'О': 'O', 'Р': 'P', 'Т': 'T',
    'Х': 'X', 'а': 'a', 'с': 'c', 'е': 'e', 'о': 'o',
    'р': 'p', 'х': 'x', 'у': 'y',
    # Greek
    'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H',
    'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O',
    'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
    'ο': 'o', 'ν': 'v',
    # Fullwidth Latin
    'ａ': 'a', 'ｂ': 'b', 'ｃ': 'c', 'ｄ': 'd', 'ｅ': 'e',
    'ｆ': 'f', 'ｇ': 'g', 'ｈ': 'h', 'ｉ': 'i', 'ｊ': 'j',
    'ｋ': 'k', 'ｌ': 'l', 'ｍ': 'm', 'ｎ': 'n', 'ｏ': 'o',
    'ｐ': 'p', 'ｑ': 'q', 'ｒ': 'r', 'ｓ': 's', 'ｔ': 't',
    'ｕ': 'u', 'ｖ': 'v', 'ｗ': 'w', 'ｘ': 'x', 'ｙ': 'y',
    'ｚ': 'z',
}

# --- Combining mark flood ---
COMBINING_MARK_LIMIT = 5  # max combining marks per base char

# --- Encoded content patterns ---
ENCODED_PATTERNS = [
    # Base64 blocks (standalone, not inline)
    re.compile(r'^[A-Za-z0-9+/]{40,}={0,2}$', re.MULTILINE),
    # Hex blocks
    re.compile(r'^(?:[0-9a-fA-F]{2}\s*){20,}$', re.MULTILINE),
    # HTML entities used for smuggling
    re.compile(r'&#x?[0-9a-fA-F]+;', re.IGNORECASE),
]

# --- Role markers and override patterns ---
ROLE_MARKERS = re.compile(
    r'(?:^|\n)\s*'
    r'(?:system|assistant|user|human|AI|claude|instruction|admin|root)\s*[:\-]\s',
    re.IGNORECASE | re.MULTILINE
)

OVERRIDE_PATTERNS = [
    re.compile(r'ignore\s+(?:all\s+)?previous\s+instructions?', re.IGNORECASE),
    re.compile(r'forget\s+(?:all\s+)?(?:your\s+)?(?:previous\s+)?instructions?', re.IGNORECASE),
    re.compile(r'you\s+are\s+now\s+(?:in\s+)?(?:\w+\s+)?mode', re.IGNORECASE),
    re.compile(r'new\s+(?:system\s+)?instructions?\s*:', re.IGNORECASE),
    re.compile(r'override\s+(?:all\s+)?(?:safety|security|rules|guidelines)', re.IGNORECASE),
    re.compile(r'act\s+as\s+(?:if\s+)?(?:you\s+are\s+)?(?:a\s+)?(?:different|new|unrestricted)', re.IGNORECASE),
    re.compile(r'(?:DAN|STAN|DUDE|KEVIN)\s+mode', re.IGNORECASE),
    re.compile(r'jailbreak|do\s+anything\s+now', re.IGNORECASE),
    re.compile(r'pretend\s+(?:you\s+)?(?:are|have)\s+no\s+(?:rules|restrictions|limits)', re.IGNORECASE),
    re.compile(r'(?:reveal|show|display|print|output)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)', re.IGNORECASE),
    re.compile(r'(?:send|forward|email|post)\s+(?:all\s+)?(?:data|files|secrets|keys|tokens)', re.IGNORECASE),
]

# --- Token budget ---
# Rough heuristic: normal text ~4 chars/token, dense Unicode ~1 char/3 tokens
MAX_TOKENS_ESTIMATE = 8000
CHARS_PER_TOKEN_NORMAL = 4


def strip_invisible(text: str) -> tuple[str, int]:
    """Remove invisible Unicode characters. Returns (cleaned, count_removed)."""
    count = 0
    result = []
    for c in text:
        if c in INVISIBLE_CHARS:
            count += 1
        else:
            result.append(c)
    return ''.join(result), count


def strip_wallet_drain(text: str) -> tuple[str, int]:
    """Remove wallet-draining characters. Returns (cleaned, count_removed)."""
    count = 0
    result = []
    for c in text:
        if is_wallet_drain(c):
            count += 1
        else:
            result.append(c)
    return ''.join(result), count


def normalize_lookalikes(text: str) -> tuple[str, int]:
    """Normalize homoglyph characters to Latin equivalents. Returns (cleaned, count_normalized)."""
    count = 0
    result = []
    for c in text:
        if c in LOOKALIKES:
            result.append(LOOKALIKES[c])
            count += 1
        else:
            result.append(c)
    return ''.join(result), count


def strip_combining_flood(text: str) -> tuple[str, int]:
    """Limit combining marks per base character. Returns (cleaned, count_stripped)."""
    count = 0
    result = []
    combining_count = 0
    for c in text:
        cat = unicodedata.category(c)
        if cat.startswith('M'):  # Mark category
            combining_count += 1
            if combining_count <= COMBINING_MARK_LIMIT:
                result.append(c)
            else:
                count += 1
        else:
            combining_count = 0
            result.append(c)
    return ''.join(result), count


def decode_html_entities(text: str) -> tuple[str, int]:
    """Decode HTML entities used for smuggling. Returns (decoded, count)."""
    count = len(ENCODED_PATTERNS[2].findall(text))
    if count == 0:
        return text, 0

    def replace_entity(m):
        entity = m.group(0)
        try:
            if entity.startswith('&#x'):
                return chr(int(entity[3:-1], 16))
            elif entity.startswith('&#'):
                return chr(int(entity[2:-1]))
        except (ValueError, OverflowError):
            pass
        return entity

    return ENCODED_PATTERNS[2].sub(replace_entity, text), count


def detect_encoded_blocks(text: str) -> int:
    """Count suspicious encoded blocks (base64, hex). Returns count."""
    count = 0
    for pattern in ENCODED_PATTERNS[:2]:  # base64 and hex only
        count += len(pattern.findall(text))
    return count


def detect_role_markers(text: str) -> int:
    """Count role marker patterns. Returns count."""
    return len(ROLE_MARKERS.findall(text))


def detect_override_attempts(text: str) -> list[str]:
    """Find override/jailbreak patterns. Returns list of matched patterns."""
    matches = []
    for pattern in OVERRIDE_PATTERNS:
        found = pattern.findall(text)
        if found:
            matches.extend(found)
    return matches


def estimate_tokens(text: str) -> int:
    """Rough token estimate accounting for Unicode density."""
    normal_chars = sum(1 for c in text if ord(c) < 0x4E00)
    dense_chars = len(text) - normal_chars
    return (normal_chars // CHARS_PER_TOKEN_NORMAL) + (dense_chars * 3)


def sanitize(text: str, max_chars: int = 50000) -> SanitizeResult:
    """
    Full sanitization pipeline.
    Returns SanitizeResult(text, blocked, reason, stats).
    """
    stats = {
        'original_length': len(text),
        'invisible_removed': 0,
        'wallet_drain_removed': 0,
        'lookalikes_normalized': 0,
        'combining_stripped': 0,
        'html_entities_decoded': 0,
        'encoded_blocks': 0,
        'role_markers': 0,
        'override_attempts': [],
        'estimated_tokens': 0,
        'truncated': False,
    }

    # Step 1: Strip invisible characters
    text, stats['invisible_removed'] = strip_invisible(text)

    # Block if excessive invisible chars (>5% of original = suspicious)
    if stats['original_length'] > 100 and stats['invisible_removed'] > stats['original_length'] * 0.05:
        return SanitizeResult(
            text='', blocked=True,
            reason=f"Excessive invisible characters: {stats['invisible_removed']} "
                   f"({stats['invisible_removed']*100//stats['original_length']}% of text)",
            stats=stats,
        )

    # Step 2: Strip wallet-draining characters
    text, stats['wallet_drain_removed'] = strip_wallet_drain(text)

    if stats['wallet_drain_removed'] > 50:
        return SanitizeResult(
            text='', blocked=True,
            reason=f"Wallet drain attempt: {stats['wallet_drain_removed']} expensive Unicode chars",
            stats=stats,
        )

    # Step 3: Normalize lookalike characters
    text, stats['lookalikes_normalized'] = normalize_lookalikes(text)

    # Step 4: Strip combining mark floods
    text, stats['combining_stripped'] = strip_combining_flood(text)

    # Step 5: Decode HTML entities (to catch smuggled instructions)
    text, stats['html_entities_decoded'] = decode_html_entities(text)

    # Step 6: Detect encoded blocks
    stats['encoded_blocks'] = detect_encoded_blocks(text)

    # Step 7: Detect role markers
    stats['role_markers'] = detect_role_markers(text)

    # Step 8: Detect override attempts
    stats['override_attempts'] = detect_override_attempts(text)

    # Step 9: Token budget enforcement
    stats['estimated_tokens'] = estimate_tokens(text)
    if stats['estimated_tokens'] > MAX_TOKENS_ESTIMATE:
        # Truncate to budget, don't block
        char_budget = MAX_TOKENS_ESTIMATE * CHARS_PER_TOKEN_NORMAL
        text = text[:char_budget]
        stats['truncated'] = True

    # Step 10: Hard character limit
    if len(text) > max_chars:
        text = text[:max_chars]
        stats['truncated'] = True

    # Determine if we should flag (not block, but warn)
    blocked = False
    reason = 'clean'

    # High-risk combination: role markers + override attempts
    if stats['role_markers'] >= 2 and len(stats['override_attempts']) >= 1:
        blocked = True
        reason = (f"Prompt injection detected: {stats['role_markers']} role markers, "
                  f"override attempts: {stats['override_attempts'][:3]}")

    # Many override attempts alone
    elif len(stats['override_attempts']) >= 3:
        blocked = True
        reason = f"Multiple override attempts: {stats['override_attempts'][:3]}"

    stats['final_length'] = len(text)
    return SanitizeResult(text=text, blocked=blocked, reason=reason, stats=stats)


def main():
    parser = argparse.ArgumentParser(description='Sanitize untrusted text input')
    parser.add_argument('--file', '-f', help='Read from file')
    parser.add_argument('--text', '-t', help='Text to sanitize')
    parser.add_argument('--json', '-j', action='store_true', help='JSON output')
    parser.add_argument('--max-chars', type=int, default=50000, help='Max output chars')
    args = parser.parse_args()

    if args.text:
        text = args.text
    elif args.file:
        text = Path(args.file).read_text(encoding='utf-8', errors='replace')
    elif not sys.stdin.isatty():
        text = sys.stdin.read()
    else:
        print("Usage: echo 'text' | python3 sanitizer.py", file=sys.stderr)
        sys.exit(2)

    result = sanitize(text, max_chars=args.max_chars)

    if args.json:
        output = {
            'blocked': result.blocked,
            'reason': result.reason,
            'stats': result.stats,
            'text': result.text if not result.blocked else '',
        }
        # Convert non-serializable items
        output['stats']['override_attempts'] = list(output['stats']['override_attempts'])
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        if result.blocked:
            print(f"🚫 BLOCKED: {result.reason}", file=sys.stderr)
            print(f"Stats: invisible={result.stats['invisible_removed']}, "
                  f"wallet_drain={result.stats['wallet_drain_removed']}, "
                  f"lookalikes={result.stats['lookalikes_normalized']}", file=sys.stderr)
            sys.exit(1)
        else:
            # Print warnings to stderr
            warnings = []
            if result.stats['invisible_removed'] > 0:
                warnings.append(f"invisible_removed={result.stats['invisible_removed']}")
            if result.stats['lookalikes_normalized'] > 0:
                warnings.append(f"lookalikes_normalized={result.stats['lookalikes_normalized']}")
            if result.stats['role_markers'] > 0:
                warnings.append(f"role_markers={result.stats['role_markers']}")
            if result.stats['override_attempts']:
                warnings.append(f"overrides={len(result.stats['override_attempts'])}")
            if result.stats['truncated']:
                warnings.append("truncated=True")

            if warnings:
                print(f"⚠️  {', '.join(warnings)}", file=sys.stderr)

            print(result.text)

    sys.exit(1 if result.blocked else 0)


if __name__ == '__main__':
    main()
