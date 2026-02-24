#!/usr/bin/env python3
"""One-time migration guard: legacy M5 test-instance files must stay absent."""

from __future__ import annotations

import sys
from pathlib import Path

# These paths were migrated from tool repo -> idea-runs during W5-03.
MIGRATED_PATHS = (
    Path("docs/research/pion-gff-bootstrap/m0.1-preflight.md"),
    Path("docs/research/pion-gff-bootstrap/m0.2-design.md"),
    Path("docs/research/pion-gff-bootstrap/tracker.md"),
    Path("docs/research/pion-gff-bootstrap/sync/2026-02-14-m0.2-board-sync.txt"),
    Path("docs/research/pion-gff-bootstrap/sync/2026-02-14-m0.3-blocked-note.txt"),
)


def main() -> int:
    repo_root = Path.cwd().resolve()
    violations: list[str] = []
    for rel in MIGRATED_PATHS:
        if (repo_root / rel).exists():
            violations.append(rel.as_posix())

    if violations:
        print("ERROR: legacy M5 files were reintroduced into idea-core.", file=sys.stderr)
        print("Keep legacy test-instance files only in idea-runs archive.", file=sys.stderr)
        for rel in violations:
            print(f" - {rel}", file=sys.stderr)
        return 1

    print("OK: legacy M5 migrated paths remain absent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
