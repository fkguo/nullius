#!/usr/bin/env python3
"""
fix_markdown_math_hygiene.py

Deterministic Markdown math "autofix" helper for common rendering hazards.

Why:
- Some Markdown engines mis-parse lines starting with + / - / = even inside display math.
- LLMs sometimes "split" a single multi-line equation into back-to-back $$ blocks, which breaks rendering.

What it fixes (outside fenced code blocks):
1) Lines inside fenced display math ($$ on its own line) that start with + / - / = (after whitespace):
   - prefixes the line with "\\quad " (preserving indentation).
2) Likely split display equations: back-to-back $$ blocks where the second block begins with a continuation token
   (\\qquad, \\quad, \\times, \\cdot) or an operator (+ / - / =):
   - merges by removing the adjacent closing+opening $$ fences.
   - blank lines that were between the two fences are preserved and become blank lines inside the merged $$...$$ block.
3) Simple inline display math of the form: "$$ x = 1 $$" (entire line):
   - rewrites into fenced form with standalone "$$" lines.
   - conservative guard: if the body contains another "$$", the rewrite is skipped (likely multiple inline blocks on one line).

Exit codes:
  0  no changes needed (or all changes applied with --in-place)
  1  changes needed (when NOT using --in-place)
  2  input error
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from md_utils import iter_md_files_under  # type: ignore


_CODE_FENCE_PREFIXES = ("```", "~~~")
_STANDALONE_DOLLAR = re.compile(r"^\s*\$\$\s*$")
_INLINE_DISPLAY = re.compile(r"^(?P<indent>\s*)\$\$\s*(?P<body>.+?)\s*\$\$\s*$")
_CONTINUATION = re.compile(r"^\\(?:qquad|quad|times|cdot)\b")


@dataclass(frozen=True)
class Change:
    line: int
    kind: str
    detail: str


def _first_nonblank_after(lines: list[str], start_idx: int) -> tuple[int | None, str]:
    for j in range(start_idx, len(lines)):
        s = lines[j].lstrip()
        if not s:
            continue
        return j, s
    return None, ""


def _normalize(text: str) -> tuple[str, list[Change]]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    had_trailing_nl = text.endswith("\n")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines = lines[:-1]

    out: list[str] = []
    changes: list[Change] = []
    in_code = False
    in_display = False

    # Track adjacency for split-equation merges:
    just_closed_display = False
    closing_fence_out_index: int | None = None
    blank_after_close: list[str] = []

    i = 0
    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()

        if stripped.startswith(_CODE_FENCE_PREFIXES):
            # Any blank buffer belongs to normal Markdown, not math merging.
            if blank_after_close:
                out.extend(blank_after_close)
                blank_after_close = []
            just_closed_display = False
            closing_fence_out_index = None
            in_code = not in_code
            out.append(raw)
            i += 1
            continue

        if in_code:
            if blank_after_close:
                out.extend(blank_after_close)
                blank_after_close = []
            just_closed_display = False
            closing_fence_out_index = None
            out.append(raw)
            i += 1
            continue

        # Simple inline display: "$$ x = 1 $$" (whole line) -> fenced.
        if not in_display and "`" not in raw:
            m_inline = _INLINE_DISPLAY.match(raw)
            if m_inline and not _STANDALONE_DOLLAR.match(raw):
                indent = m_inline.group("indent")
                body_raw = m_inline.group("body")
                if "$$" in body_raw:
                    # Likely multiple inline display blocks on one line; avoid a destructive rewrite.
                    out.append(raw)
                    i += 1
                    continue
                body = body_raw.strip()
                out.append(f"{indent}$$")
                out.append(f"{indent}{body}")
                out.append(f"{indent}$$")
                changes.append(Change(i + 1, "inline_display_to_fence", "rewrite '$$ ... $$' into fenced form"))
                just_closed_display = False
                closing_fence_out_index = None
                blank_after_close = []
                i += 1
                continue

        if _STANDALONE_DOLLAR.match(raw):
            fence_line = raw.rstrip()
            if in_display:
                # Closing fence.
                in_display = False
                out.append(fence_line)
                closing_fence_out_index = len(out) - 1
                just_closed_display = True
                blank_after_close = []
                i += 1
                continue

            # Opening fence. Decide if we should merge with a just-closed block.
            if just_closed_display and closing_fence_out_index is not None:
                j, first = _first_nonblank_after(lines, i + 1)
                should_merge = False
                token = ""
                if first:
                    if first[0] in ("+", "-", "="):
                        should_merge = True
                        token = first[0]
                    else:
                        m_cont = _CONTINUATION.match(first)
                        if m_cont:
                            should_merge = True
                            token = m_cont.group(0)

                if should_merge:
                    # Remove previous closing fence and drop this opening fence.
                    out.pop(closing_fence_out_index)
                    # Preserve any blank lines that were between the two fences; after merge they live inside $$...$$.
                    if blank_after_close:
                        out.extend(blank_after_close)
                    changes.append(
                        Change(
                            i + 1,
                            "merge_split_display",
                            f"merge adjacent $$ blocks (continuation token {token!r} at line {1 + (j or i)})",
                        )
                    )
                    in_display = True
                    just_closed_display = False
                    closing_fence_out_index = None
                    blank_after_close = []
                    i += 1
                    continue

            # Not merging: flush buffered blank lines and open normally.
            if blank_after_close:
                out.extend(blank_after_close)
                blank_after_close = []
            out.append(fence_line)
            in_display = True
            just_closed_display = False
            closing_fence_out_index = None
            i += 1
            continue

        # Not a $$ fence.
        if just_closed_display:
            if stripped == "":
                # Buffer blank lines until we know whether we'll merge.
                blank_after_close.append(raw)
                i += 1
                continue
            # Any nonblank content breaks adjacency; flush and reset.
            out.extend(blank_after_close)
            blank_after_close = []
            just_closed_display = False
            closing_fence_out_index = None

        if in_display:
            s = raw.lstrip()
            if s and s[0] in ("+", "-", "="):
                lead = raw[: len(raw) - len(s)]
                fixed = f"{lead}\\quad {s}"
                out.append(fixed)
                changes.append(Change(i + 1, "prefix_operator", f"prefix line with '\\\\quad' (was {s[0]!r})"))
                i += 1
                continue

        out.append(raw)
        i += 1

    # Flush any pending blanks.
    if blank_after_close:
        out.extend(blank_after_close)

    new_text = "\n".join(out)
    if had_trailing_nl:
        new_text += "\n"
    return new_text, changes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=Path("."), help="File or directory to scan (default: .).")
    ap.add_argument(
        "--in-place",
        action="store_true",
        help="Rewrite files in place. Without this flag, runs in check mode and exits non-zero if changes are needed.",
    )
    args = ap.parse_args()

    root = args.root
    if not root.exists():
        print(f"ERROR: path not found: {root}", file=sys.stderr)
        return 2

    files = iter_md_files_under(root)
    if not files:
        if root.is_file():
            print(f"[skip] not a Markdown file: {root}")
            return 0
        print(f"[skip] no Markdown files under: {root}")
        return 0

    changed_files = 0
    total_changes = 0
    needs_changes = False

    for p in files:
        try:
            orig = p.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            print(f"ERROR: failed to read {p}: {exc}", file=sys.stderr)
            return 2

        new, changes = _normalize(orig)
        if not changes:
            continue

        needs_changes = True
        changed_files += 1
        total_changes += len(changes)

        if not args.in_place:
            print(f"[needs-fix] {p}")
            for c in changes[:50]:
                print(f"  - L{c.line}: {c.kind}: {c.detail}")
            if len(changes) > 50:
                print(f"  - ... ({len(changes) - 50} more)")
            continue

        try:
            p.write_text(new, encoding="utf-8")
        except Exception as exc:
            print(f"ERROR: failed to write {p}: {exc}", file=sys.stderr)
            return 2

        print(f"[fixed] {p} ({len(changes)} change(s))")

    if not needs_changes:
        print("[ok] no Markdown math hygiene fixes needed")
        return 0

    if args.in_place:
        print(f"[ok] fixed {changed_files} file(s), {total_changes} change(s) total")
        return 0

    print(f"[fail] fixes needed: {changed_files} file(s), {total_changes} change(s) total")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
