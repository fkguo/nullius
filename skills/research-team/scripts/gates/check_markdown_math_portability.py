#!/usr/bin/env python3
"""
Markdown math portability check (domain-neutral).

Why:
- Some LaTeX constructs are not reliably supported across Markdown math renderers.
- In Markdown tables, literal pipe characters `|` inside inline math commonly break table parsing.

Policy (v1; conservative):
- Warn (default) on \\slashed usage in Markdown (suggest \\not\\! as a portable fallback).
- Warn (default) when a Markdown table line contains inline math ($...$) with a literal `|` character.
  Suggest replacing it with the intended LaTeX macro, e.g. \\lvert/\\rvert (abs), \\lVert/\\rVert (norm), or \\mid (conditional bar),
  instead of raw `|` / \\left| / \\| / etc.

Config:
- features.markdown_math_portability_gate: enable/disable this check (default: True).
- markdown_math_portability.targets: optional list of paths/globs relative to project root.
  If omitted, uses the same defaults as markdown_math_hygiene (Draft_Derivation/PREWORK/RESEARCH_PLAN/PROJECT_CHARTER/knowledge_base/**/*.md).
- markdown_math_portability.exclude_globs: optional exclusion globs.
- markdown_math_portability.enforce_table_math_pipes: if true, treat table-math pipes as FAIL (exit 1). Default: false (warn-only).
- markdown_math_portability.enforce_slashed: if true, treat \\slashed as FAIL (exit 1). Default: false (warn-only).

Exit codes:
  0  ok (or warnings only), or gate disabled
  1  violations detected (only when enforce_* is enabled)
  2  input/config error
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from md_utils import iter_md_files_by_targets, strip_inline_code_spans  # type: ignore
from team_config import DEFAULT_CONFIG, load_team_config  # type: ignore


@dataclass(frozen=True)
class Finding:
    kind: str  # "slashed" | "table_math_pipe"
    path: Path
    line: int
    message: str


_CODE_FENCE_PREFIXES = ("```", "~~~")
_SLASHED_RE = re.compile(r"\\slashed(?![A-Za-z])")
_TABLE_SEPARATOR_RE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$")


def _default_targets() -> list[str]:
    mmh = DEFAULT_CONFIG.get("markdown_math_hygiene", {})
    if isinstance(mmh, dict) and isinstance(mmh.get("targets"), list):
        return [str(x) for x in mmh.get("targets", []) if str(x).strip()]
    return [
        "research_contract.md",
        "research_preflight.md",
        "research_plan.md",
        "project_charter.md",
        "knowledge_base/**/*.md",
    ]


def _find_project_root(seed: Path) -> Path:
    cur = seed.resolve()
    if cur.is_file():
        cur = cur.parent
    for _ in range(12):
        if (cur / "project_charter.md").is_file() and (cur / "research_contract.md").is_file():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return seed.parent.resolve() if seed.is_file() else seed.resolve()


def _is_escaped(text: str, idx: int) -> bool:
    # Is the character at idx escaped by an odd number of preceding backslashes?
    bs = 0
    j = idx - 1
    while j >= 0 and text[j] == "\\":
        bs += 1
        j -= 1
    return (bs % 2) == 1


def _iter_inline_math_segments(line: str) -> list[str]:
    """
    Return inline math segments inside $...$ for a single line.
    - Best-effort only; ignores $$...$$ display on the same line (disallowed elsewhere by policy).
    - Honors escaped dollars (\\$).
    """
    segs: list[str] = []
    in_math = False
    start = 0
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == "$" and not _is_escaped(line, i):
            # Skip $$ (inline display math is disallowed by another gate).
            if (i + 1) < len(line) and line[i + 1] == "$" and not _is_escaped(line, i + 1):
                i += 2
                continue
            if not in_math:
                in_math = True
                start = i + 1
            else:
                segs.append(line[start:i])
                in_math = False
        i += 1
    return segs


def _table_line_numbers(lines: list[str]) -> set[int]:
    """
    Detect Markdown pipe-table blocks (header + separator + rows) and return 1-based line numbers
    that are part of such tables (including the header line).
    """
    out: set[int] = set()
    n = len(lines)
    i = 0
    while i < n:
        if _TABLE_SEPARATOR_RE.match(lines[i]):
            if i - 1 >= 0:
                out.add(i)  # separator line (0-based)
                out.add(i - 1)  # header line
            j = i + 1
            while j < n:
                s = lines[j].strip()
                if not s:
                    break
                if _TABLE_SEPARATOR_RE.match(lines[j]):
                    break
                if "|" not in lines[j]:
                    break
                out.add(j)
                j += 1
            i = j
            continue
        i += 1
    # Convert to 1-based for external reporting.
    return {x + 1 for x in out}


def _scan_file(path: Path) -> list[Finding]:
    if not path.is_file() or path.suffix.lower() not in (".md", ".markdown"):
        return []
    try:
        raw = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    except Exception:
        return []

    # Build a "rendered text" line list that excludes fenced code and inline code spans.
    in_fence = False
    fence_ch = ""
    fence_len = 0

    kept_lines: list[str] = []
    for ln in raw.splitlines():
        stripped = ln.lstrip()
        if stripped.startswith(_CODE_FENCE_PREFIXES):
            ch = stripped[0]
            run_len = 0
            while run_len < len(stripped) and stripped[run_len] == ch:
                run_len += 1
            if not in_fence:
                in_fence = True
                fence_ch = ch
                fence_len = run_len
                kept_lines.append("")  # preserve line numbering
                continue
            if ch == fence_ch and run_len >= fence_len:
                in_fence = False
                fence_ch = ""
                fence_len = 0
                kept_lines.append("")
                continue
        if in_fence:
            kept_lines.append("")
            continue
        kept_lines.append(strip_inline_code_spans(ln))

    table_lines = _table_line_numbers(kept_lines)

    findings: list[Finding] = []
    for lineno, ln in enumerate(kept_lines, start=1):
        if not ln.strip():
            continue

        if _SLASHED_RE.search(ln):
            findings.append(
                Finding(
                    kind="slashed",
                    path=path,
                    line=lineno,
                    message="found '\\slashed' in Markdown. Prefer a portable fallback like '\\not\\!' in Markdown math.",
                )
            )

        if lineno not in table_lines:
            continue

        if "|" not in ln:
            continue

        for seg in _iter_inline_math_segments(ln):
            if "|" not in seg:
                continue
            findings.append(
                Finding(
                    kind="table_math_pipe",
                    path=path,
                    line=lineno,
                    message=(
                        "Markdown table line contains inline math ($...$) with literal '|' (often breaks table parsing). "
                        "Replace literal '|' with the intended LaTeX macro inside tables: "
                        "'\\lvert...\\rvert' (abs), '\\lVert...\\rVert' (norm), or '\\mid' (conditional bar)."
                    ),
                )
            )
            break  # one finding per line is enough

    return findings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (or equivalent).")
    args = ap.parse_args()

    if not args.notes.exists():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("markdown_math_portability_gate", default=True):
        print("[skip] markdown math portability gate disabled by research_team_config")
        return 0

    root = _find_project_root(args.notes)

    mm = cfg.data.get("markdown_math_portability", {}) if isinstance(cfg.data.get("markdown_math_portability", {}), dict) else {}
    targets_raw = mm.get("targets", _default_targets())
    targets = [str(x) for x in (targets_raw if isinstance(targets_raw, list) else _default_targets()) if str(x).strip()]
    excl_raw = mm.get("exclude_globs", [])
    exclude_globs = [str(x) for x in (excl_raw if isinstance(excl_raw, list) else []) if str(x).strip()]

    enforce_table = bool(mm.get("enforce_table_math_pipes", False))
    enforce_slashed = bool(mm.get("enforce_slashed", False))

    files, missing = iter_md_files_by_targets(root, targets, exclude_globs)
    if missing:
        print(
            "[warn] markdown math portability gate: some targets not found (skipped): "
            + ", ".join(missing[:8])
            + (" ..." if len(missing) > 8 else "")
        )

    findings: list[Finding] = []
    for p in files:
        findings.extend(_scan_file(p))

    if not findings:
        print("[ok] markdown math portability gate passed (no issues found)")
        return 0

    n_slashed = sum(1 for f in findings if f.kind == "slashed")
    n_pipe = sum(1 for f in findings if f.kind == "table_math_pipe")
    print(f"[warn] markdown math portability: slashed={n_slashed}, table_math_pipes={n_pipe}")
    for f in findings[:200]:
        print(f"[warn] {f.path}:{f.line}: {f.message}")
    if len(findings) > 200:
        print(f"[warn] ... ({len(findings) - 200} more)")

    hard = []
    if enforce_slashed:
        hard.extend([f for f in findings if f.kind == "slashed"])
    if enforce_table:
        hard.extend([f for f in findings if f.kind == "table_math_pipe"])
    if hard:
        print("[fail] markdown math portability gate failed (enforcement enabled)")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
