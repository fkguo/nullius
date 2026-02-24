#!/usr/bin/env python3
"""
Convention mapping gate for full_access runs.

Triggered when either:
  - config.convention_mapping.required == true, OR
  - the team packet contains an explicit marker like:
      "Cross-paper mapping: yes" / "Cross-paper mapping required: yes"

When triggered, each member evidence must include convention_mappings[] entries with:
  - source_anchors (non-empty list of strings)
  - explicit_relation (non-empty string, include prefactors)
  - sanity_check (non-empty string, e.g. OoM check)

Exit codes:
  0  PASS (or SKIP)
  1  FAIL (missing/invalid mappings)
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
    message: str


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--notes", type=Path, required=True, help="Notebook path (used to locate config).")
    p.add_argument("--packet", type=Path, default=None, help="Team packet path (optional; used for trigger marker).")
    p.add_argument("--member-a", type=Path, required=True, help="Member A evidence JSON path.")
    p.add_argument("--member-b", type=Path, required=True, help="Member B evidence JSON path.")
    p.add_argument("--max-issues", type=int, default=50)
    return p.parse_args()


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8", errors="replace"))


def _triggered(cfg_data: dict, packet_text: str | None) -> bool:
    cm = cfg_data.get("convention_mapping", {}) if isinstance(cfg_data.get("convention_mapping", {}), dict) else {}
    if bool(cm.get("required", False)):
        return True
    if not packet_text:
        return False
    # Explicit marker in packet.
    for pat in (
        r"cross[- ]paper\s+mapping\s*:\s*(?:yes|true|on|required)\b",
        r"cross[- ]paper\s+mapping\s+required\s*:\s*(?:yes|true|on)\b",
    ):
        if re.search(pat, packet_text, flags=re.IGNORECASE):
            return True
    return False


def _validate_member(member: str, ev: dict) -> list[Issue]:
    out: list[Issue] = []
    mappings = ev.get("convention_mappings", [])
    if not isinstance(mappings, list) or len(mappings) == 0:
        return [Issue(member, "missing convention_mappings[] (required for this run)")]
    for i, m in enumerate(mappings):
        if not isinstance(m, dict):
            out.append(Issue(member, f"convention_mappings[{i}] is not an object"))
            continue
        anchors = m.get("source_anchors", [])
        if not isinstance(anchors, list) or not any(isinstance(x, str) and x.strip() for x in anchors):
            out.append(Issue(member, f"convention_mappings[{i}].source_anchors missing/invalid"))
        rel = m.get("explicit_relation")
        if not isinstance(rel, str) or not rel.strip():
            out.append(Issue(member, f"convention_mappings[{i}].explicit_relation missing/invalid"))
        sc = m.get("sanity_check")
        if not isinstance(sc, str) or not sc.strip():
            out.append(Issue(member, f"convention_mappings[{i}].sanity_check missing/invalid"))
    return out


def main() -> int:
    args = _parse_args()
    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}", file=sys.stderr)
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("convention_mapping_gate", default=False):
        print(f"- Notes: `{args.notes}`")
        print("- Gate: SKIP (convention_mapping_gate disabled by config)")
        return 0

    mode = str(getattr(cfg, "data", {}).get("review_access_mode", "packet_only")).strip().lower()
    if mode != "full_access":
        print(f"- Notes: `{args.notes}`")
        print(f"- Review access mode: {mode or 'packet_only'}")
        print("- Gate: SKIP (review_access_mode != full_access)")
        return 0

    if not args.member_a.is_file() or not args.member_b.is_file():
        print("ERROR: missing member evidence file(s)", file=sys.stderr)
        return 2

    cfg_data = getattr(cfg, "data", {})
    if not isinstance(cfg_data, dict):
        cfg_data = {}
    packet_text = None
    if args.packet is not None and args.packet.is_file():
        packet_text = args.packet.read_text(encoding="utf-8", errors="replace")

    if not _triggered(cfg_data, packet_text):
        print(f"- Notes: `{args.notes}`")
        print("- Gate: SKIP (convention mapping not required for this run)")
        return 0

    ev_a = _load(args.member_a)
    ev_b = _load(args.member_b)
    issues: list[Issue] = []
    issues.extend(_validate_member("member_a", ev_a))
    issues.extend(_validate_member("member_b", ev_b))

    print(f"- Notes: `{args.notes}`")
    print(f"- Member A evidence: `{args.member_a}`")
    print(f"- Member B evidence: `{args.member_b}`")
    print(f"- Issues: {len(issues)}")
    if issues:
        for it in issues[: args.max_issues]:
            print(f"ERROR: {it.member}: {it.message}")
        if len(issues) > args.max_issues:
            print(f"... ({len(issues) - args.max_issues} more)")
        print("- Gate: FAIL")
        return 1
    print("- Gate: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

