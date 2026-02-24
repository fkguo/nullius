#!/usr/bin/env python3
"""
Check that a team packet has required sections filled (no "(fill)" placeholders).

Exit codes:
  0  PASS (or skipped by config)
  1  FAIL (placeholders or missing required sections)
  2  Input / execution error
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore


@dataclass(frozen=True)
class Issue:
    section: str
    message: str


PLACEHOLDER_RE = re.compile(r"\(\s*(fill|missing)\b", flags=re.IGNORECASE)


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--notes", type=Path, required=True, help="Notebook path (used to locate config).")
    p.add_argument("--packet", type=Path, required=True, help="Team packet path.")
    p.add_argument("--max-issues", type=int, default=50, help="Max issues to print.")
    return p.parse_args()


def _extract_section(text: str, heading: str) -> str:
    pat = re.compile(rf"^##\s+{re.escape(heading)}\s*$", re.MULTILINE)
    m = pat.search(text)
    if not m:
        return ""
    start = m.end()
    m2 = re.compile(r"^##\s+", re.MULTILINE).search(text, start)
    end = m2.start() if m2 else len(text)
    return text[start:end]


def _has_non_placeholder_bullet(section_text: str) -> bool:
    for ln in section_text.splitlines():
        if not re.match(r"^\s*-\s+", ln):
            continue
        low = ln.lower()
        if PLACEHOLDER_RE.search(low):
            continue
        return True
    return False


def main() -> int:
    args = _parse_args()
    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}", file=sys.stderr)
        return 2
    if not args.packet.is_file():
        print(f"ERROR: packet not found: {args.packet}", file=sys.stderr)
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("packet_completeness_gate", default=False):
        print(f"- Notes: `{args.notes}`")
        print(f"- Packet: `{args.packet}`")
        print("- Gate: SKIP (packet_completeness_gate disabled by research_team_config)")
        return 0

    text = args.packet.read_text(encoding="utf-8", errors="replace")
    issues: list[Issue] = []

    required_sections = [
        "2) Definition-hardened quantities (exact operational definitions)",
        "3) Evidence bundle",
    ]

    for heading in required_sections:
        section = _extract_section(text, heading)
        if not section:
            issues.append(Issue(heading, "missing required section"))
            continue
        if PLACEHOLDER_RE.search(section):
            issues.append(Issue(heading, "contains '(fill)' or '(missing ...)' placeholders"))
        if heading.startswith("2)") and not _has_non_placeholder_bullet(section):
            issues.append(Issue(heading, "no filled definition entries found"))
        if heading.startswith("3)") and not _has_non_placeholder_bullet(section):
            issues.append(Issue(heading, "no evidence entries found"))

    print(f"- Notes: `{args.notes}`")
    print(f"- Packet: `{args.packet}`")
    print(f"- Issues: {len(issues)}")
    gate = "PASS" if not issues else "FAIL"
    print(f"- Gate: {gate}")

    shown = 0
    for it in issues:
        if shown >= args.max_issues:
            break
        print(f"ERROR: {it.section}: {it.message}")
        shown += 1
    if len(issues) > shown:
        print(f"... ({len(issues) - shown} more)")

    if issues:
        print("")
        print("Fix: fill required sections in the team packet (or disable packet_completeness_gate).")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
