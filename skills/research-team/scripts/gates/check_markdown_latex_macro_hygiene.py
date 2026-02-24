#!/usr/bin/env python3
r"""
Global LaTeX macro hygiene gate for Markdown (domain-neutral).

Goal:
- Prevent custom LaTeX macros (defined in paper sources) from leaking into Markdown math, where they typically
  do NOT render unless the Markdown engine is configured with those macros.

This gate checks (outside fenced code blocks, and ignoring inline code spans):
- Disallow a configurable list of custom macros (default includes common \mathcal shortcuts like \\Rc, \\Mc, \\Cc, \\cK).
  Prefer explicit forms like \\mathcal{R}, \\mathcal{M}, \\mathcal{C}, \\mathcal{K}.

Config:
- features.latex_macro_hygiene_gate: enable/disable this gate (default: True).
- latex_macro_hygiene.targets: list of paths/globs relative to project root (default targets are in team_config.py).
- latex_macro_hygiene.exclude_globs: optional exclusion globs relative to project root.
- latex_macro_hygiene.forbidden_macros: list of macro names without leading backslash.

Default scan targets (per user policy):
- Draft_Derivation.md
- PREWORK.md
- RESEARCH_PLAN.md
- PROJECT_CHARTER.md
- knowledge_base/**/*.md

Exit codes:
  0  ok, or gate disabled
  1  violations detected
  2  input/config error
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import DEFAULT_CONFIG, load_team_config  # type: ignore
from md_utils import iter_md_files_by_targets, strip_inline_code_spans  # type: ignore


def _default_targets() -> list[str]:
    lm = DEFAULT_CONFIG.get("latex_macro_hygiene", {})
    if isinstance(lm, dict) and isinstance(lm.get("targets"), list):
        return [str(x) for x in lm.get("targets", []) if str(x).strip()]
    return [
        "Draft_Derivation.md",
        "PREWORK.md",
        "RESEARCH_PLAN.md",
        "PROJECT_CHARTER.md",
        "knowledge_base/**/*.md",
    ]

def _compile_macro_re(macros: list[str]) -> re.Pattern[str]:
    alts = "|".join(re.escape(m) for m in macros if str(m).strip())
    if not alts:
        alts = r"$^"  # match nothing
    # LaTeX macro names are letter-only; stop at next letter (underscore/brace/etc are ok).
    return re.compile(r"\\(" + alts + r")(?![A-Za-z])")


def _validate_macros(path: Path, macro_re: re.Pattern[str]) -> list[str]:
    if not path.is_file() or path.suffix.lower() not in (".md", ".markdown"):
        return []

    try:
        text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    except Exception as exc:
        return [f"Failed to read: {path} ({exc})"]

    errors: list[str] = []
    in_fence = False
    fence_ch = ""
    fence_len = 0
    for lineno, raw_ln in enumerate(text.splitlines(), start=1):
        ln = raw_ln
        stripped = ln.lstrip()
        if stripped.startswith(("```", "~~~")):
            ch = stripped[0]
            run_len = 0
            while run_len < len(stripped) and stripped[run_len] == ch:
                run_len += 1
            if not in_fence:
                in_fence = True
                fence_ch = ch
                fence_len = run_len
                continue
            if ch == fence_ch and run_len >= fence_len:
                in_fence = False
                fence_ch = ""
                fence_len = 0
                continue
        if in_fence:
            continue

        # Ignore inline code spans so examples/TeX source pointers don't trip the gate.
        ln2 = strip_inline_code_spans(ln)
        for m in macro_re.finditer(ln2):
            name = m.group(1)
            errors.append(f"{path}:{lineno}: disallowed custom LaTeX macro '\\{name}' in Markdown; expand it (e.g. via fix_markdown_latex_macros.py)")

    return errors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md (or equivalent).")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("latex_macro_hygiene_gate", default=True):
        print("[skip] latex macro hygiene gate disabled by research_team_config")
        return 0

    root = (cfg.path.parent if cfg.path is not None else args.notes.parent).resolve()

    lm = cfg.data.get("latex_macro_hygiene", {}) if isinstance(cfg.data.get("latex_macro_hygiene", {}), dict) else {}
    targets_raw = lm.get("targets", _default_targets())
    targets = [str(x) for x in (targets_raw if isinstance(targets_raw, list) else _default_targets()) if str(x).strip()]
    excl_raw = lm.get("exclude_globs", [])
    exclude_globs = [str(x) for x in (excl_raw if isinstance(excl_raw, list) else []) if str(x).strip()]
    forbid_raw = lm.get("forbidden_macros", DEFAULT_CONFIG.get("latex_macro_hygiene", {}).get("forbidden_macros", []))
    forbidden = [str(x) for x in (forbid_raw if isinstance(forbid_raw, list) else []) if str(x).strip()]

    files, missing = iter_md_files_by_targets(root, targets, exclude_globs)
    if missing:
        print("[warn] latex macro hygiene gate: some targets not found (skipped): " + ", ".join(missing[:8]) + (" ..." if len(missing) > 8 else ""))
    if not files:
        print(f"[ok] latex macro hygiene gate: no Markdown files matched targets under {root}")
        return 0

    macro_re = _compile_macro_re(forbidden)
    errors: list[str] = []
    for p in files:
        errors.extend(_validate_macros(p, macro_re))

    if errors:
        print("[fail] latex macro hygiene gate failed")
        for e in errors[:200]:
            print(f"[error] {e}")
        if len(errors) > 200:
            print(f"[error] ... ({len(errors) - 200} more)")
        return 1

    print("[ok] latex macro hygiene gate passed")
    print(f"- root: {root}")
    print(f"- files scanned: {len(files)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
