#!/usr/bin/env python3
"""
Exploration debt gate (deterministic).

Purpose:
- `run_team_cycle.sh` can downgrade selected preflight gates to warn-only when
  `project_stage=exploration`, recording failures as a checklist:
    team/runs/<tag>/<tag>_exploration_debt.md
- When returning to `project_stage=development` (or publication), those debts
  should be cleared before proceeding with strict runs.

Contract:
- Debt items are Markdown task-list lines:
  - `- [ ] ...` open
  - `- [x] ...` closed
- If any open items exist anywhere under team/runs/**, this gate FAILS.

Exit codes:
  0 ok (no open debt)
  1 open debt exists
  2 input error
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from exploration_debt import scan_open_debt  # type: ignore


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--team-dir", type=Path, default=Path("team"), help="Team directory (default: team).")
    ap.add_argument("--max-items", type=int, default=25, help="Max open items to print (default: 25).")
    args = ap.parse_args()

    team_dir = args.team_dir
    if not team_dir.exists():
        return 0
    if not team_dir.is_dir():
        print(f"ERROR: --team-dir is not a directory: {team_dir}", file=sys.stderr)
        return 2

    runs_dir = team_dir / "runs"
    if not runs_dir.exists():
        return 0

    try:
        open_items = scan_open_debt(team_dir)
    except Exception as exc:
        print(f"ERROR: failed to scan exploration debt: {exc}", file=sys.stderr)
        return 2

    if not open_items:
        print("[ok] exploration debt: none open")
        return 0

    max_items = max(1, int(args.max_items))
    print(f"[debt] open exploration debt items: {len(open_items)}", file=sys.stderr)
    for item in open_items[:max_items]:
        rel = item.path
        try:
            rel = item.path.relative_to(Path.cwd())
        except Exception:
            pass
        print(f"- {rel}:{item.line} {item.text}", file=sys.stderr)
    if len(open_items) > max_items:
        print(f"... ({len(open_items) - max_items} more)", file=sys.stderr)
    print("", file=sys.stderr)
    print("Fix: resolve each issue, then mark it closed by changing `- [ ]` to `- [x]` in the debt file(s).", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
