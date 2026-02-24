#!/usr/bin/env python3
"""
Summarize two team member reports (Member A + Member B) for fast iteration.

This script extracts:
- Major Gaps
- Minimal Fix List
- Verdict
- (optional) Novelty & Breakthrough Leads

It is deterministic and relies on the enforced section headings in the reviewer contract.
"""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Extracted:
    path: Path
    verdict: str
    major_gaps: str
    minimal_fix_list: str
    novelty: str


def _extract_section(text: str, heading: str) -> str:
    pat = re.compile(rf"^##\s+{re.escape(heading)}\s*$", re.MULTILINE)
    m = pat.search(text)
    if not m:
        return ""
    start = m.end()
    m2 = re.compile(r"^##\s+", re.MULTILINE).search(text, start)
    end = m2.start() if m2 else len(text)
    return text[start:end].strip()


def _extract_verdict(text: str) -> str:
    sec = _extract_section(text, "Verdict")
    if not sec:
        return ""
    # Keep it compact: first 10 lines max.
    lines = [ln.rstrip() for ln in sec.splitlines() if ln.strip()]
    return "\n".join(lines[:10]).strip()


def _extract_list(text: str, heading: str) -> str:
    sec = _extract_section(text, heading)
    if not sec:
        return ""
    # Keep only bullet/list-like lines for brevity.
    lines: list[str] = []
    for ln in sec.splitlines():
        if ln.strip().startswith(("-", "1.", "2.", "3.", "4.", "5.")):
            lines.append(ln.rstrip())
    return "\n".join(lines).strip() if lines else sec.strip()


def _parse(path: Path) -> Extracted:
    text = path.read_text(encoding="utf-8", errors="replace")
    return Extracted(
        path=path,
        verdict=_extract_verdict(text),
        major_gaps=_extract_list(text, "Major Gaps"),
        minimal_fix_list=_extract_list(text, "Minimal Fix List"),
        novelty=_extract_section(text, "Novelty & Breakthrough Leads"),
    )


def _print_block(title: str, content: str) -> None:
    print(title)
    if content.strip():
        print(content)
    else:
        print("(none)")
    print()


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--member-a", type=Path, required=True)
    p.add_argument("--member-b", type=Path, required=True)
    args = p.parse_args()

    for path in (args.member_a, args.member_b):
        if not path.is_file():
            raise SystemExit(f"ERROR: not found: {path}")

    member_a = _parse(args.member_a)
    member_b = _parse(args.member_b)

    print("=== Team Summary (for iteration) ===")
    print()

    print(f"[Member A] {member_a.path}")
    _print_block("Verdict:", member_a.verdict)
    _print_block("Major Gaps:", member_a.major_gaps)
    _print_block("Minimal Fix List:", member_a.minimal_fix_list)
    _print_block("Novelty & Breakthrough Leads:", member_a.novelty)

    print(f"[Member B] {member_b.path}")
    _print_block("Verdict:", member_b.verdict)
    _print_block("Major Gaps:", member_b.major_gaps)
    _print_block("Minimal Fix List:", member_b.minimal_fix_list)
    _print_block("Novelty & Breakthrough Leads:", member_b.novelty)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
