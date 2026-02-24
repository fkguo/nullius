#!/usr/bin/env python3
"""
Evidence schema gate for full_access team-cycle runs.

Validates per-member evidence JSON files produced under team/runs/<tag>/:
  - member_a_evidence.json
  - member_b_evidence.json

Exit codes:
  0  PASS (or SKIP)
  1  FAIL (schema errors)
  2  Input / execution error
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from member_evidence import EvidenceIssue, validate_member_evidence_schema  # type: ignore
from team_config import load_team_config  # type: ignore


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--notes", type=Path, required=True, help="Notebook path (used to locate config).")
    p.add_argument("--member-a", type=Path, required=True, help="Member A evidence JSON path.")
    p.add_argument("--member-b", type=Path, required=True, help="Member B evidence JSON path.")
    p.add_argument("--max-issues", type=int, default=80, help="Max issues to print per file.")
    return p.parse_args()


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8", errors="replace"))


def _print_issues(label: str, path: Path, issues: list[EvidenceIssue], max_issues: int) -> int:
    errors = [x for x in issues if x.level == "ERROR"]
    warns = [x for x in issues if x.level == "WARN"]
    print(f"- {label}: `{path}`")
    print(f"  - Issues: errors={len(errors)}, warnings={len(warns)}")
    shown = 0
    for it in issues:
        if shown >= max_issues:
            break
        print(f"  {it.level}: {it.message}")
        shown += 1
    if len(issues) > shown:
        print(f"  ... ({len(issues) - shown} more)")
    return 1 if errors else 0


def main() -> int:
    args = _parse_args()
    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}", file=sys.stderr)
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("evidence_schema_gate", default=False):
        print(f"- Notes: `{args.notes}`")
        print("- Gate: SKIP (evidence_schema_gate disabled by config)")
        return 0

    mode = str(getattr(cfg, "data", {}).get("review_access_mode", "packet_only")).strip().lower()
    if mode != "full_access":
        print(f"- Notes: `{args.notes}`")
        print(f"- Review access mode: {mode or 'packet_only'}")
        print("- Gate: SKIP (review_access_mode != full_access)")
        return 0

    for p in (args.member_a, args.member_b):
        if not p.is_file():
            print(f"ERROR: evidence not found: {p}", file=sys.stderr)
            return 2

    obj_a = _load_json(args.member_a)
    obj_b = _load_json(args.member_b)
    issues_a = validate_member_evidence_schema(obj_a)
    issues_b = validate_member_evidence_schema(obj_b)

    print(f"- Notes: `{args.notes}`")
    failed = 0
    failed += _print_issues("Member A evidence", args.member_a, issues_a, args.max_issues)
    failed += _print_issues("Member B evidence", args.member_b, issues_b, args.max_issues)

    if failed:
        print("- Gate: FAIL")
        return 1
    print("- Gate: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

