#!/usr/bin/env python3
"""Fail-fast if test-instance run trees are mixed into tool repositories.

Boundary policy:
- Forbidden: `research/**`, `docs/research/**`, `artifacts/runs/**`
- Allowed: design/plan/review SSOT evidence under `docs/plans/**` and `docs/reviews/**`
"""

from __future__ import annotations

import sys
from pathlib import Path

FORBIDDEN_ROOTS = (
    Path("research"),
    Path("docs/research"),
    Path("artifacts/runs"),
)


def _has_any_content(path: Path) -> bool:
    if path.is_symlink():
        return True
    if path.is_file():
        return True
    if path.is_dir():
        for _ in path.rglob("*"):
            return True
    return False


def main() -> int:
    repo_root = Path.cwd().resolve()
    violations: list[str] = []
    for rel in FORBIDDEN_ROOTS:
        candidate = repo_root / rel
        if _has_any_content(candidate):
            violations.append(rel.as_posix())

    if violations:
        print("ERROR: test-instance pollution detected in tool repository.", file=sys.stderr)
        print("Move run/research artifacts to idea-runs.", file=sys.stderr)
        for rel in violations:
            print(f" - {rel}", file=sys.stderr)
        return 1

    print("OK: no test-instance pollution paths detected.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
