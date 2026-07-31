#!/usr/bin/env python3
"""
Fold-boundary gate: a converged cycle's non-blocking findings must be
dispositioned before results are folded.

Severity-graded convergence lets members report `ready` while carrying Minor
Issues; the convergence gate surfaces per-member `minor_issues_count` in its
machine result and the adjudication builder emits a fillable disposition
table. This gate is the machine consumer that closes the loop: run it at the
fold boundary (before folding a converged cycle's results into the durable
record). It fails closed when recorded minor issues lack explicit
dispositions — an empty disposition cell, a bare "discard" without a reason,
or a missing adjudication file are refusals, not warnings.

Semantics:
  - The convergence result JSON (from check_team_convergence.py) is the
    authority for how many minor issues were recorded.
  - status != "converged"  -> SKIP (exit 0): folding a non-converged cycle is
    already forbidden upstream; this gate only guards the fold of a converged
    one.
  - total minor issues == 0 -> PASS (nothing owed; no adjudication required).
  - total minor issues  > 0 -> the adjudication file must exist and contain at
    least that many completed disposition rows. A completed row's disposition
    cell matches one of exactly three forms (case-insensitive):
        fix now[: free text]
        acceptance point <name>
        discard: <reason>
    A table row whose finding cell is filled but whose disposition cell is
    empty or malformed is a refusal (that is the "adjudication not finished"
    state the builder's template warns about).

Exit codes:
  0  PASS (or SKIP)
  1  FAIL (dispositions incomplete / adjudication missing)
  2  Input / execution error
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

_DISPOSITION_RE = re.compile(
    r"^(?:fix\s+now\b.*|acceptance\s+point\s+\S.*|discard:\s*\S.*)$",
    re.IGNORECASE,
)


def _fail(msg: str) -> int:
    print(f"FAIL: {msg}", file=sys.stderr)
    print(json.dumps({"status": "fail", "reason": msg}))
    return 1


def _input_error(msg: str) -> int:
    print(f"ERROR: {msg}", file=sys.stderr)
    print(json.dumps({"status": "input_error", "reason": msg}))
    return 2


def _count_minor_issues(convergence: dict) -> int:
    total = 0
    for member, payload in (convergence.get("report_status") or {}).items():
        if not isinstance(payload, dict):
            continue
        count = payload.get("minor_issues_count", 0)
        if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
            total += count
    return total


def _completed_disposition_rows(adjudication_text: str) -> tuple[int, list[str]]:
    """Count completed disposition rows and collect malformed-row diagnostics.

    Scans every markdown table row with >= 3 cells whose last cell is treated
    as the disposition. Header/separator rows and fully empty rows are
    skipped. A row with a filled finding cell but an empty or malformed
    disposition cell is a defect.
    """
    completed = 0
    problems: list[str] = []
    for raw in adjudication_text.splitlines():
        line = raw.strip()
        if not (line.startswith("|") and line.endswith("|")):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 3:
            continue
        # Skip header and separator rows.
        if all(re.fullmatch(r":?-{3,}:?", c) for c in cells if c):
            continue
        if cells[0].lower() in {"finding", "item"}:
            continue
        finding, disposition = cells[0], cells[-1]
        if not finding:
            continue  # template placeholder row
        if not disposition:
            problems.append(f"row {finding!r}: empty disposition cell")
            continue
        if not _DISPOSITION_RE.match(disposition):
            problems.append(
                f"row {finding!r}: disposition {disposition!r} matches none of "
                "'fix now', 'acceptance point <name>', 'discard: <reason>'"
            )
            continue
        completed += 1
    return completed, problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--convergence-json",
        type=Path,
        required=True,
        help="machine result emitted by check_team_convergence.py",
    )
    ap.add_argument(
        "--adjudication",
        type=Path,
        default=None,
        help="adjudication markdown carrying the disposition table "
        "(required when minor issues were recorded)",
    )
    args = ap.parse_args()

    if not args.convergence_json.is_file():
        return _input_error(f"convergence result not found: {args.convergence_json}")
    try:
        convergence = json.loads(args.convergence_json.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return _input_error(f"unreadable convergence result: {e}")
    if not isinstance(convergence, dict):
        return _input_error("convergence result must be a JSON object")

    status = convergence.get("status")
    if status != "converged":
        print(
            f"- Gate: SKIP (convergence status is {status!r}; this gate guards the "
            "fold of a converged cycle)",
            file=sys.stderr,
        )
        print(json.dumps({"status": "skip", "reason": f"cycle status {status!r}"}))
        return 0

    owed = _count_minor_issues(convergence)
    if owed == 0:
        print("- Gate: PASS (no minor issues recorded; no dispositions owed)", file=sys.stderr)
        print(json.dumps({"status": "pass", "minor_issues": 0, "dispositions": 0}))
        return 0

    if args.adjudication is None:
        return _fail(
            f"{owed} minor issue(s) recorded but no --adjudication supplied; every "
            "non-blocking finding owes an explicit disposition before the fold"
        )
    if not args.adjudication.is_file():
        return _fail(f"adjudication file not found: {args.adjudication}")
    try:
        text = args.adjudication.read_text(encoding="utf-8")
    except OSError as e:
        return _input_error(f"unreadable adjudication: {e}")

    completed, problems = _completed_disposition_rows(text)
    for p in problems:
        print(f"  * {p}", file=sys.stderr)
    if problems:
        return _fail(
            "adjudication contains malformed or empty disposition cells — an empty "
            "cell means the adjudication is not finished"
        )
    if completed < owed:
        return _fail(
            f"{owed} minor issue(s) recorded but only {completed} completed "
            "disposition row(s) found — every non-blocking finding owes exactly one "
            "of: fix now / acceptance point <name> / discard: <reason>"
        )
    print(
        f"- Gate: PASS ({completed} disposition(s) cover {owed} recorded minor issue(s))",
        file=sys.stderr,
    )
    print(json.dumps({"status": "pass", "minor_issues": owed, "dispositions": completed}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
