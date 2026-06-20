#!/usr/bin/env python3
"""
autograph link_cleanup — remove phantom wikilinks from ## Related sections.

No API calls. Checks every wikilink in ## Related against real vault stems.
Broken links are removed; if all links in a section are broken, the section is deleted.

Usage:
    link_cleanup.py <vault-dir>              # dry run
    link_cleanup.py <vault-dir> --apply
"""

import json
import re
import sys
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import walk_vault, rel_path, extract_wikilinks, build_link_index, resolve_link_target


def build_stems_and_paths(vault_dir: Path) -> dict:
    """Build deterministic link indexes shared with graph.py."""
    return build_link_index(vault_dir)


def check_link_target(target: str, valid_targets: dict) -> bool:
    """Check if a wikilink target resolves to a real file."""
    resolved, reason = resolve_link_target(target, valid_targets)
    if reason == 'empty':
        return True  # empty after strip = self-link, not broken
    return resolved is not None


def cleanup_related_section(content: str, valid_targets: dict) -> tuple[str, list[str], list[str]]:
    """Clean phantom links from ## Related section.

    Returns (new_content, removed_links, kept_links).
    Only touches ## Related section. Body links are never modified.
    """
    # Find ## Related section
    pattern = re.compile(r'(\n## Related\n)(.*?)(?=\n## |\Z)', re.DOTALL)
    match = pattern.search(content)
    if not match:
        return content, [], []

    header = match.group(1)
    section_body = match.group(2)

    removed = []
    kept = []
    new_lines = []

    for line in section_body.split('\n'):
        links = extract_wikilinks(line)
        if not links:
            # Non-link line (empty, comments, etc.) — keep as-is
            new_lines.append(line)
            continue

        # Check each link target in the line
        line_valid = False
        for target, _ in links:
            if check_link_target(target, valid_targets):
                kept.append(target)
                line_valid = True
            else:
                removed.append(target)

        if line_valid:
            new_lines.append(line)

    # If all links removed → delete entire section
    if not kept:
        new_content = content[:match.start()] + content[match.end():]
        return new_content.rstrip() + '\n', removed, kept

    # Rebuild section
    new_section = header + '\n'.join(new_lines)
    new_content = content[:match.start()] + new_section + content[match.end():]
    return new_content, removed, kept


def run_cleanup(vault_dir: Path, apply: bool = False) -> dict:
    """Run link cleanup on vault. Returns report dict."""
    vault_dir = vault_dir.resolve()
    valid_targets = build_stems_and_paths(vault_dir)

    report = {
        'total_files_scanned': 0,
        'files_with_related': 0,
        'files_modified': 0,
        'links_removed': [],
        'links_kept': 0,
        'timestamp': datetime.now().isoformat(),
        'apply': apply,
    }

    for md in walk_vault(vault_dir):
        report['total_files_scanned'] += 1
        content = md.read_text(errors='replace')

        if '## Related' not in content:
            continue

        report['files_with_related'] += 1
        new_content, removed, kept = cleanup_related_section(content, valid_targets)

        report['links_kept'] += len(kept)

        if removed:
            rp = rel_path(md, vault_dir)
            report['links_removed'].append({
                'file': rp,
                'removed': removed,
                'kept': [k for k in kept],
            })
            report['files_modified'] += 1

            if apply:
                md.write_text(new_content)

    # Print summary
    print(f"Scanned: {report['total_files_scanned']} files")
    print(f"With ## Related: {report['files_with_related']}")
    print(f"Files to {'fix' if not apply else 'fixed'}: {report['files_modified']}")
    total_removed = sum(len(r['removed']) for r in report['links_removed'])
    print(f"Links removed: {total_removed}")
    print(f"Links kept: {report['links_kept']}")

    if report['links_removed'] and not apply:
        print("\nPhantom links found (dry run):")
        for item in report['links_removed']:
            print(f"  {item['file']}:")
            for link in item['removed']:
                print(f"    - [[{link}]] (broken)")

    # Write report
    report_dir = vault_dir / '.graph'
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / 'link-cleanup-report.json'
    # Convert for JSON serialization
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(f"\nReport: {report_path}")

    return report


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print("Usage: link_cleanup.py <vault-dir> [--apply]", file=sys.stderr)
        sys.exit(1)

    vault_dir = Path(args[0])
    if not vault_dir.is_dir():
        print(f"Not a directory: {vault_dir}", file=sys.stderr)
        sys.exit(1)

    apply = '--apply' in args
    run_cleanup(vault_dir, apply)


if __name__ == '__main__':
    main()
