#!/usr/bin/env python3
"""
Suggest the next round tag using a clean scheme: <base>-r1, <base>-r2, ...

For human-facing research runs, use a meaningful base tag such as
20260502T023000Z-m3-branch-scan. The resolved <base>-rN value can then be used
as the project-local run_id whose canonical artifact root is
artifacts/runs/<run_id>/.

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
import sys
from pathlib import Path


ROUND_SUFFIX_RE = re.compile(r"(?:-r\d+)+$")
ROUND_ONE_RE = re.compile(r"-r(\d+)$")
# A review round counts as verdict-bearing when at least one member report
# carries the required verdict heading (the runner's health-check criterion).
VERDICT_HEADING_RE = re.compile(r"^##\s+Verdict\s*$", re.IGNORECASE | re.MULTILINE)


def canonical_base(tag: str) -> str:
    return ROUND_SUFFIX_RE.sub("", tag)


def _scan_dirs(out_dir: Path) -> list[Path]:
    scan_dirs: list[Path] = []
    runs = out_dir / "runs"
    if runs.is_dir():
        for d in runs.iterdir():
            if d.is_dir():
                scan_dirs.append(d)
    # Fallback: also scan the out_dir root (older layouts / mixed projects).
    scan_dirs.append(out_dir)
    return scan_dirs


def find_max_round(base: str, out_dir: Path) -> int:
    if not out_dir.is_dir():
        return 0
    max_n = 0
    pat = re.compile(rf"^{re.escape(base)}-r(\d+)_(member_a|member_b)\.md$")
    for d in _scan_dirs(out_dir):
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


def round_has_verdict_report(base: str, round_n: int, out_dir: Path) -> bool | None:
    """True when any member report of round N carries a '## Verdict' heading;
    False when reports exist but none does (an unavailability-terminated or
    otherwise failed round); None when no report file of that round is found."""
    if not out_dir.is_dir():
        return None
    found = False
    for d in _scan_dirs(out_dir):
        for member in ("member_a", "member_b"):
            p = d / f"{base}-r{round_n}_{member}.md"
            if not p.is_file():
                continue
            found = True
            try:
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if VERDICT_HEADING_RE.search(text):
                return True
    return False if found else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tag", required=True, help="Current tag, e.g. M3 or M3-r1 or M3-r1-r1.")
    ap.add_argument("--out-dir", type=Path, required=True, help="Reviews output directory to scan.")
    ap.add_argument(
        "--refuse-unverdicted",
        action="store_true",
        help=(
            "exit 3 instead of only warning when the latest existing round has "
            "report files but no verdict-bearing report — advancing the round "
            "suffix over an unavailability-terminated round burns bounded-round "
            "capacity on a round that never happened"
        ),
    )
    args = ap.parse_args()

    base = canonical_base(args.tag.strip())
    if not base:
        raise SystemExit("ERROR: empty base tag after stripping round suffixes")

    max_round = find_max_round(base, args.out_dir)
    # Round-advance guard: unavailability is not a round. When the latest
    # round left report files but no verdict-bearing report, the honest move
    # is a same-tag --resume of that round, not minting r(N+1).
    if max_round >= 1 and round_has_verdict_report(base, max_round, args.out_dir) is False:
        message = (
            f"latest round {base}-r{max_round} has report files but none carries a "
            "'## Verdict' heading — that round likely ended in reviewer "
            "unavailability or a failed cycle; prefer resuming the SAME tag "
            f"({base}-r{max_round} with --resume) instead of advancing the round suffix"
        )
        if args.refuse_unverdicted:
            print(f"ERROR: {message}", file=sys.stderr)
            return 3
        print(f"WARNING: {message}", file=sys.stderr)
    next_n = max_round + 1
    print(f"{base}-r{next_n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
