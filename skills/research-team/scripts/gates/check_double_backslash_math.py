#!/usr/bin/env python3
"""
Global Markdown double-backslash math gate (domain-neutral).

Goal:
- Detect accidental double-backslash LaTeX escapes inside Markdown math regions,
  e.g. \\Delta, \\gamma\\_{\\rm lin}, k^\\*.

These often come from:
- Markdown TOC generators that over-escape backslashes inside headings/TOC entries, or
- LLM over-escaping when producing Markdown.

This gate checks (outside fenced code blocks, and ignoring inline code spans):
- Inline math: $...$
- Fenced display math: $$ ... $$ where $$ is on its own line

It flags only the conservative patterns covered by the deterministic fixer:
- "\\\\" before letters: \\Delta -> \\Delta (suspicious; likely should be \\Delta)
- "\\\\" before "*_^": \\_ -> \\_ (suspicious; likely should be \\_)

Config:
- features.double_backslash_math_gate: enable/disable this gate (default: True).
- Reuses markdown_math_hygiene.targets / exclude_globs for scan scope (same default targets).

Exit codes:
  0  ok, or gate disabled
  1  suspected accidental escapes detected
  2  input/config error
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from md_utils import iter_inline_code_spans, iter_md_files_by_targets  # type: ignore
from team_config import DEFAULT_CONFIG, load_team_config  # type: ignore


_CODE_FENCE_PREFIXES = ("```", "~~~")
_STANDALONE_DOLLAR = re.compile(r"^\s*\$\$\s*$")

_RE_DOUBLE_BEFORE_LETTER = re.compile(r"\\\\(?=[A-Za-z])")
_RE_DOUBLE_BEFORE_SYMBOL = re.compile(r"\\\\(?=[*_^])")


@dataclass(frozen=True)
class Violation:
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


def _split_inline_code_segments(line: str) -> list[tuple[str, bool]]:
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


def _scan_inline_math_in_segment(seg: str) -> int:
    if "$$" in seg:
        return 0

    changes = 0
    i = 0
    while i < len(seg):
        if seg[i] != "$":
            i += 1
            continue
        if i > 0 and seg[i - 1] == "\\":
            i += 1
            continue

        j = i + 1
        while j < len(seg):
            if seg[j] == "$" and seg[j - 1] != "\\":
                break
            j += 1
        if j >= len(seg):
            i += 1
            continue

        content = seg[i + 1 : j]
        _, n = _fix_math_text(content)
        changes += n
        i = j + 1
    return changes


def _scan_text(path: Path, text: str) -> list[Violation]:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.splitlines()

    in_code = False
    in_display = False
    violations: list[Violation] = []

    for lineno, raw in enumerate(lines, start=1):
        stripped = raw.strip()
        if stripped.startswith(_CODE_FENCE_PREFIXES):
            in_code = not in_code
            continue
        if in_code:
            continue

        if _STANDALONE_DOLLAR.match(raw):
            in_display = not in_display
            continue

        if in_display:
            _, n = _fix_math_text(raw)
            if n:
                violations.append(Violation(path, lineno, "display_math_double_backslash"))
            continue

        segs = _split_inline_code_segments(raw)
        changes = 0
        for seg, is_code in segs:
            if is_code:
                continue
            changes += _scan_inline_math_in_segment(seg)
        if changes:
            violations.append(Violation(path, lineno, "inline_math_double_backslash"))

    return violations


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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md (or equivalent).")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("double_backslash_math_gate", default=True):
        print("[skip] double-backslash math gate disabled by research_team_config")
        return 0

    root = (cfg.path.parent if cfg.path is not None else args.notes.parent).resolve()
    mmh = cfg.data.get("markdown_math_hygiene", {}) if isinstance(cfg.data.get("markdown_math_hygiene", {}), dict) else {}
    targets_raw = mmh.get("targets", _default_targets())
    targets = [str(x) for x in (targets_raw if isinstance(targets_raw, list) else _default_targets()) if str(x).strip()]
    excl_raw = mmh.get("exclude_globs", [])
    exclude_globs = [str(x) for x in (excl_raw if isinstance(excl_raw, list) else []) if str(x).strip()]

    files, missing = iter_md_files_by_targets(root, targets, exclude_globs)
    if missing:
        print(
            "[warn] double-backslash math gate: some targets not found (skipped): "
            + ", ".join(missing[:8])
            + (" ..." if len(missing) > 8 else "")
        )
    if not files:
        print(f"[ok] double-backslash math gate: no Markdown files matched targets under {root}")
        return 0

    violations: list[Violation] = []
    for p in files:
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            violations.append(Violation(p, 1, f"read_error:{exc}"))
            continue
        violations.extend(_scan_text(p, text))

    if violations:
        print("[fail] double-backslash math gate failed")
        for v in violations[:200]:
            print(f"[error] {v.path}:{v.line}: suspected accidental double-backslash escape in math ({v.kind})")
        if len(violations) > 200:
            print(f"[error] ... ({len(violations) - 200} more)")
        print(
            "[hint] To apply deterministic fixes (math regions only): "
            "python3 ~/.codex/skills/research-team/scripts/bin/fix_markdown_double_backslash_math.py --notes <Draft_Derivation.md> --in-place"
        )
        return 1

    print("[ok] double-backslash math gate passed")
    print(f"- root: {root}")
    print(f"- files scanned: {len(files)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

