#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="Print effective review_access_mode and isolation_strategy from config.")
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md (or equivalent).")
    args = ap.parse_args()

    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
        from team_config import load_team_config  # type: ignore

        cfg = load_team_config(args.notes)
        mode = str(cfg.data.get("review_access_mode", "packet_only")).strip().lower()
        if mode not in ("full_access", "packet_only"):
            mode = "packet_only"
        strat = str(cfg.data.get("isolation_strategy", "separate_worktrees")).strip().lower()
        if strat not in ("separate_worktrees", "sequential_with_acl"):
            strat = "separate_worktrees"
        print(f"{mode} {strat}")
        return 0
    except Exception:
        print("packet_only separate_worktrees")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

