#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="Print effective project_stage from research_team_config.json.")
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (or equivalent).")
    args = ap.parse_args()

    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
        from team_config import load_team_config  # type: ignore

        cfg = load_team_config(args.notes)
        stage = str(cfg.data.get("project_stage", "development")).strip().lower() if isinstance(cfg.data, dict) else ""
        if stage not in ("exploration", "development", "publication"):
            stage = "development"
        print(stage)
        return 0
    except Exception:
        print("development")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
