#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> None:
    gates = Path(__file__).resolve().parent / "gates" / "check_team_convergence.py"
    if not gates.is_file():
        raise SystemExit(f"ERROR: missing gate script: {gates}")
    os.execv(sys.executable, [sys.executable, str(gates), *sys.argv[1:]])


if __name__ == "__main__":
    main()
