#!/usr/bin/env python3
"""NEW-R02a / CODE-01.1: LOC check — diff-scoped file size gate.

Checks that modified files do not exceed the 200 eLOC (effective lines of code) threshold.
Files with ``# CONTRACT-EXEMPT: CODE-01.1`` are skipped.

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
from pathlib import Path

_EXEMPT_PATTERN = re.compile(r"#\s*CONTRACT-EXEMPT:\s*CODE-01\.1")
_COMMENT_LINE = re.compile(r"^\s*(#|//|/\*|\*)")
_BLANK_LINE = re.compile(r"^\s*$")
_SUNSET_PATTERN = re.compile(r"#\s*CONTRACT-EXEMPT:\s*CODE-01\.1\s*sunset:(\d{4}-\d{2}-\d{2})")


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
    """Check for CONTRACT-EXEMPT annotation."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return False
    return bool(_EXEMPT_PATTERN.search(text))


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
        # Skip non-code files.
        if path.suffix not in {".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"}:
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
