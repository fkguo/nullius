#!/usr/bin/env python3
r"""
fix_markdown_double_backslash_math.py

Deterministic helper to fix a common Markdown+LaTeX rendering hazard:
accidental double-backslash escapes in math, e.g. \\Delta, \\gamma\\_{\\rm lin}, k^\\*.

These often come from:
- Markdown TOC generators that escape backslashes inside headings/TOC entries, or
- LLM over-escaping when producing Markdown.

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
from dataclasses import dataclass
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from md_utils import iter_inline_code_spans, iter_md_files_by_targets, iter_md_files_under  # type: ignore
from team_config import DEFAULT_CONFIG, load_team_config  # type: ignore


_CODE_FENCE_PREFIXES = ("```", "~~~")
_STANDALONE_DOLLAR = re.compile(r"^\s*\$\$\s*$")

_RE_DOUBLE_BEFORE_LETTER = re.compile(r"\\\\(?=[A-Za-z])")
_RE_DOUBLE_BEFORE_SYMBOL = re.compile(r"\\\\(?=[*_^])")


@dataclass(frozen=True)
class Change:
    path: Path
    line: int
    kind: str


def _fix_math_text(s: str) -> tuple[str, int]:
    n = 0
    out = _RE_DOUBLE_BEFORE_LETTER.subn(r"\\", s)
    s2, k1 = out
    n += k1
    out2 = _RE_DOUBLE_BEFORE_SYMBOL.subn(r"\\", s2)
    s3, k2 = out2
    n += k2
    return s3, n


def _split_inline_code_segments(line: str) -> list[tuple[str, bool]]:
    """
    Return [(segment, is_code)] based on inline backtick spans.
    """
    spans = iter_inline_code_spans(line)
    if not spans:
        return [(line, False)]
    out: list[tuple[str, bool]] = []
    pos = 0
    for a, b, _, __ in spans:
        if a > pos:
            out.append((line[pos:a], False))
        out.append((line[a:b], True))
        pos = b
    if pos < len(line):
        out.append((line[pos:], False))
    return out


def _fix_inline_math_in_segment(seg: str) -> tuple[str, int]:
    """
    Fix double-backslash escapes inside $...$ within a segment that contains no inline code.
    """
    if "$$" in seg:
        # Inline display-math ($$ ... $$) is disallowed by policy; avoid destructive edits here.
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

        # Skip escaped dollars.
        if i > 0 and seg[i - 1] == "\\":
            out.append(ch)
            i += 1
            continue

        # Find closing unescaped '$' (same line).
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
    ap.add_argument("--root", type=Path, default=Path("."), help="File or directory to scan (default: .). Ignored when --notes is set.")
    ap.add_argument(
        "--notes",
        type=Path,
        default=None,
        help="Optional. Use research_team_config.json to deterministically scan key Markdown targets (same scope as the markdown math hygiene gate).",
    )
    ap.add_argument("--in-place", action="store_true", help="Rewrite files in place.")
    args = ap.parse_args()

    def _default_targets() -> list[str]:
        mmh = DEFAULT_CONFIG.get("markdown_math_hygiene", {})
        if isinstance(mmh, dict) and isinstance(mmh.get("targets"), list):
            return [str(x) for x in mmh.get("targets", []) if str(x).strip()]
        return [
            "Draft_Derivation.md",
            "PREWORK.md",
            "RESEARCH_PLAN.md",
            "PROJECT_CHARTER.md",
            "PROJECT_MAP.md",
            "knowledge_base/**/*.md",
        ]

    files: list[Path] = []
    if args.notes is not None:
        notes = args.notes
        if not notes.is_file():
            print(f"ERROR: notes not found: {notes}", file=sys.stderr)
            return 2
        cfg = load_team_config(notes)
        root = (cfg.path.parent if cfg.path is not None else notes.parent).resolve()
        mmh = cfg.data.get("markdown_math_hygiene", {}) if isinstance(cfg.data.get("markdown_math_hygiene", {}), dict) else {}
        targets_raw = mmh.get("targets", _default_targets())
        targets = [str(x) for x in (targets_raw if isinstance(targets_raw, list) else _default_targets()) if str(x).strip()]
        excl_raw = mmh.get("exclude_globs", [])
        exclude_globs = [str(x) for x in (excl_raw if isinstance(excl_raw, list) else []) if str(x).strip()]
        files, missing = iter_md_files_by_targets(root, targets, exclude_globs)
        if missing:
            print(
                "[warn] double-backslash fixer: some targets not found (skipped): "
                + ", ".join(missing[:8])
                + (" ..." if len(missing) > 8 else "")
            )
    else:
        root = args.root
        if not root.exists():
            print(f"ERROR: path not found: {root}", file=sys.stderr)
            return 2
        files = iter_md_files_under(root)

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

    # Changes exist.
    if args.in_place:
        print(f"[ok] Rewrote {len({c.path for c in all_changes})} file(s); changes: {len(all_changes)} (math-region double backslash fixes).")
        return 0

    print("[warn] Found double-backslash LaTeX escapes in math regions (likely accidental).")
    # Keep output compact; paths+lines are enough.
    for c in all_changes[:80]:
        print(f"- {c.path}:{c.line} ({c.kind})")
    if len(all_changes) > 80:
        print(f"- ... ({len(all_changes) - 80} more)")
    print(
        "[hint] To apply fixes (math regions only): "
        "python3 ~/.codex/skills/research-team/scripts/bin/fix_markdown_double_backslash_math.py "
        "--root <path> --in-place  (or: --notes Draft_Derivation.md --in-place)"
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
