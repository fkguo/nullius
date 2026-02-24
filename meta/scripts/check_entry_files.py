#!/usr/bin/env python3
"""NEW-R02a / CODE-01.2: Prohibited filename check.

Checks that new/modified files don't use prohibited "god-file" names:
- utils.py / utils.ts
- helpers.py / helpers.ts
- common.py / common.ts
- service.py / service.ts (single, not services.py)
- misc.py / misc.ts

Usage:
    python check_entry_files.py [--files FILE ...]
    git diff --name-only origin/main...HEAD | python meta/scripts/check_entry_files.py
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Prohibited base names (without extension).
_PROHIBITED_NAMES = frozenset({
    "utils",
    "helpers",
    "common",
    "service",
    "misc",
})

# Code file extensions to check.
_CODE_EXTENSIONS = frozenset({
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts",
})

_EXEMPT_PATTERN = re.compile(r"#\s*CONTRACT-EXEMPT:\s*CODE-01\.2")


def is_exempt(path: Path) -> bool:
    """Check for CONTRACT-EXEMPT annotation in first 5 lines."""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[:5]
    except Exception:
        return False
    return any(_EXEMPT_PATTERN.search(line) for line in lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="CODE-01.2 prohibited filename gate")
    parser.add_argument("--files", nargs="*", help="Files to check (default: read from stdin)")
    args = parser.parse_args()

    if args.files:
        files = args.files
    else:
        files = [line.strip() for line in sys.stdin if line.strip()]

    violations: list[str] = []
    for f in files:
        path = Path(f)
        if path.suffix not in _CODE_EXTENSIONS:
            continue
        stem = path.stem.lower()
        if stem in _PROHIBITED_NAMES:
            if path.exists() and is_exempt(path):
                continue
            violations.append(f)

    if violations:
        print(f"CODE-01.2 FAIL: {len(violations)} file(s) use prohibited names:", file=sys.stderr)
        for f in sorted(violations):
            print(f"  {f}", file=sys.stderr)
        print(
            "\nRename to a more descriptive name, or add "
            "'# CONTRACT-EXEMPT: CODE-01.2' in the first 5 lines.",
            file=sys.stderr,
        )
        return 1

    print("CODE-01.2 PASS: no prohibited filenames found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
