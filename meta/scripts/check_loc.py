#!/usr/bin/env python3
"""NEW-R02a / CODE-01.1: LOC check — diff-scoped file size gate.

Checks that modified handwritten files do not exceed the 200 eLOC threshold.
An exemption must appear in the first five lines and carry an unexpired sunset.

Usage:
    python check_loc.py [--max-eloc 200] [--files FILE ...]
    echo "file1.py\\nfile2.py" | python check_loc.py

Without ``--files``, reads from stdin (one path per line), suitable for:
    git diff --name-only origin/main...HEAD | python meta/scripts/check_loc.py
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

_COMMENT_LINE = re.compile(r"^\s*(#|//|/\*|\*)")
_BLANK_LINE = re.compile(r"^\s*$")
_HASH_EXEMPTION = re.compile(
    r"^\s*#\s+CONTRACT-EXEMPT:\s*CODE-01\.1\s+sunset:(\d{4}-\d{2}-\d{2})\s+\S.*$"
)
_SLASH_EXEMPTION = re.compile(
    r"^\s*//\s+CONTRACT-EXEMPT:\s*CODE-01\.1\s+sunset:(\d{4}-\d{2}-\d{2})\s+\S.*$"
)
_EXEMPTION_PATTERNS = {
    ".py": _HASH_EXEMPTION,
    ".sh": _HASH_EXEMPTION,
    ".ts": _SLASH_EXEMPTION,
    ".tsx": _SLASH_EXEMPTION,
    ".js": _SLASH_EXEMPTION,
    ".jsx": _SLASH_EXEMPTION,
    ".mjs": _SLASH_EXEMPTION,
    ".mts": _SLASH_EXEMPTION,
}
_COMMENT_PREFIXES = {
    suffix: "#" if pattern is _HASH_EXEMPTION else "//"
    for suffix, pattern in _EXEMPTION_PATTERNS.items()
}
_CODE_SUFFIXES = frozenset(_EXEMPTION_PATTERNS)
_REPO_ROOT = Path(__file__).resolve().parents[2]
_GENERATED_ROOTS = (
    _REPO_ROOT / "packages" / "shared" / "src" / "generated",
    _REPO_ROOT / "meta" / "generated" / "python",
)


def effective_loc(path: Path) -> int:
    """Count effective lines of code (non-blank, non-comment)."""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return 0

    count = 0
    for line in lines:
        if _BLANK_LINE.match(line):
            continue
        if _COMMENT_LINE.match(line):
            continue
        count += 1
    return count


def is_exempt(path: Path) -> bool:
    """Accept a complete, language-correct leading comment declaration."""
    suffix = path.suffix.casefold()
    pattern = _EXEMPTION_PATTERNS.get(suffix)
    if pattern is None:
        return False
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return False
    comment_prefix = _COMMENT_PREFIXES[suffix]
    for index, line in enumerate(lines[:5]):
        match = pattern.fullmatch(line)
        if match:
            try:
                return date.fromisoformat(match.group(1)) >= date.today()
            except ValueError:
                return False
        stripped = line.lstrip()
        if not stripped or stripped.startswith(comment_prefix):
            continue
        if index == 0 and line.startswith("#!"):
            continue
        return False
    return False


def is_declared_generated(path: Path) -> bool:
    """Exclude only checked-in outputs of the two declared code generators."""
    resolved = path.resolve()
    return any(resolved == root or root in resolved.parents for root in _GENERATED_ROOTS)


def main() -> int:
    parser = argparse.ArgumentParser(description="CODE-01.1 LOC gate")
    parser.add_argument("--max-eloc", type=int, default=200, help="Max effective LOC per file (default: 200)")
    parser.add_argument("--files", nargs="*", help="Files to check (default: read from stdin)")
    args = parser.parse_args()

    if args.files:
        files = args.files
    else:
        files = [line.strip() for line in sys.stdin if line.strip()]

    violations: list[tuple[str, int]] = []
    for f in files:
        path = Path(f)
        if not path.exists() or not path.is_file():
            continue
        if is_declared_generated(path):
            continue
        # Skip non-code files.
        if path.suffix.casefold() not in _CODE_SUFFIXES:
            continue
        if is_exempt(path):
            continue
        eloc = effective_loc(path)
        if eloc > args.max_eloc:
            violations.append((f, eloc))

    if violations:
        print(f"CODE-01.1 FAIL: {len(violations)} file(s) exceed {args.max_eloc} eLOC:", file=sys.stderr)
        for f, eloc in sorted(violations):
            print(f"  {f}: {eloc} eLOC", file=sys.stderr)
        return 1

    print(f"CODE-01.1 PASS: all checked files within {args.max_eloc} eLOC limit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
