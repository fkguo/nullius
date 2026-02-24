#!/usr/bin/env python3
"""
fix_bibtex_revtex4_2.py

Deterministic BibTeX hygiene helper for APS RevTeX 4.2 workflows.

Why:
- In some RevTeX/BibTeX toolchains (notably APS styles), `@article{...}` entries without a `journal` field can
  trigger a BibTeX error. INSPIRE BibTeX exports for arXiv preprints are often `@article` without `journal`.

What it does:
- For each `@article{...}` / `@article(... )` entry that lacks a top-level `journal = ...` field, insert:
    journal = ""

Scope:
- Conservative: does not reformat or normalize entries beyond inserting the missing field.

Exit codes:
  0  ok (or fixed with --in-place)
  1  fixes needed (when not using --in-place)
  2  input error
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Patch:
    key: str


_RE_ENTRY_START = re.compile(r"@([A-Za-z]+)\s*([({])", re.MULTILINE)


def _find_entry(text: str, at: int) -> tuple[int, int, str, str, int] | None:
    """
    Return (start, end, entry_type_lower, key, body_start_index) or None.
    """
    m = _RE_ENTRY_START.match(text, at)
    if not m:
        return None
    entry_type = m.group(1).strip().lower()
    open_ch = m.group(2)
    close_ch = "}" if open_ch == "{" else ")"

    i = at + m.end()
    n = len(text)
    while i < n and text[i].isspace():
        i += 1
    key_start = i
    comma = text.find(",", key_start)
    if comma < 0:
        return None
    key = text[key_start:comma].strip()
    body_start = comma + 1

    level = 1
    in_quote = False
    j = at + m.end()
    while j < n:
        ch = text[j]
        if ch == '"' and (j == 0 or text[j - 1] != "\\"):
            in_quote = not in_quote
            j += 1
            continue
        if in_quote:
            j += 1
            continue
        if ch == open_ch:
            level += 1
        elif ch == close_ch:
            level -= 1
            if level == 0:
                return at, j + 1, entry_type, key, body_start
        j += 1
    return None


def _has_top_level_journal(body: str) -> bool:
    brace = 0
    in_quote = False
    i = 0
    n = len(body)
    while i < n:
        ch = body[i]
        if ch == '"' and (i == 0 or body[i - 1] != "\\"):
            in_quote = not in_quote
            i += 1
            continue
        if in_quote:
            i += 1
            continue
        if ch == "{":
            brace += 1
            i += 1
            continue
        if ch == "}":
            brace = max(0, brace - 1)
            i += 1
            continue
        if brace == 0 and body[i : i + 7].lower() == "journal":
            prev = body[i - 1] if i > 0 else ""
            if prev and (prev.isalnum() or prev in ("_", "-")):
                i += 1
                continue
            j = i + 7
            while j < n and body[j].isspace():
                j += 1
            if j < n and body[j] == "=":
                k = i - 1
                while k >= 0 and body[k].isspace():
                    k -= 1
                if k < 0 or body[k] == ",":
                    return True
        i += 1
    return False


def _insert_journal(entry_text: str, body_start: int, entry_end: int) -> str:
    # Insert after the key comma; avoid double blank lines if the body already starts with newline.
    prefix = entry_text[:body_start]
    body = entry_text[body_start:entry_end]
    if body.startswith("\n"):
        body = body[1:]
    return prefix + "\n  journal = \"\",\n" + body


def normalize_revtex4_2_bibtex(text: str) -> tuple[str, list[Patch]]:
    patches: list[Patch] = []
    out_parts: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        at = text.find("@", i)
        if at < 0:
            out_parts.append(text[i:])
            break
        out_parts.append(text[i:at])
        found = _find_entry(text, at)
        if not found:
            out_parts.append(text[at : at + 1])
            i = at + 1
            continue
        start, end, entry_type, key, body_start = found
        entry = text[start:end]
        if entry_type != "article":
            out_parts.append(entry)
            i = end
            continue

        body = entry[body_start : len(entry) - 1]
        if _has_top_level_journal(body):
            out_parts.append(entry)
            i = end
            continue

        patches.append(Patch(key=key or "<unknown>"))
        out_parts.append(_insert_journal(entry, body_start=body_start - start, entry_end=len(entry) - 1))
        out_parts.append(entry[-1])  # closing delimiter
        i = end

    return "".join(out_parts), patches


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bib", type=Path, required=True, help="BibTeX file to check/fix.")
    ap.add_argument("--in-place", action="store_true", help="Rewrite the file in place.")
    args = ap.parse_args()

    bib = args.bib
    if not bib.is_file():
        print(f"ERROR: bib file not found: {bib}", file=sys.stderr)
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
    print("[hint] Apply deterministic fix: python3 fix_bibtex_revtex4_2.py --bib <path> --in-place")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

