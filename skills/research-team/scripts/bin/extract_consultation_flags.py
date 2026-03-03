#!/usr/bin/env python3
"""Phase 2 — Extract consultation flags from Phase 1 reports.

Parses ``<!-- FLAG: ... -->`` markers from member reports and generates
structured HOW-type questions for targeted consultation.

Usage:
    python extract_consultation_flags.py \
        --member-a member_a_report.md \
        --member-b member_b_report.md \
        --output-dir <run_dir>/consultation/
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

# ---------------------------------------------------------------------------
# FLAG parsing
# ---------------------------------------------------------------------------

_FLAG_PATTERN = re.compile(
    r"<!--\s*FLAG:\s*(\w+)\s*(?:—|--|–)\s*(.*?)\s*-->",
    re.DOTALL,
)

# Also detect inline FLAG markers (non-HTML-comment style)
_INLINE_FLAG_PATTERN = re.compile(
    r"^\s*FLAG:\s*(\w+)\s*(?:—|--|–)\s*(.*?)$",
    re.MULTILINE,
)

VALID_FLAG_TYPES = frozenset({
    "UNCERTAIN",
    "METHOD_QUESTION",
    "CONVENTION_MISMATCH",
    "NUMERICAL_INSTABILITY",
    "TOOL_QUESTION",
})

# Patterns that indicate a question is asking for WHAT (results) not HOW (method)
_WHAT_PATTERNS = [
    re.compile(r"what\s+(?:is|are)\s+(?:your|the)\s+(?:result|answer|value|output)", re.I),
    re.compile(r"(?:tell|show|give)\s+me\s+(?:your|the)\s+(?:result|answer|value)", re.I),
    re.compile(r"what\s+(?:did\s+you\s+get|do\s+you\s+get)", re.I),
]


@dataclass
class Flag:
    flag_type: str
    context: str
    source_line: int


@dataclass
class ConsultationQuestion:
    flag_type: str
    context: str
    question: str
    source_line: int


def extract_flags(text: str) -> list[Flag]:
    """Extract FLAG markers from a report."""
    flags: list[Flag] = []

    for m in _FLAG_PATTERN.finditer(text):
        ftype = m.group(1).strip().upper()
        ctx = m.group(2).strip()
        # Find line number
        line_no = text[:m.start()].count("\n") + 1
        flags.append(Flag(flag_type=ftype, context=ctx, source_line=line_no))

    for m in _INLINE_FLAG_PATTERN.finditer(text):
        ftype = m.group(1).strip().upper()
        ctx = m.group(2).strip()
        line_no = text[:m.start()].count("\n") + 1
        # Avoid duplicates from HTML comments already matched
        if not any(f.source_line == line_no for f in flags):
            flags.append(Flag(flag_type=ftype, context=ctx, source_line=line_no))

    return flags


def _is_how_question(question: str) -> bool:
    """Check that a generated question asks HOW, not WHAT."""
    for pat in _WHAT_PATTERNS:
        if pat.search(question):
            return False
    return True


_FLAG_TO_QUESTION_TEMPLATES: dict[str, str] = {
    "UNCERTAIN": "How would you handle {context}?",
    "METHOD_QUESTION": "What method or algorithm would you recommend for {context}?",
    "CONVENTION_MISMATCH": "What convention are you using for {context}?",
    "NUMERICAL_INSTABILITY": "How would you stabilize the numerical computation for {context}?",
    "TOOL_QUESTION": "What tool or library would you suggest for {context}?",
}


def flags_to_questions(flags: list[Flag]) -> list[ConsultationQuestion]:
    """Convert extracted flags to structured HOW-type questions."""
    questions: list[ConsultationQuestion] = []
    for flag in flags:
        template = _FLAG_TO_QUESTION_TEMPLATES.get(
            flag.flag_type,
            "How would you approach {context}?",
        )
        question_text = template.format(context=flag.context)

        # Validate: reject WHAT questions
        if not _is_how_question(question_text):
            continue

        questions.append(ConsultationQuestion(
            flag_type=flag.flag_type,
            context=flag.context,
            question=question_text,
            source_line=flag.source_line,
        ))
    return questions


def serialize_questions(member: str, questions: list[ConsultationQuestion]) -> dict:
    """Serialize questions to JSON-compatible dict."""
    return {
        "member": member,
        "questions": [
            {
                "flag_type": q.flag_type,
                "context": q.context,
                "question": q.question,
                "source_line": q.source_line,
            }
            for q in questions
        ],
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Extract consultation flags from Phase 1 reports")
    parser.add_argument("--member-a", required=True, type=Path)
    parser.add_argument("--member-b", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args(argv)

    args.output_dir.mkdir(parents=True, exist_ok=True)

    has_flags = False

    for member_label, member_file in [("A", args.member_a), ("B", args.member_b)]:
        if not member_file.is_file():
            print(f"WARNING: {member_label} report not found: {member_file}", file=sys.stderr)
            continue
        text = member_file.read_text(encoding="utf-8", errors="replace")
        flags = extract_flags(text)
        questions = flags_to_questions(flags)

        out_path = args.output_dir / f"questions_{member_label.lower()}.json"
        out_path.write_text(
            json.dumps(serialize_questions(member_label, questions), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"  {member_label}: {len(flags)} flags → {len(questions)} questions → {out_path}")
        if questions:
            has_flags = True

    if not has_flags:
        print("No consultation flags found — Phase 2 will be skipped.")
        return 2  # exit code 2 = no flags, skip Phase 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
