#!/usr/bin/python3
"""Root-only exact Bitrix secret and journal audit without printing the secret."""

from __future__ import annotations

import os
import pwd
import stat
import subprocess
import sys
from pathlib import Path

SECRET_FILE = Path("/etc/iva-bitrix/bitrix.env")
MAX_FILE_BYTES = 16_000_000
EXCLUDED_DIRS = {".git", "node_modules"}


def emit(category: str, path: Path | None = None, secret_text: str = "") -> None:
    if path is None:
        print(category)
        return
    safe = str(path).replace(secret_text, "<redacted>")
    print(f"{category}: {safe}")


def load_secret() -> tuple[bytes, str]:
    metadata = SECRET_FILE.lstat()
    expected = pwd.getpwnam("iva-bitrix")
    if (
        not stat.S_ISREG(metadata.st_mode)
        or SECRET_FILE.is_symlink()
        or metadata.st_uid != expected.pw_uid
        or metadata.st_gid != expected.pw_gid
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        raise RuntimeError("unsafe-secret-metadata")

    lines = SECRET_FILE.read_bytes().splitlines()
    webhook_lines = [line for line in lines if line.startswith(b"BITRIX_WEBHOOK_URL=")]
    gate_lines = [line for line in lines if line.startswith(b"BITRIX_CHAT_READ_VERIFIED=")]
    allowed = [
        line
        for line in lines
        if line.strip()
        and not line.lstrip().startswith(b"#")
        and not line.startswith(b"BITRIX_WEBHOOK_URL=")
        and not line.startswith(b"BITRIX_CHAT_READ_VERIFIED=")
    ]
    if len(webhook_lines) != 1 or len(gate_lines) > 1 or allowed:
        raise RuntimeError("unsafe-secret-structure")
    if gate_lines and gate_lines[0] not in {
        b"BITRIX_CHAT_READ_VERIFIED=true",
        b"BITRIX_CHAT_READ_VERIFIED=false",
    }:
        raise RuntimeError("unsafe-gate-value")

    secret = webhook_lines[0].split(b"=", 1)[1]
    if not secret.startswith(b"https://") or any(byte <= 32 for byte in secret):
        raise RuntimeError("unsafe-webhook-value")
    return secret, secret.decode("ascii")


def file_contains(path: Path, needle: bytes) -> bool:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            return False
        if before.st_size > MAX_FILE_BYTES:
            raise OverflowError
        overlap = b""
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            data = overlap + chunk
            if needle in data:
                return True
            overlap = data[-max(len(needle) - 1, 0) :]
        after = os.fstat(descriptor)
        if (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ):
            raise RuntimeError("file-changed-during-scan")
        return False
    finally:
        os.close(descriptor)


def scan_roots(roots: list[Path], secret: bytes, secret_text: str) -> tuple[int, int]:
    matches = 0
    blockers = 0
    seen: set[Path] = set()

    for root in roots:
        try:
            resolved = root.resolve(strict=True)
        except OSError:
            emit("scan-blocker:missing-root", root, secret_text)
            blockers += 1
            continue
        if not root.is_absolute() or resolved != root or not root.is_dir():
            emit("scan-blocker:unsafe-root", root, secret_text)
            blockers += 1
            continue
        if resolved in seen:
            continue
        seen.add(resolved)

        def onerror(error: OSError) -> None:
            nonlocal blockers
            emit("scan-blocker:walk-error", Path(error.filename or resolved), secret_text)
            blockers += 1

        for directory, dirnames, filenames in os.walk(resolved, topdown=True, followlinks=False, onerror=onerror):
            base = Path(directory)
            dirnames[:] = [
                name
                for name in dirnames
                if name not in EXCLUDED_DIRS and not (base / name).is_symlink()
            ]
            for name in filenames:
                path = base / name
                try:
                    metadata = path.lstat()
                    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                        continue
                    if metadata.st_size > MAX_FILE_BYTES:
                        emit("scan-blocker:large-file", path, secret_text)
                        blockers += 1
                    elif file_contains(path, secret):
                        emit("exact-secret-match", path, secret_text)
                        matches += 1
                except (OSError, RuntimeError):
                    emit("scan-blocker:read-error", path, secret_text)
                    blockers += 1
                except OverflowError:
                    emit("scan-blocker:large-file", path, secret_text)
                    blockers += 1
    return matches, blockers


def main() -> int:
    if not hasattr(os, "geteuid") or os.geteuid() != 0 or len(sys.argv) < 2:
        print("usage-error", file=sys.stderr)
        return 3

    try:
        secret, secret_text = load_secret()
    except Exception:
        print("scan-blocker:protected-env", file=sys.stderr)
        return 3

    roots = [Path(argument) for argument in sys.argv[1:]]
    matches, blockers = scan_roots(roots, secret, secret_text)

    try:
        journal = subprocess.run(
            ["/usr/bin/journalctl", "-u", "iva-bitrix-gateway.service", "--no-pager"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError:
        print("scan-blocker:gateway-journal")
        blockers += 1
    else:
        if journal.returncode != 0:
            print("scan-blocker:gateway-journal")
            blockers += 1
        elif secret in journal.stdout or secret in journal.stderr:
            print("exact-secret-match:gateway-journal")
            matches += 1
        else:
            print("exact-secret-clear:gateway-journal")

    print("secret-category-present:root-env")
    if matches:
        return 2
    if blockers:
        return 3
    print("exact-secret-clear:repo-vault-data")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
