#!/usr/bin/env python3
"""
Build an "adjudication + leader response" template from two team-member reports.

Motivation:
- Reviewer suggestions (especially kill criteria / novelty leads) are inputs, not commandments.
- When there is disagreement, the team should explicitly adjudicate: accept/modify/reject with rationale.
- The next round should see the adjudication note so members can converge.

This script is deterministic and purely text-based; it does not call any LLMs.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Extracted:
    path: Path
    minimal_fix_items: list[str]
    novelty_leads: list[str]
    major_gaps: list[str]


def _extract_section(text: str, heading: str) -> str:
    pat = re.compile(rf"^##\s+{re.escape(heading)}\s*$", re.MULTILINE)
    m = pat.search(text)
    if not m:
        return ""
    start = m.end()
    m2 = re.compile(r"^##\s+", re.MULTILINE).search(text, start)
    end = m2.start() if m2 else len(text)
    return text[start:end].strip()


def _extract_list_like_lines(section: str) -> list[str]:
    if not section.strip():
        return []
    items: list[str] = []
    for ln in section.splitlines():
        s = ln.strip()
        if not s:
            continue
        # Keep bullets and numbered list entries.
        if s.startswith("-") or re.match(r"^\d+\.", s):
            items.append(ln.rstrip())
    # If we didn't detect list lines, fall back to the first few non-empty lines.
    if not items:
        lines = [ln.rstrip() for ln in section.splitlines() if ln.strip()]
        return lines[:12]
    return items


def _parse_report(path: Path) -> Extracted:
    text = path.read_text(encoding="utf-8", errors="replace")
    minimal_fix = _extract_section(text, "Minimal Fix List")
    novelty = _extract_section(text, "Novelty & Breakthrough Leads")
    major = _extract_section(text, "Major Gaps")
    return Extracted(
        path=path,
        minimal_fix_items=_extract_list_like_lines(minimal_fix),
        novelty_leads=_extract_list_like_lines(novelty),
        major_gaps=_extract_list_like_lines(major),
    )


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tag", required=True, help="Round tag (e.g. M2-r1).")
    p.add_argument("--member-a", type=Path, required=True, help="Member A report path.")
    p.add_argument("--member-b", type=Path, required=True, help="Member B report path.")
    p.add_argument("--out", type=Path, required=True, help="Output adjudication template path.")
    args = p.parse_args()

    for path in (args.member_a, args.member_b):
        if not path.is_file():
            raise SystemExit(f"ERROR: not found: {path}")

    member_a = _parse_report(args.member_a)
    member_b = _parse_report(args.member_b)

    now = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    out = args.out
    out.parent.mkdir(parents=True, exist_ok=True)

    def _emit_items(items: list[str]) -> str:
        if not items:
            return "- (none)\n"
        return "\n".join([f"- {ln.lstrip('-').strip()}" for ln in items]) + "\n"

    lines: list[str] = []
    lines.append(f"# Team Adjudication & Leader Response — {args.tag}")
    lines.append("")
    lines.append(f"Created: {now}")
    lines.append("")
    lines.append("Purpose:")
    lines.append("- Convert reviewer feedback into explicit decisions: accept / modify / reject (with rationale).")
    lines.append("- Treat novelty leads / kill criteria as suggestions unless they are logically required for correctness.")
    lines.append("- Provide a compact artifact to include in the next team packet so the team can converge.")
    lines.append("")
    lines.append("Decision rule:")
    lines.append("- For any reject/modify, you must cite evidence (derivation step, code pointer, artifact/figure, or a scope/matching statement).")
    lines.append("- If an item is genuinely blocking correctness, mark it BLOCKER and fix it.")
    lines.append("")

    lines.append("## 1) Blocking correctness issues (must resolve before advancing)")
    lines.append("")
    lines.append("### 1.1 From Member A — Minimal Fix List")
    lines.append(_emit_items(member_a.minimal_fix_items).rstrip())
    lines.append("")
    lines.append("### 1.2 From Member B — Minimal Fix List")
    lines.append(_emit_items(member_b.minimal_fix_items).rstrip())
    lines.append("")
    lines.append("For each BLOCKER above, fill this table:")
    lines.append("")
    lines.append("| Item | Source | Type (FACT/JUDGMENT/IDEA) | Decision (accept/modify/reject) | Rationale + evidence pointer | Action + owner |")
    lines.append("|---|---|---|---|---|---|")
    lines.append("|  |  |  |  |  |  |")
    lines.append("")

    lines.append("## 2) Disagreements & adjudication (team discussion)")
    lines.append("")
    lines.append("- List the specific disputed items (including any proposed kill criteria you reject), and write a short adjudication note.")
    lines.append("- If needed, propose a compromise: tighten scope, add a discriminant diagnostic, or revise the kill criterion.")
    lines.append("")
    lines.append("Disputed items:")
    lines.append("- (fill)")
    lines.append("")
    lines.append("Adjudication note (what we decided and why):")
    lines.append("- (fill)")
    lines.append("")

    lines.append("## 3) Novelty leads / kill criteria (suggestions, not commandments)")
    lines.append("")
    lines.append("### 3.1 From Member A — Breakthrough Leads")
    lines.append(_emit_items(member_a.novelty_leads).rstrip())
    lines.append("")
    lines.append("### 3.2 From Member B — Breakthrough Leads")
    lines.append(_emit_items(member_b.novelty_leads).rstrip())
    lines.append("")
    lines.append("For each proposed lead/kill criterion, decide: accept / modify / reject, and update `idea_log.md` accordingly.")
    lines.append("")

    lines.append("## 4) What changed (for the next round)")
    lines.append("")
    lines.append("- Notes changed: (paths)")
    lines.append("- Code changed: (paths)")
    lines.append("- New artifacts/figures: (paths)")
    lines.append("- Self-consistency checks rerun: (commands + outputs)")
    lines.append("")
    lines.append("## 5) How to use this file")
    lines.append("")
    lines.append("- Add this file path to the next team packet under 'Adjudication/response note'.")
    lines.append("- In the next round, members must respond to rejected items: either accept the rationale, or show why it is still blocking.")
    lines.append("")

    out.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    print("Wrote:", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
