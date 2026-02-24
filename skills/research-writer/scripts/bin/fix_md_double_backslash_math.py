#!/usr/bin/env python3
r"""
fix_md_double_backslash_math.py

Deterministic helper to fix a common Markdown+LaTeX rendering hazard:
accidental double-backslash escapes in math, e.g. \\Delta, \\gamma\\_{\\rm lin}, k^\\*.

Policy:
- Only rewrite inside math regions (outside fenced code blocks):
  - inline math: $...$
  - fenced display math: $$ ... $$ where $$ is on its own line
- Only rewrite the safest patterns:
  - "\\\\" before letters: \\Delta -> \Delta
  - "\\\\" before "*_^": \\_ -> \_, \\^ -> \^, \\* -> \*
- Do NOT touch LaTeX line breaks (\\) or spacing (\\[2pt]) because they do not match the patterns above.

Exit codes:
  0  no changes needed (or changes applied with --in-place)
  1  changes needed (when NOT using --in-place)
  2  input error
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path


_CODE_FENCE_PREFIXES = ("```", "~~~")
_STANDALONE_DOLLAR = re.compile(r"^\s*\$\$\s*$")

_RE_DOUBLE_BEFORE_LETTER = re.compile(r"\\\\(?=[A-Za-z])")
_RE_DOUBLE_BEFORE_SYMBOL = re.compile(r"\\\\(?=[*_^])")


def _iter_md_files_under(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    if not root.is_dir():
        return []
    out: list[Path] = []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if ".git" in p.parts:
            continue
        if p.suffix.lower() not in (".md", ".markdown"):
            continue
        out.append(p)
    return sorted(out)


def _iter_inline_code_spans(line: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    i = 0
    n = len(line)
    while i < n:
        if line[i] != "`":
            i += 1
            continue
        j = i
        while j < n and line[j] == "`":
            j += 1
        delim = line[i:j]
        k = j
        while k < n:
            if line[k] != "`":
                k += 1
                continue
            r = k
            while r < n and line[r] == "`":
                r += 1
            if line[k:r] == delim:
                spans.append((i, r))
                i = r
                break
            k = r
        else:
            i = j
    return spans


def _split_inline_code_segments(line: str) -> list[tuple[str, bool]]:
    spans = _iter_inline_code_spans(line)
    if not spans:
        return [(line, False)]
    out: list[tuple[str, bool]] = []
    pos = 0
    for a, b in spans:
        if a > pos:
            out.append((line[pos:a], False))
        out.append((line[a:b], True))
        pos = b
    if pos < len(line):
        out.append((line[pos:], False))
    return out


@dataclass(frozen=True)
class Change:
    path: Path
    line: int
    kind: str


def _fix_math_text(s: str) -> tuple[str, int]:
    n = 0
    s2, k1 = _RE_DOUBLE_BEFORE_LETTER.subn(r"\\", s)
    n += k1
    s3, k2 = _RE_DOUBLE_BEFORE_SYMBOL.subn(r"\\", s2)
    n += k2
    return s3, n


def _fix_inline_math_in_segment(seg: str) -> tuple[str, int]:
    if "$$" in seg:
        return seg, 0

    out: list[str] = []
    i = 0
    changes = 0
    while i < len(seg):
        ch = seg[i]
        if ch != "$":
            out.append(ch)
            i += 1
            continue

        if i > 0 and seg[i - 1] == "\\":
            out.append(ch)
            i += 1
            continue

        j = i + 1
        while j < len(seg):
            if seg[j] == "$" and seg[j - 1] != "\\":
                break
            j += 1
        if j >= len(seg):
            out.append(ch)
            i += 1
            continue

        content = seg[i + 1 : j]
        fixed, n = _fix_math_text(content)
        changes += n
        out.append("$")
        out.append(fixed)
        out.append("$")
        i = j + 1

    return "".join(out), changes


def _fix_text(path: Path, text: str) -> tuple[str, list[Change]]:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    had_trailing_nl = text.endswith("\n")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines = lines[:-1]

    out_lines: list[str] = []
    changes: list[Change] = []
    in_code = False
    in_display = False

    for lineno, raw in enumerate(lines, start=1):
        stripped = raw.strip()

        if stripped.startswith(_CODE_FENCE_PREFIXES):
            in_code = not in_code
            out_lines.append(raw)
            continue
        if in_code:
            out_lines.append(raw)
            continue

        if _STANDALONE_DOLLAR.match(raw):
            in_display = not in_display
            out_lines.append(raw.rstrip())
            continue

        if in_display:
            fixed, n = _fix_math_text(raw)
            if n:
                changes.append(Change(path, lineno, "display_math_double_backslash"))
            out_lines.append(fixed)
            continue

        segs = _split_inline_code_segments(raw)
        new_parts: list[str] = []
        line_changes = 0
        for seg, is_code in segs:
            if is_code:
                new_parts.append(seg)
                continue
            fixed, n = _fix_inline_math_in_segment(seg)
            line_changes += n
            new_parts.append(fixed)
        new_ln = "".join(new_parts)
        if line_changes:
            changes.append(Change(path, lineno, "inline_math_double_backslash"))
        out_lines.append(new_ln)

    new_text = "\n".join(out_lines)
    if had_trailing_nl:
        new_text += "\n"
    return new_text, changes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=Path("."), help="File or directory to scan (default: .).")
    ap.add_argument("--in-place", action="store_true", help="Rewrite files in place.")
    args = ap.parse_args()

    root = args.root
    if not root.exists():
        print(f"ERROR: path not found: {root}", file=sys.stderr)
        return 2

    files = _iter_md_files_under(root)
    if not files:
        print(f"[ok] No Markdown files found under: {root}")
        return 0

    any_changes = False
    all_changes: list[Change] = []

    for p in files:
        if p.suffix.lower() not in (".md", ".markdown"):
            continue
        try:
            old = p.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            print(f"[warn] failed to read {p}: {exc}", file=sys.stderr)
            continue

        new, changes = _fix_text(p, old)
        if changes:
            any_changes = True
            all_changes.extend(changes)
            if args.in_place:
                p.write_text(new, encoding="utf-8")

    if not any_changes:
        print("[ok] No obvious double-backslash LaTeX escapes found in math regions.")
        return 0

    if args.in_place:
        print(f"[ok] Rewrote {len({c.path for c in all_changes})} file(s); changes: {len(all_changes)} (math-region double backslash fixes).")
        return 0

    print("[warn] Found double-backslash LaTeX escapes in math regions (likely accidental).")
    for c in all_changes[:80]:
        print(f"- {c.path}:{c.line} ({c.kind})")
    if len(all_changes) > 80:
        print(f"- ... ({len(all_changes) - 80} more)")
    print("[hint] To apply fixes (math regions only): python3 fix_md_double_backslash_math.py --root <path> --in-place")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

