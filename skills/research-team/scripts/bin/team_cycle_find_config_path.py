#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="Find the effective research-team config path for a project.")
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (or equivalent).")
    args = ap.parse_args()

    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
        from team_config import find_config_path  # type: ignore
    except Exception:
        # Fallback: no config discovery (warn-only by omission).
        return 0

    try:
        notes = args.notes.resolve()
        p = find_config_path(notes)
    except Exception:
        return 0

    if p is not None and p.is_file():
        print(str(p))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

