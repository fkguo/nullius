#!/usr/bin/env python3
"""Fail-fast if test-instance run trees are mixed into tool repositories.

Boundary policy:
- Forbidden: `research/**`, `docs/research/**`, `projects/**`, `runs/**`, `artifacts/**`, `literature/**`, and local review workflow files/directories
- Allowed: checked-in design/plan SSOT evidence under `docs/plans/**`
"""

from __future__ import annotations

import sys
from pathlib import Path

FORBIDDEN_ROOTS = (
    Path("research"),
    Path("docs/research"),
    # Instance / run trees must live in idea-runs (not in this design repo).
    Path("projects"),
    Path("runs"),
    Path("artifacts"),
    Path("literature"),
    Path("docs/reviews"),
    Path("docs/plans/agent-team-output"),
)

FORBIDDEN_PLAN_GLOBS = (
    "docs/plans/*review*",
    "docs/plans/*packet*",
    "docs/plans/*reviewer*",
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
    repo_root = Path(__file__).resolve().parents[1]
    violations: list[str] = []
    for rel in FORBIDDEN_ROOTS:
        candidate = repo_root / rel
        if _has_any_content(candidate):
            violations.append(rel.as_posix())
    for pattern in FORBIDDEN_PLAN_GLOBS:
        for path in sorted(repo_root.glob(pattern)):
            if path.is_file():
                violations.append(path.relative_to(repo_root).as_posix())

    if violations:
        print("ERROR: test-instance pollution detected in tool repository.", file=sys.stderr)
        print("Move run/research artifacts to idea-runs and keep review workflow files outside the repo.", file=sys.stderr)
        for rel in violations:
            print(f" - {rel}", file=sys.stderr)
        return 1

    print("OK: no test-instance pollution paths detected.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
