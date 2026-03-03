#!/usr/bin/env python3
"""Phase 2 — Filter consultation response through Information Membrane.

Applies the Membrane to a consultation response, replacing any BLOCK content
with ``[REDACTED — ...]`` markers.

Usage:
    python filter_consultation_response.py \
        --input response.md \
        --output filtered_response.md \
        --phase phase_2 \
        --source-member B \
        --target-member A \
        [--audit-dir <run_dir>/membrane_audit]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from information_membrane import (
    build_audit_record,
    filter_message,
    write_audit_log,
)


def filter_response(
    text: str,
    *,
    phase: str = "phase_2",
    source_member: str = "",
    target_member: str = "",
    audit_dir: Path | None = None,
) -> str:
    """Apply Information Membrane to a consultation response.

    Returns the filtered text with BLOCK content replaced by [REDACTED] markers.
    """
    fr = filter_message(text)

    if audit_dir is not None:
        record = build_audit_record(
            filter_result=fr,
            input_text=text,
            phase=phase,
            source_member=source_member,
            target_member=target_member,
        )
        write_audit_log(record, audit_dir)

    # Rewrite [REDACTED] markers to be more descriptive for consultation context
    filtered = fr.passed_text
    for span in fr.blocked_spans:
        old_marker = span.replacement
        new_marker = (
            f"[REDACTED — consultation response contained {span.block_type}, "
            f"filtered by Information Membrane]"
        )
        filtered = filtered.replace(old_marker, new_marker, 1)

    return filtered


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Filter consultation response through Membrane")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--phase", default="phase_2")
    parser.add_argument("--source-member", default="")
    parser.add_argument("--target-member", default="")
    parser.add_argument("--audit-dir", type=Path, default=None)
    args = parser.parse_args(argv)

    if not args.input.is_file():
        print(f"ERROR: Input file not found: {args.input}", file=sys.stderr)
        return 1

    text = args.input.read_text(encoding="utf-8", errors="replace")
    filtered = filter_response(
        text,
        phase=args.phase,
        source_member=args.source_member,
        target_member=args.target_member,
        audit_dir=args.audit_dir,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(filtered, encoding="utf-8")
    print(f"Filtered response written to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
