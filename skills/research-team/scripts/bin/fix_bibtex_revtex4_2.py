#!/usr/bin/env python3
"""
fix_bibtex_revtex4_2.py

Deterministic BibTeX hygiene helper for APS RevTeX 4.2 workflows.

Why:
- In some RevTeX/BibTeX toolchains (notably APS styles), `@article{...}` entries without a `journal` field can
  trigger a BibTeX error. INSPIRE BibTeX exports for arXiv preprints are often `@article` without `journal`.

What it does:
- For each `@article{...}` entry that lacks a top-level `journal = ...` field, insert:
    journal = ""

Conservative scope:
- Does not reformat or normalize entries beyond inserting the missing field.
- Handles both brace-delimited and paren-delimited BibTeX entries.

Exit codes:
  0  ok (or fixed with --in-place)
  1  fixes needed (when not using --in-place)
  2  input error
"""

from __future__ import annotations

import argparse
from pathlib import Path


import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from bibtex_utils import BibtexPatch, normalize_revtex4_2_bibtex  # type: ignore


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bib", type=Path, required=True, help="BibTeX file to check/fix.")
    ap.add_argument("--in-place", action="store_true", help="Rewrite the file in place.")
    args = ap.parse_args()

    bib = args.bib
    if not bib.is_file():
        print(f"ERROR: bib file not found: {bib}")
        return 2

    old = bib.read_text(encoding="utf-8", errors="replace")
    new, patches = normalize_revtex4_2_bibtex(old)
    if not patches:
        print("[ok] revtex4-2 bibtex hygiene: no missing journal fields in @article entries")
        return 0

    if args.in_place:
        bib.write_text(new, encoding="utf-8")
        keys = ", ".join([p.key for p in patches[:8]]) + (" ..." if len(patches) > 8 else "")
        print(f"[ok] patched {len(patches)} @article entry(ies) by adding journal=\"\" (e.g. {keys})")
        return 0

    print("[warn] revtex4-2 bibtex hygiene: found @article entries missing journal=... (likely to break BibTeX)")
    for p in patches[:50]:
        print(f"- {p.key}")
    if len(patches) > 50:
        print(f"- ... ({len(patches) - 50} more)")
    print('[hint] Apply deterministic fix: python3 "${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}/scripts/bin/fix_bibtex_revtex4_2.py" --bib <path> --in-place')
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
