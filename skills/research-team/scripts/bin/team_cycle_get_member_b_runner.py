#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="Print effective Member B runner settings from research_team_config.json.")
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md (or equivalent).")
    args = ap.parse_args()

    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
        from team_config import load_team_config  # type: ignore

        cfg = load_team_config(args.notes)
        mb = cfg.data.get("member_b", {}) if isinstance(cfg.data, dict) else {}
        if not isinstance(mb, dict):
            mb = {}
        kind = str(mb.get("runner_kind", "gemini")).strip().lower() or "gemini"
        if kind not in ("gemini", "claude", "auto"):
            kind = "gemini"
        claude_system = str(mb.get("claude_system_prompt", "")).strip()
        # Tab-separated so downstream can safely parse empty values.
        print(f"{kind}\t{claude_system}")
        return 0
    except Exception:
        print("gemini\t")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

