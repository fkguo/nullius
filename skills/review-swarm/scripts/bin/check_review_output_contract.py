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

from review_contract import check_review_contract_file


def _check_one(path: Path) -> list[str]:
    return check_review_contract_file(path)


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in {"-h", "--help"}:
        print(__doc__.strip())
        print("\nUsage:\n  check_review_output_contract.py FILE [FILE ...]\n")
        return 2 if len(argv) < 2 else 0

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
