#!/usr/bin/env python3
"""
Deterministically update a trajectory index JSON (long-horizon progress externalization).

This is inspired by "trajectory records" ideas (e.g. MCTS node logs), but kept simple and deterministic:
- Append/update per-tag entries with timestamps, stage markers, paths, and gate outcomes.
- Does NOT run any LLMs and does NOT interpret content; only records file references and statuses.

Exit codes:
  0 success (or disabled by config)
  2 input error
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore


def _utc_now() -> str:
    return _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {"version": 1, "runs": []}
    return json.loads(path.read_text(encoding="utf-8", errors="replace"))


def _write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Notebook path (used to locate config).")
    ap.add_argument("--out-dir", type=Path, required=True, help="Team output directory (e.g. team/).")
    ap.add_argument("--tag", required=True, help="Resolved round tag (e.g. M2-r1).")
    ap.add_argument("--stage", required=True, help="Stage marker (preflight_start/preflight_ok/member_reports/converged/not_converged).")
    ap.add_argument("--packet", default="", help="Packet path (optional).")
    ap.add_argument("--member-a", default="", help="Member A report path (optional).")
    ap.add_argument("--member-b", default="", help="Member B report path (optional).")
    ap.add_argument("--member-c", default="", help="Member C report path (optional).")
    ap.add_argument("--adjudication", default="", help="Adjudication note path (optional).")
    ap.add_argument("--gate", default="", help="Gate outcome summary (optional string).")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("trajectory_index", default=True):
        print("[skip] trajectory index disabled by research_team_config")
        return 0

    out_dir = args.out_dir if args.out_dir.is_absolute() else (args.notes.parent / args.out_dir)
    index_path = out_dir / "trajectory_index.json"

    obj = _load_json(index_path)
    if not isinstance(obj, dict):
        obj = {"version": 1, "runs": []}
    runs = obj.get("runs")
    if not isinstance(runs, list):
        runs = []
        obj["runs"] = runs

    rec = {
        "tag": args.tag,
        "updated_at": _utc_now(),
        "stage": args.stage,
        "packet": args.packet or None,
        "member_a": args.member_a or None,
        "member_b": args.member_b or None,
        "member_c": args.member_c or None,
        "adjudication": args.adjudication or None,
        "gate": args.gate or None,
    }

    # Upsert by tag+stage (keep last update per stage).
    replaced = False
    for i, r in enumerate(runs):
        if isinstance(r, dict) and r.get("tag") == args.tag and r.get("stage") == args.stage:
            runs[i] = rec
            replaced = True
            break
    if not replaced:
        runs.append(rec)

    _write_json(index_path, obj)
    print(f"[ok] updated trajectory index: {index_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
