#!/usr/bin/env python3
"""
Suggest the next round tag using a clean scheme: <base>-r1, <base>-r2, ...

Problem this solves:
- People often keep appending "-r1" repeatedly (e.g. M3-r1-r1-r1...), which is messy.

Policy:
- The "base" tag is the provided tag with any trailing "-r<digits>" segments stripped
  repeatedly (so M3-r1-r1 -> base M3).
- The next round is chosen by scanning OUT_DIR for existing reports named:
    <base>-rN_member_a.md / <base>-rN_member_b.md
  and returning N = max(existing)+1. If none exist, return <base>-r1.

This script is deterministic and filesystem-local.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path


ROUND_SUFFIX_RE = re.compile(r"(?:-r\d+)+$")
ROUND_ONE_RE = re.compile(r"-r(\d+)$")


def canonical_base(tag: str) -> str:
    return ROUND_SUFFIX_RE.sub("", tag)


def find_max_round(base: str, out_dir: Path) -> int:
    if not out_dir.is_dir():
        return 0
    max_n = 0
    pat = re.compile(rf"^{re.escape(base)}-r(\d+)_(member_a|member_b)\.md$")
    scan_dirs: list[Path] = []
    runs = out_dir / "runs"
    if runs.is_dir():
        for d in runs.iterdir():
            if d.is_dir():
                scan_dirs.append(d)
    # Fallback: also scan the out_dir root (older layouts / mixed projects).
    scan_dirs.append(out_dir)

    for d in scan_dirs:
        for p in d.iterdir():
            if not p.is_file():
                continue
            m = pat.match(p.name)
            if not m:
                continue
            n = int(m.group(1))
            if n > max_n:
                max_n = n
    return max_n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tag", required=True, help="Current tag, e.g. M3 or M3-r1 or M3-r1-r1.")
    ap.add_argument("--out-dir", type=Path, required=True, help="Reviews output directory to scan.")
    args = ap.parse_args()

    base = canonical_base(args.tag.strip())
    if not base:
        raise SystemExit("ERROR: empty base tag after stripping round suffixes")

    max_round = find_max_round(base, args.out_dir)
    next_n = max_round + 1
    print(f"{base}-r{next_n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
