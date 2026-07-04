#!/usr/bin/env python3
"""
check_review_output_contract.py

Validate the strict reviewer output contract used by dual-review convergence loops.

Contract auto-detects output format:

Markdown format:
- First line exactly: "VERDICT: READY" or "VERDICT: NOT_READY"
- Required Markdown headers (exact):
  - "## Blockers"
  - "## Non-blocking"
  - "## Real-research fit"
  - "## Robustness & safety"
  - "## Specific patch suggestions"

JSON format:
- Valid JSON object with required fields: "blocking_issues", "verdict", "summary"
- "verdict" must be "PASS" or "FAIL"
- "blocking_issues" must be an array
- JSON wrapped in markdown code fences (```json ... ```) is automatically unwrapped

Two-phase mode (--two-phase PHASE1_FILE PHASE2_FILE):
- PHASE1_FILE must contain a valid declared-review-criteria block
  (<review_criteria> ... </review_criteria> with a JSON object inside)
- Every BLOCKING finding in PHASE2_FILE must carry a category declared in
  PHASE1_FILE, or an explicit criteria revision declaration
  (a "CRITERIA_REVISION: <category>: <reason>" line, or a "criteria_revisions"
  array in JSON output)

Exit codes:
  0  all files conform
  1  one or more files violate the contract
  2  usage / IO error
"""

from __future__ import annotations

import sys
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from review_contract import check_review_contract_file, check_two_phase_conformance


def _check_one(path: Path) -> list[str]:
    return check_review_contract_file(path)


_USAGE = (
    "\nUsage:\n"
    "  check_review_output_contract.py FILE [FILE ...]\n"
    "  check_review_output_contract.py --two-phase PHASE1_FILE PHASE2_FILE\n"
)


def _run_two_phase(paths: list[str]) -> int:
    if len(paths) != 2:
        print(__doc__.strip())
        print(_USAGE)
        return 2
    phase1 = Path(paths[0])
    phase2 = Path(paths[1])
    errs: list[str] = []
    for label, p in (("phase1", phase1), ("phase2", phase2)):
        if not p.exists() or not p.is_file():
            errs.append(f"{label}: missing file: {p}")
    if not errs:
        phase1_text = phase1.read_text(encoding="utf-8", errors="replace")
        phase2_text = phase2.read_text(encoding="utf-8", errors="replace")
        errs = check_two_phase_conformance(phase1_text, phase2_text)
    if errs:
        print(f"[FAIL] two-phase conformance: {phase1} -> {phase2}")
        for e in errs:
            print(f"  - {e}")
        return 1
    print(f"[ok] two-phase conformance: {phase1} -> {phase2}")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in {"-h", "--help"}:
        print(__doc__.strip())
        print(_USAGE)
        return 2 if len(argv) < 2 else 0

    if argv[1] == "--two-phase":
        return _run_two_phase(argv[2:])

    any_err = False
    for raw in argv[1:]:
        p = Path(raw)
        errs = _check_one(p)
        if errs:
            any_err = True
            print(f"[FAIL] {p}")
            for e in errs:
                print(f"  - {e}")
        else:
            print(f"[ok] {p}")
    return 1 if any_err else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
