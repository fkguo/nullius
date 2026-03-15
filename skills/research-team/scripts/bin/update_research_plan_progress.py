#!/usr/bin/env python3
"""
Update research_plan.md progress log and Last updated line.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore


def _find_plan(notes_path: Path) -> Path | None:
    cur = notes_path.parent.resolve()
    for _ in range(6):
        cand = cur / "research_plan.md"
        if cand.is_file():
            return cand
        if cur.parent == cur:
            break
        cur = cur.parent
    return None


def _ensure_progress_log(lines: list[str]) -> int:
    for i, ln in enumerate(lines):
        if ln.strip().lower().startswith("## progress log"):
            return i
    lines.append("")
    lines.append("## Progress Log")
    lines.append("")
    return len(lines) - 2


def _update_last_updated(lines: list[str], date_str: str) -> None:
    for i, ln in enumerate(lines[:10]):
        if ln.strip().lower().startswith("last updated:"):
            lines[i] = f"Last updated: {date_str}"
            return
    # Insert after Created: if present, else after first line.
    insert_at = 1
    for i, ln in enumerate(lines[:10]):
        if ln.strip().lower().startswith("created:"):
            insert_at = i + 1
            break
    lines.insert(insert_at, f"Last updated: {date_str}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md.")
    ap.add_argument("--tag", default="", help="Milestone tag.")
    ap.add_argument("--status", default="converged", help="Status label.")
    ap.add_argument("--task-id", default="", help="Task id (optional).")
    ap.add_argument("--message", default="", help="Short note (optional).")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    plan_cfg = cfg.data.get("plan_tracking", {}) if isinstance(cfg.data.get("plan_tracking", {}), dict) else {}
    if not bool(plan_cfg.get("enabled", False)):
        print("[skip] plan tracking disabled by research_team_config")
        return 0

    if args.status and str(args.status).lower() in ("not_converged", "failed", "fail"):
        if not bool(plan_cfg.get("log_on_fail", True)):
            print("[skip] plan tracking log_on_fail=false")
            return 0

    plan_path = _find_plan(args.notes)
    if plan_path is None:
        print("[skip] research_plan.md not found")
        return 0

    lines = plan_path.read_text(encoding="utf-8", errors="replace").splitlines()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    _update_last_updated(lines, now)

    log_idx = _ensure_progress_log(lines)
    entry = f"- {now} tag={args.tag or 'N/A'} status={args.status}"
    if args.task_id:
        entry += f" task={args.task_id}"
    if args.message:
        entry += f" note={args.message}"

    # Avoid duplicate entries.
    if entry not in lines[log_idx + 1 :]:
        lines.append(entry)

    plan_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("[ok] updated research plan progress log")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
