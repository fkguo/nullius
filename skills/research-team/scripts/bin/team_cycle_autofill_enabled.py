#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="Print 1 if deterministic auto-fill is enabled in config; else 0.")
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (or equivalent).")
    args = ap.parse_args()

    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
        from team_config import load_team_config  # type: ignore

        cfg = load_team_config(args.notes)
        auto = cfg.data.get("automation", {}) if isinstance(cfg.data.get("automation", {}), dict) else {}
        print("1" if bool(auto.get("enable_autofill", False)) else "0")
        return 0
    except Exception:
        print("0")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

