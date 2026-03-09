#!/usr/bin/env python3
"""Fail if checked-in demo snapshots contain machine-local absolute paths."""

from __future__ import annotations

import re
import sys
from pathlib import Path

DEMO_ROOT = Path("docs/demos")
FORBIDDEN_PATTERNS = (
    re.compile(r"file:///"),
    re.compile(r"/Users/"),
    re.compile(r"/home/"),
    re.compile(r"[A-Za-z]:\\\\Users\\\\"),
    re.compile(r"Nutstore(?:%20| )Files"),
)


def main() -> int:
    repo_root = Path.cwd().resolve()
    demo_root = repo_root / DEMO_ROOT
    if not demo_root.is_dir():
        print("OK: no checked-in demo snapshots to inspect.")
        return 0

    violations: list[str] = []
    for path in sorted(demo_root.rglob("*.json")):
        text = path.read_text(encoding="utf-8")
        if any(pattern.search(text) for pattern in FORBIDDEN_PATTERNS):
            violations.append(path.relative_to(repo_root).as_posix())

    if violations:
        print("ERROR: checked-in demo snapshots contain machine-local paths.", file=sys.stderr)
        print("Run scripts/sanitize_demo_snapshots.py before committing demo artifacts.", file=sys.stderr)
        for rel_path in violations:
            print(f" - {rel_path}", file=sys.stderr)
        return 1

    print("OK: checked-in demo snapshots are portable.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
