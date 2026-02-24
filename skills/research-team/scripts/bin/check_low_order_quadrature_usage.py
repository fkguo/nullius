#!/usr/bin/env python3
"""
check_low_order_quadrature_usage.py

Deterministic, local-only helper to scan a project tree for common low-order
quadrature usage patterns (e.g. trapezoid/trapz) that may need explicit error
control evidence (convergence study / higher-order cross-check) per research-team
numerics policy.

This is intentionally NOT wired into the default preflight gates to avoid
over-constraining real research workflows. Use it as an optional hygiene check,
or wire it into your project by policy/config if desired.

Exit codes:
  0: no matches (or matches found but not failing)
  1: matches found and --fail-on-find enabled
  2: input error
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path


SKIP_DIRS = {
    ".git",
    ".julia_depot",
    ".venv",
    "venv",
    "node_modules",
    "artifacts",
    "team",
    "references",
    "__pycache__",
}

FILE_EXTS = {".py", ".jl"}


@dataclass(frozen=True)
class Hit:
    path: Path
    line_no: int
    line: str


def _iter_files(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    files: list[Path] = []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        if p.suffix.lower() not in FILE_EXTS:
            continue
        files.append(p)
    files.sort()
    return files


def _scan_file(path: Path) -> list[Hit]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        raise RuntimeError(f"failed to read {path}: {e.__class__.__name__}: {e}") from e

    patterns: list[re.Pattern[str]] = [
        re.compile(r"\bnp\.trapz\s*\("),
        re.compile(r"\bnp\.trapezoid\s*\("),
        re.compile(r"\bnumpy\.trapz\s*\("),
        re.compile(r"\bnumpy\.trapezoid\s*\("),
        re.compile(r"\bscipy\.integrate\.trapz\s*\("),
        re.compile(r"\bscipy\.integrate\.trapezoid\s*\("),
        re.compile(r"\bintegrate\.trapz\s*\("),
        re.compile(r"\bintegrate\.trapezoid\s*\("),
        re.compile(r"\btrapz\s*\("),
    ]

    hits: list[Hit] = []
    for i, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if path.suffix.lower() == ".jl" and stripped.startswith("function trapz"):
            continue
        if any(p.search(line) for p in patterns):
            hits.append(Hit(path=path, line_no=i, line=line.rstrip("\n")))
    return hits


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Scan for trapezoid/trapz usage (optional numerics hygiene check)."
    )
    ap.add_argument("--root", type=Path, default=Path("."), help="Project root (file or directory).")
    ap.add_argument(
        "--fail-on-find",
        action="store_true",
        help="Exit with code 1 if any matches are found.",
    )
    ap.add_argument(
        "--max-matches",
        type=int,
        default=80,
        help="Max number of matching lines to print.",
    )
    args = ap.parse_args()

    root = args.root
    if not root.exists():
        print(f"[error] root not found: {root}", file=sys.stderr)
        return 2

    files = _iter_files(root)
    all_hits: list[Hit] = []
    for f in files:
        all_hits.extend(_scan_file(f))

    if not all_hits:
        print("[ok] no trapz/trapezoid usage found (scanned .py/.jl; skipped artifacts/team/references).")
        return 0

    print(f"[warn] found {len(all_hits)} trapz/trapezoid usage line(s):")
    for h in all_hits[: max(0, int(args.max_matches))]:
        rel = h.path
        try:
            rel = h.path.relative_to(root) if root.is_dir() else h.path
        except Exception:
            rel = h.path
        print(f"- {rel}:{h.line_no}: {h.line}")

    if len(all_hits) > int(args.max_matches):
        print(f"[warn] ... truncated (max {int(args.max_matches)} lines printed)")

    print(
        "\nNext step (recommended): if any of these affect headline numbers, "
        "record a convergence/cross-check trace under knowledge_base/methodology_traces/ "
        "and prefer higher-order/error-controlled methods (Simpson / Gauss–Legendre / adaptive GK)."
    )

    return 1 if bool(args.fail_on_find) else 0


if __name__ == "__main__":
    raise SystemExit(main())

