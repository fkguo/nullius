#!/usr/bin/env python3
"""Phase 0 — Method Landscape compiler.

Takes two Phase 0 outputs (one per member), applies the Information Membrane
to each, then merges into a structured ``method_landscape.md``.

Usage:
    python compile_method_landscape.py \
        --member-a method_a.md \
        --member-b method_b.md \
        --output method_landscape.md \
        [--audit-dir <run_dir>/membrane_audit]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Make lib importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from information_membrane import (
    FilterResult,
    build_audit_record,
    filter_message,
    write_audit_log,
)


# ---------------------------------------------------------------------------
# Section extraction helpers
# ---------------------------------------------------------------------------

def _extract_section(text: str, heading: str) -> str:
    """Extract content under a ## heading (up to next ## or end)."""
    import re
    pattern = re.compile(
        rf"^##\s+{re.escape(heading)}\b.*?\n(.*?)(?=^##\s|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(text)
    return m.group(1).strip() if m else ""


_KNOWN_SECTIONS = [
    "Suggested Method Path",
    "Convention Choices",
    "Expected Difficulties",
    "Tool Preferences",
    "Relevant Literature",
]


def _compile_section(heading: str, text_a: str, text_b: str) -> str:
    """Merge a single section from both members."""
    lines: list[str] = [f"### {heading}\n"]
    if text_a:
        lines.append(f"**Member A**:\n{text_a}\n")
    if text_b:
        lines.append(f"**Member B**:\n{text_b}\n")
    if not text_a and not text_b:
        lines.append("*(No input from either member for this section.)*\n")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main compiler
# ---------------------------------------------------------------------------

def compile_landscape(
    member_a_text: str,
    member_b_text: str,
    *,
    audit_dir: Path | None = None,
) -> tuple[str, FilterResult, FilterResult]:
    """Compile two Phase 0 outputs into a method_landscape.md.

    Returns (landscape_md, filter_result_a, filter_result_b).
    """
    # Apply Information Membrane to each member's output
    fr_a = filter_message(member_a_text)
    fr_b = filter_message(member_b_text)

    # Write audit logs if requested
    if audit_dir is not None:
        rec_a = build_audit_record(
            filter_result=fr_a,
            input_text=member_a_text,
            phase="phase_0",
            source_member="A",
            target_member="landscape",
        )
        write_audit_log(rec_a, audit_dir)
        rec_b = build_audit_record(
            filter_result=fr_b,
            input_text=member_b_text,
            phase="phase_0",
            source_member="B",
            target_member="landscape",
        )
        write_audit_log(rec_b, audit_dir)

    # Extract sections from filtered text
    filtered_a = fr_a.passed_text
    filtered_b = fr_b.passed_text

    parts: list[str] = [
        "## Method Landscape (from Phase 0 Alignment)\n",
        "> This section contains method suggestions from both team members.",
        "> It is provided to help you choose an approach, NOT to constrain your derivation.",
        "> You MUST still derive all results independently.\n",
    ]

    for heading in _KNOWN_SECTIONS:
        sec_a = _extract_section(filtered_a, heading)
        sec_b = _extract_section(filtered_b, heading)
        parts.append(_compile_section(heading, sec_a, sec_b))

    # Membrane summary
    a_blocked = fr_a.blocked_count
    b_blocked = fr_b.blocked_count
    if a_blocked > 0 or b_blocked > 0:
        parts.append(
            f"\n---\n*Information Membrane filtered {a_blocked} segment(s) "
            f"from Member A and {b_blocked} segment(s) from Member B "
            f"(results/verdicts/derivations removed for independence protection).*\n"
        )

    return "\n".join(parts), fr_a, fr_b


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compile Phase 0 Method Landscape")
    parser.add_argument("--member-a", required=True, type=Path, help="Member A Phase 0 output")
    parser.add_argument("--member-b", required=True, type=Path, help="Member B Phase 0 output")
    parser.add_argument("--output", required=True, type=Path, help="Output method_landscape.md")
    parser.add_argument("--audit-dir", type=Path, default=None, help="Membrane audit log directory")
    args = parser.parse_args(argv)

    if not args.member_a.is_file():
        print(f"ERROR: Member A file not found: {args.member_a}", file=sys.stderr)
        return 1
    if not args.member_b.is_file():
        print(f"ERROR: Member B file not found: {args.member_b}", file=sys.stderr)
        return 1

    text_a = args.member_a.read_text(encoding="utf-8", errors="replace")
    text_b = args.member_b.read_text(encoding="utf-8", errors="replace")

    landscape, fr_a, fr_b = compile_landscape(
        text_a, text_b, audit_dir=args.audit_dir,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(landscape, encoding="utf-8")

    print(f"Method landscape written to {args.output}")
    print(f"  Member A: {fr_a.total_segments} segments, {fr_a.blocked_count} blocked")
    print(f"  Member B: {fr_b.total_segments} segments, {fr_b.blocked_count} blocked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
