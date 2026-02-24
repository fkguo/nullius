#!/usr/bin/env python3
"""
Exploration debt dashboard (helper, non-gate).

`run_team_cycle.sh` can downgrade selected preflight gates to warn-only when
`project_stage=exploration`, recording failures as Markdown checklists:
  team/runs/<tag>/<tag>_exploration_debt.md

This script helps you:
- list open debt items (with file+line)
- summarize counts by gate/tag
- close items (mark `- [ ]` -> `- [x]`) with explicit line numbers
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from exploration_debt import OPEN_RE, scan_open_debt  # type: ignore


def _relpath(p: Path) -> str:
    try:
        return str(p.relative_to(Path.cwd()))
    except Exception:
        return str(p)


def _print_summary(items: list[object], *, max_items: int) -> None:
    # items are OpenDebtItem objects; access via getattr to keep imports simple.
    by_gate: Counter[str] = Counter()
    by_tag: Counter[str] = Counter()
    for it in items:
        gate = getattr(it, "gate", None) or "unknown"
        tag = getattr(it, "tag", None) or "unknown"
        by_gate[str(gate)] += 1
        by_tag[str(tag)] += 1

    print(f"[debt] open items: {len(items)}")
    if by_gate:
        print("")
        print("By gate:")
        for k, v in by_gate.most_common():
            print(f"- {k}: {v}")
    if by_tag:
        print("")
        print("By tag:")
        for k, v in by_tag.most_common():
            print(f"- {k}: {v}")

    if items and max_items > 0:
        print("")
        print(f"Top {min(max_items, len(items))} items:")
        for it in items[:max_items]:
            p = getattr(it, "path")
            line = getattr(it, "line")
            text = getattr(it, "text")
            print(f"- {_relpath(Path(p))}:{int(line)} {text}")


def _close_lines(path: Path, *, lines: set[int]) -> int:
    if not path.is_file():
        print(f"ERROR: file not found: {path}", file=sys.stderr)
        return 2
    src = path.read_text(encoding="utf-8", errors="replace").splitlines(True)
    changed = False
    for ln_no in sorted(lines):
        if ln_no < 1 or ln_no > len(src):
            print(f"ERROR: line out of range: {path}:{ln_no}", file=sys.stderr)
            return 2
        ln = src[ln_no - 1]
        if not OPEN_RE.match(ln):
            continue
        # Replace the first task marker: "- [ ]" -> "- [x]" (preserve indentation).
        src[ln_no - 1] = re.sub(r"^(\s*-\s*\[)\s*(\]\s+)", r"\1x\2", ln, count=1)
        changed = True
    if not changed:
        print("[ok] nothing to close (no matching open items)")
        return 0
    path.write_text("".join(src), encoding="utf-8")
    print(f"[ok] closed {len(lines)} item(s) in {path}")
    return 0


def _open_line_numbers(path: Path) -> set[int]:
    text = path.read_text(encoding="utf-8", errors="replace")
    out: set[int] = set()
    for i, ln in enumerate(text.splitlines(), start=1):
        if OPEN_RE.match(ln):
            out.add(i)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("summary", help="Summarize open exploration debt.")
    p.add_argument("--team-dir", type=Path, default=Path("team"))
    p.add_argument("--max-items", type=int, default=10)
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("list", help="List open exploration debt items.")
    p.add_argument("--team-dir", type=Path, default=Path("team"))
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("close", help="Close specific debt items by line number (edits the debt file).")
    p.add_argument("--file", type=Path, required=True, help="Path to *_exploration_debt.md.")
    p.add_argument("--line", type=int, action="append", default=[], help="Line number to mark closed (repeatable).")
    p.add_argument("--all", action="store_true", help="Close all open items in the file.")

    args = ap.parse_args()

    if args.cmd in ("summary", "list"):
        team_dir = Path(args.team_dir)
        if not team_dir.exists():
            items: list = []
        else:
            items = scan_open_debt(team_dir)
        if bool(getattr(args, "json", False)):
            payload = [
                {
                    "path": str(getattr(it, "path")),
                    "line": int(getattr(it, "line")),
                    "text": str(getattr(it, "text")),
                    "tag": getattr(it, "tag", None),
                    "notes": getattr(it, "notes", None),
                    "gate": getattr(it, "gate", None),
                    "exit_code": getattr(it, "exit_code", None),
                    "utc": getattr(it, "utc", None),
                    "summary": getattr(it, "summary", None),
                }
                for it in items
            ]
            print(json.dumps(payload, indent=2, ensure_ascii=False))
            return 0
        if args.cmd == "summary":
            _print_summary(items, max_items=max(0, int(getattr(args, "max_items", 10))))
        else:
            for it in items:
                p = Path(getattr(it, "path"))
                print(f"{_relpath(p)}:{int(getattr(it, 'line'))} {getattr(it, 'text')}")
        return 0

    if args.cmd == "close":
        path = Path(args.file)
        if bool(getattr(args, "all", False)):
            try:
                lines = _open_line_numbers(path)
            except Exception as exc:
                print(f"ERROR: failed to read debt file: {path}: {exc}", file=sys.stderr)
                return 2
            if not lines:
                print("[ok] no open items found in the file")
                return 0
            return _close_lines(path, lines=lines)
        lines = {int(x) for x in getattr(args, "line", []) if int(x) > 0}
        if not lines:
            print("ERROR: provide --line N (repeatable) or --all", file=sys.stderr)
            return 2
        return _close_lines(path, lines=lines)

    raise SystemExit(f"Unknown cmd: {args.cmd}")


if __name__ == "__main__":
    raise SystemExit(main())
