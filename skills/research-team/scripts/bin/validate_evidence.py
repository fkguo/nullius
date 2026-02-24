#!/usr/bin/env python3
"""
Validate a research-team per-member evidence JSON file.

This is a deterministic checker intended for third-party audit:
  python3 validate_evidence.py team/runs/<tag>/member_a_evidence.json

Exit codes:
  0  PASS (no schema errors)
  1  FAIL (schema errors)
  2  Input/execution error
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from member_evidence import EvidenceIssue, validate_member_evidence_schema  # type: ignore


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("paths", nargs="+", type=Path, help="Evidence JSON path(s).")
    p.add_argument("--max-issues", type=int, default=100, help="Max issues to print per file.")
    return p.parse_args()


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8", errors="replace"))


def _print_issues(path: Path, issues: list[EvidenceIssue], max_issues: int) -> None:
    errors = [x for x in issues if x.level == "ERROR"]
    warns = [x for x in issues if x.level == "WARN"]
    print(f"- Evidence: `{path}`")
    print(f"- Issues: errors={len(errors)}, warnings={len(warns)}")
    shown = 0
    for it in issues:
        if shown >= max_issues:
            break
        print(f"{it.level}: {it.message}")
        shown += 1
    if len(issues) > shown:
        print(f"... ({len(issues) - shown} more)")


def main() -> int:
    args = _parse_args()
    overall_errors = 0
    for path in args.paths:
        if not path.is_file():
            print(f"ERROR: evidence not found: {path}", file=sys.stderr)
            return 2
        try:
            obj = _load(path)
        except Exception as e:
            print(f"ERROR: failed to parse JSON: {path}", file=sys.stderr)
            print(f"  {e}", file=sys.stderr)
            return 2

        issues = validate_member_evidence_schema(obj)
        _print_issues(path, issues, args.max_issues)
        if any(x.level == "ERROR" for x in issues):
            overall_errors += 1
        print("")

    if overall_errors:
        print("Gate: FAIL")
        return 1
    print("Gate: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

