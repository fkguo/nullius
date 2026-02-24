#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="Extract 'Primary notebook: <path>' from a team packet.")
    ap.add_argument("--packet", type=Path, required=True, help="Path to team packet text file.")
    args = ap.parse_args()

    if not args.packet.is_file():
        print(f"ERROR: packet not found: {args.packet}", file=sys.stderr)
        return 2

    text = args.packet.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"^Primary notebook:\s*(.+?)\s*$", text, flags=re.MULTILINE)
    if not m:
        return 0

    print(m.group(1).strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

