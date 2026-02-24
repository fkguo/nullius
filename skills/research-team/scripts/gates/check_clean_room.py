#!/usr/bin/env python3
"""
Clean-room evidence gate for full_access team-cycle runs.

Best-effort: detects evidence indicating cross-member leakage, such as:
  - Member A reading member_b outputs/evidence (or vice versa)
  - Commands referencing the other member's workspace paths

Exit codes:
  0  PASS (or SKIP)
  1  FAIL (violations detected)
  2  Input / execution error
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore


@dataclass(frozen=True)
class Issue:
    member: str
    field: str
    message: str


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--notes", type=Path, required=True, help="Notebook path (used to locate config).")
    p.add_argument("--member-a", type=Path, required=True, help="Member A evidence JSON path.")
    p.add_argument("--member-b", type=Path, required=True, help="Member B evidence JSON path.")
    p.add_argument("--safe-tag", default="", help="Safe tag used in team/runs/<tag> (optional; improves checks).")
    p.add_argument("--max-issues", type=int, default=50)
    return p.parse_args()


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8", errors="replace"))


def _as_list(d: dict, key: str) -> list:
    v = d.get(key, [])
    return v if isinstance(v, list) else []


def _forbidden_patterns(member: str, safe_tag: str) -> list[re.Pattern[str]]:
    other = "member_b" if member == "member_a" else "member_a"
    base = []
    if safe_tag:
        base.extend(
            [
                rf"team/runs/{re.escape(safe_tag)}/{re.escape(other)}(?:/|$)",
                rf"team/runs/{re.escape(safe_tag)}/{re.escape(other)}_evidence\.json$",
                rf"artifacts/{re.escape(safe_tag)}/{re.escape(other)}(?:/|$)",
            ]
        )
    else:
        base.extend([rf"/{re.escape(other)}/", rf"{re.escape(other)}_evidence\.json", rf"artifacts/.+/{re.escape(other)}/"])
    return [re.compile(x) for x in base]


def _scan_member(member: str, ev: dict, safe_tag: str) -> list[Issue]:
    issues: list[Issue] = []
    pats = _forbidden_patterns(member, safe_tag)

    def bad(s: str) -> bool:
        return any(p.search(s.replace("\\", "/")) for p in pats)

    # files_read path
    for i, it in enumerate(_as_list(ev, "files_read")):
        if not isinstance(it, dict):
            continue
        p = str(it.get("path", "")).strip()
        if p and bad(p):
            issues.append(Issue(member, f"files_read[{i}].path", f"forbidden cross-member path: {p!r}"))

    # commands_run command/cwd/output_path (string heuristic)
    for i, it in enumerate(_as_list(ev, "commands_run")):
        if not isinstance(it, dict):
            continue
        cmd = str(it.get("command", "")).strip()
        cwd = str(it.get("cwd", "")).strip()
        outp = str(it.get("output_path", "")).strip()
        if cmd and bad(cmd):
            issues.append(Issue(member, f"commands_run[{i}].command", "command references other member paths"))
        if cwd and bad(cwd):
            issues.append(Issue(member, f"commands_run[{i}].cwd", "cwd references other member paths"))
        if outp and bad(outp):
            issues.append(Issue(member, f"commands_run[{i}].output_path", "output_path references other member paths"))

    # outputs_produced path
    for i, it in enumerate(_as_list(ev, "outputs_produced")):
        if not isinstance(it, dict):
            continue
        p = str(it.get("path", "")).strip()
        if p and bad(p):
            issues.append(Issue(member, f"outputs_produced[{i}].path", f"forbidden cross-member output path: {p!r}"))

    return issues


def main() -> int:
    args = _parse_args()
    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}", file=sys.stderr)
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("clean_room_gate", default=False):
        print(f"- Notes: `{args.notes}`")
        print("- Gate: SKIP (clean_room_gate disabled by config)")
        return 0

    mode = str(getattr(cfg, "data", {}).get("review_access_mode", "packet_only")).strip().lower()
    if mode != "full_access":
        print(f"- Notes: `{args.notes}`")
        print(f"- Review access mode: {mode or 'packet_only'}")
        print("- Gate: SKIP (review_access_mode != full_access)")
        return 0

    if not args.member_a.is_file() or not args.member_b.is_file():
        print("ERROR: missing member evidence file(s)", file=sys.stderr)
        print(f"  member_a: {args.member_a}", file=sys.stderr)
        print(f"  member_b: {args.member_b}", file=sys.stderr)
        return 2

    ev_a = _load(args.member_a)
    ev_b = _load(args.member_b)

    issues = []
    issues.extend(_scan_member("member_a", ev_a, args.safe_tag))
    issues.extend(_scan_member("member_b", ev_b, args.safe_tag))

    print(f"- Notes: `{args.notes}`")
    print(f"- Member A evidence: `{args.member_a}`")
    print(f"- Member B evidence: `{args.member_b}`")
    print(f"- Issues: {len(issues)}")
    if issues:
        for it in issues[: args.max_issues]:
            print(f"ERROR: {it.member} {it.field}: {it.message}")
        if len(issues) > args.max_issues:
            print(f"... ({len(issues) - args.max_issues} more)")
        print("- Gate: FAIL")
        return 1
    print("- Gate: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

