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
    minor_issues: list[str]


def _extract_section(text: str, heading: str) -> str:
    # Same tolerance as the convergence gate's section parser: up to three
    # leading spaces and case-insensitive, so the two tools agree on which
    # sections exist.
    pat = re.compile(rf"^\s{{0,3}}##\s+{re.escape(heading)}\s*$", re.MULTILINE | re.IGNORECASE)
    m = pat.search(text)
    if not m:
        return ""
    start = m.end()
    m2 = re.compile(r"^\s{0,3}##\s+", re.MULTILINE).search(text, start)
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
        # Keep list items: bullet marker + whitespace, or numbered entries
        # (a bold line like "**Note:**" is not a bullet).
        if re.match(r"^[-*+]\s", s) or re.match(r"^\d+\.", s):
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
    minor = _extract_section(text, "Minor Issues")
    return Extracted(
        path=path,
        minimal_fix_items=_extract_list_like_lines(minimal_fix),
        novelty_leads=_extract_list_like_lines(novelty),
        major_gaps=_extract_list_like_lines(major),
        minor_issues=_extract_list_like_lines(minor),
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

    lines.append("## 2) Non-blocking findings — every one gets an explicit disposition")
    lines.append("")
    lines.append("A non-blocking finding is never silently dropped: each row below must end")
    lines.append("with exactly one disposition — fix now / attach to a named acceptance")
    lines.append("point / discard with a stated reason. An empty disposition cell means the")
    lines.append("adjudication is not finished.")
    lines.append("")
    lines.append("### 2.1 From Member A — Minor Issues")
    lines.append(_emit_items(member_a.minor_issues).rstrip())
    lines.append("")
    lines.append("### 2.2 From Member B — Minor Issues")
    lines.append(_emit_items(member_b.minor_issues).rstrip())
    lines.append("")
    lines.append("| Finding | Source | Disposition (fix now / acceptance point <name> / discard: <reason>) |")
    lines.append("|---|---|---|")
    lines.append("|  |  |  |")
    lines.append("")

    lines.append("## 3) Disagreements & adjudication (team discussion)")
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

    lines.append("## 4) Novelty leads / kill criteria (suggestions, not commandments)")
    lines.append("")
    lines.append("### 4.1 From Member A — Breakthrough Leads")
    lines.append(_emit_items(member_a.novelty_leads).rstrip())
    lines.append("")
    lines.append("### 4.2 From Member B — Breakthrough Leads")
    lines.append(_emit_items(member_b.novelty_leads).rstrip())
    lines.append("")
    lines.append("For each proposed lead/kill criterion, decide: accept / modify / reject, and update `idea_log.md` accordingly.")
    lines.append("")

    lines.append("## 5) What changed (for the next round)")
    lines.append("")
    lines.append("- Notes changed: (paths)")
    lines.append("- Code changed: (paths)")
    lines.append("- New artifacts/figures: (paths)")
    lines.append("- Self-consistency checks rerun: (commands + outputs)")
    lines.append("")
    lines.append("## 6) Result registration")
    lines.append("")
    lines.append("Milestone convergence is when \"which result is current\" changes, so this")
    lines.append("adjudication declares the traceability updates it made — and the fold gate")
    lines.append("(`scripts/gates/check_convergence_registration.py`) verifies each declared")
    lines.append("fact against the project record. Fill every line; `none` is a legitimate")
    lines.append("answer where stated (the headline `none` requires a reason).")
    lines.append("")
    lines.append("Line formats — `Headline result:` takes `<result-id> @ <run_id>` (the row")
    lines.append("`nullius result set-current` just registered) or `none — <reason>`;")
    lines.append("`Supersedes:` takes `<old_run_id> -> <new_run_id>` (one line per replaced")
    lines.append("run, already recorded via `nullius trace supersede`) or `none`;")
    lines.append("`Rewritten sections:` takes notebook headings separated by `;`, each")
    lines.append("wrapped in double quotes or backticks (use backticks for a heading that")
    lines.append("itself contains a double quote); each rewritten section carries a fresh")
    lines.append("`<!-- written-against: <commit> -->` stamp. Or `none`.")
    lines.append("")
    lines.append("- Headline result: (fill)")
    lines.append("- Supersedes: (fill)")
    lines.append("- Rewritten sections: (fill)")
    lines.append("")

    lines.append("## 7) How to use this file")
    lines.append("")
    lines.append("- Add this file path to the next team packet under 'Adjudication/response note'.")
    lines.append("- In the next round, members must respond to rejected items: either accept the rationale, or show why it is still blocking.")
    lines.append("")

    out.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    print("Wrote:", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
