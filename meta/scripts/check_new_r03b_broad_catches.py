#!/usr/bin/env python3
"""NEW-R03b Batch A: file-scoped broad-catch gate for active Python boundaries."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


_TARGET_FILES = (
    Path("packages/hep-autoresearch/src/hep_autoresearch/toolkit/mcp_stdio_client.py"),
    Path("packages/hep-autoresearch/src/hep_autoresearch/toolkit/evals.py"),
    Path("packages/hep-autoresearch/src/hep_autoresearch/toolkit/retry.py"),
    Path("packages/hep-autoresearch/src/hep_autoresearch/toolkit/run_card.py"),
    Path("packages/idea-core/src/idea_core/rpc/server.py"),
    Path("packages/idea-core/src/idea_core/hepar/retry_ops.py"),
    Path("packages/idea-core/src/idea_core/hepar/orchestrator.py"),
)
# This gate intentionally matches the standard broad-catch forms used in this repo:
# `except Exception:` and `except Exception as exc:`.
_BROAD_CATCH = re.compile(r"^\s*except\s+Exception(?:\s+as\s+\w+)?\s*:")


def _iter_files(files: list[str] | None) -> list[Path]:
    if files:
        return [Path(item) for item in files]
    return list(_TARGET_FILES)


def main() -> int:
    parser = argparse.ArgumentParser(description="Check NEW-R03b target files for unexplained broad catches")
    parser.add_argument("--files", nargs="*", help="Override the default NEW-R03b Batch A target files")
    args = parser.parse_args()

    missing = [path for path in _iter_files(args.files) if not path.exists()]
    if missing:
        for path in missing:
            print(f"MISSING: {path}", file=sys.stderr)
        return 1

    violations: list[str] = []
    for path in _iter_files(args.files):
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if not _BROAD_CATCH.match(line):
                continue
            if "CONTRACT-EXEMPT" in line:
                continue
            violations.append(f"{path}:{lineno}: broad catch without CONTRACT-EXEMPT")

    if violations:
        print("NEW-R03b broad-catch gate FAIL:", file=sys.stderr)
        for violation in violations:
            print(f"  {violation}", file=sys.stderr)
        return 1

    print("NEW-R03b broad-catch gate PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
