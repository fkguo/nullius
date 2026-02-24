#!/usr/bin/env python3
"""
Global Markdown math hygiene gate (domain-neutral).

Goal:
- Prevent rendering breakage in Markdown documents that carry equations (especially display math).

This gate checks (outside fenced code blocks):
- Disallow LaTeX \\( \\) and \\[ \\] delimiters (require $...$ / $$...$$).
- Disallow inline/one-line $$ usage (require fenced display math with standalone $$ lines).
- In $$...$$ blocks, no line may start with + / - / = (even after leading whitespace).
- Detect likely "split equation" artifacts: back-to-back $$ blocks where the second begins with a continuation token
  (\\qquad, \\quad, \\times, \\cdot) or an operator (+ / - / =).

Config:
- features.markdown_math_hygiene_gate: enable/disable this gate (default: True).
- markdown_math_hygiene.targets: list of paths/globs relative to project root (default targets are in team_config.py).
- markdown_math_hygiene.exclude_globs: optional exclusion globs relative to project root.

Default scan targets (per user policy):
- Draft_Derivation.md
- PREWORK.md
- RESEARCH_PLAN.md
- PROJECT_CHARTER.md
- knowledge_base/**/*.md

Exit codes:
  0  ok, or gate disabled
  1  hygiene violations detected
  2  input/config error
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import DEFAULT_CONFIG, load_team_config  # type: ignore
from md_math_hygiene import validate_markdown_math_hygiene  # type: ignore
from md_utils import iter_md_files_by_targets  # type: ignore


def _default_targets() -> list[str]:
    mmh = DEFAULT_CONFIG.get("markdown_math_hygiene", {})
    if isinstance(mmh, dict) and isinstance(mmh.get("targets"), list):
        return [str(x) for x in mmh.get("targets", []) if str(x).strip()]
    return [
        "Draft_Derivation.md",
        "PREWORK.md",
        "RESEARCH_PLAN.md",
        "PROJECT_CHARTER.md",
        "knowledge_base/**/*.md",
    ]

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md (or equivalent).")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("markdown_math_hygiene_gate", default=True):
        print("[skip] markdown math hygiene gate disabled by research_team_config")
        return 0

    root = (cfg.path.parent if cfg.path is not None else args.notes.parent).resolve()
    mmh = cfg.data.get("markdown_math_hygiene", {}) if isinstance(cfg.data.get("markdown_math_hygiene", {}), dict) else {}
    targets_raw = mmh.get("targets", _default_targets())
    targets = [str(x) for x in (targets_raw if isinstance(targets_raw, list) else _default_targets()) if str(x).strip()]
    excl_raw = mmh.get("exclude_globs", [])
    exclude_globs = [str(x) for x in (excl_raw if isinstance(excl_raw, list) else []) if str(x).strip()]

    files, missing = iter_md_files_by_targets(root, targets, exclude_globs)
    if missing:
        print("[warn] markdown math hygiene gate: some targets not found (skipped): " + ", ".join(missing[:8]) + (" ..." if len(missing) > 8 else ""))
    if not files:
        print(f"[ok] markdown math hygiene gate: no Markdown files matched targets under {root}")
        return 0

    errors: list[str] = []
    for p in files:
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            errors.append(f"Failed to read: {p} ({exc})")
            continue
        errors.extend(validate_markdown_math_hygiene(text, path_for_msgs=p))

    if errors:
        print("[fail] markdown math hygiene gate failed")
        for e in errors[:200]:
            print(f"[error] {e}")
        if len(errors) > 200:
            print(f"[error] ... ({len(errors) - 200} more)")
        return 1

    print("[ok] markdown math hygiene gate passed")
    print(f"- root: {root}")
    print(f"- files scanned: {len(files)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
