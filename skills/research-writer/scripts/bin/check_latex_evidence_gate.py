#!/usr/bin/env python3
"""
check_latex_evidence_gate.py

Deterministic "evidence gate" linter for LaTeX revision edits.

Goal: reduce hallucination by flagging risky newly-added claims (typically in
`\\revadd{...}` blocks) that mention external data provenance / uncertainties /
error models without an explicit evidence anchor.

This is intentionally heuristic:
- It cannot *prove* a statement is correct.
- It can catch a common failure mode: plausible-sounding but unanchored details.

Default policy:
- Only scan addition-style macros (default: `revadd`).
- If an addition contains risky keywords, require at least one evidence anchor:
  - (locator + citation)  e.g., "Table ... Ref.~\\cite{...}" or "Fig. ... \\cite{...}"
  - OR a project-local evidence file path (e.g., `paper_audit/data/...`, `artifacts/...`).

Optional mode:
- `--scan-all` scans all text paragraphs (useful for freshly drafted .tex files
  that do not use revision macros).

Exit codes:
- 0: no violations (or warn-only mode with violations)
- 2: violations found and --fail was requested
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")

def _strip_latex_comments(text: str) -> str:
    """
    Best-effort comment stripping: remove '%' comments unless escaped as '\\%'.
    Not a full TeX parser; sufficient for a deterministic lint gate.
    """
    out_lines: list[str] = []
    for ln in text.splitlines():
        cut = None
        for i, ch in enumerate(ln):
            if ch != "%":
                continue
            # In TeX, '%' starts a comment unless escaped as '\%'.
            # If there are N backslashes immediately preceding '%':
            # - N odd  => '%' is escaped (literal percent)
            # - N even => '%' starts a comment (e.g. '\\%': linebreak then comment)
            j = i - 1
            n_bs = 0
            while j >= 0 and ln[j] == "\\":
                n_bs += 1
                j -= 1
            if n_bs % 2 == 0:
                cut = i
                break
        out_lines.append(ln[:cut] if cut is not None else ln)
    return "\n".join(out_lines) + ("\n" if text.endswith("\n") else "")


def _line_from_index(text: str, idx: int) -> int:
    if idx <= 0:
        return 1
    return text.count("\n", 0, idx) + 1


def _truncate_one_line(s: str, *, max_chars: int = 140) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) <= max_chars:
        return s
    return s[: max_chars - 1].rstrip() + "…"


@dataclass(frozen=True)
class Finding:
    path: Path
    line: int
    macro: str
    snippet: str
    reason: str


_RE_CITE = re.compile(r"\\cite[a-zA-Z]*(?:\[[^]]*\])*\s*\{[^}]+\}")
_RE_LOCATOR = re.compile(
    r"\b(Table|Tab\.|Figure|Fig\.|Equation|Eq\.|Section|Sec\.|Appendix|Page|p\.|pp\.|Chapter|Chap\.)\b",
    flags=re.I,
)
# A conservative "path-like" detector: contains at least one '/' and a plausible filename-ish tail.
_RE_PATHLIKE = re.compile(r"(?:(?:\b|`)([A-Za-z0-9_.-]+/){1,}[A-Za-z0-9_.-]+(?:\b|`))")


def _default_risky_regex() -> re.Pattern[str]:
    # Focus on provenance/uncertainty/error-model details (common hallucination vectors).
    terms = [
        r"uncertaint",
        r"\berror\b",
        r"error\s*bar",
        r"error\s*model",
        r"statistical",
        r"systematic",
        r"covari",
        r"correl",
        r"weight(?:ed|ing|s)?",
        r"\buniform\b",
        r"\bgaussian\b",
        r"digitiz",
        r"download",
        r"extract(?:ed|ion)?",
        r"taken\s+from",
        r"obtained\s+from",
        r"from\s+the\s+(?:database|online)",
        # Common NN/PWA datasets (safe to include; still just keywords):
        r"\bnno?line\b",
        r"\bsaid\b",
        r"\bpwa\b",
    ]
    return re.compile("(" + "|".join(terms) + ")", flags=re.I)


def _iter_tex_files(root: Path) -> Iterable[Path]:
    for p in sorted(root.rglob("*.tex")):
        if p.is_file():
            yield p


def _extract_macro_blocks(text: str, *, macros: list[str]) -> list[tuple[str, int, int, str]]:
    """
    Return list of (macro, start_idx, end_idx, content) for each occurrence of \\macro{...}.
    Brace parsing is done by counting '{' and '}' and supports nested braces.
    """
    if not macros:
        return []
    # Build a deterministic regex for the macro names.
    macro_alt = "|".join(re.escape(m) for m in sorted(set(macros)))
    re_open = re.compile(rf"\\(?:{macro_alt})\s*\{{")
    out: list[tuple[str, int, int, str]] = []

    i = 0
    while True:
        m = re_open.search(text, i)
        if not m:
            break
        open_brace_idx = text.find("{", m.start())
        if open_brace_idx < 0:
            i = m.end()
            continue

        macro_name = m.group(0)
        # Extract macro name without backslash and trailing stuff:
        # e.g., "\revadd{" or "\revadd {".
        mm = re.match(r"\\([A-Za-z0-9_]+)", macro_name)
        macro = mm.group(1) if mm else "unknown"

        depth = 0
        j = open_brace_idx
        # Consume the opening brace
        depth += 1
        j += 1
        content_start = j
        while j < len(text) and depth > 0:
            ch = text[j]
            if ch == "{":
                if j > 0 and text[j - 1] == "\\":
                    j += 1
                    continue
                depth += 1
            elif ch == "}":
                if j > 0 and text[j - 1] == "\\":
                    j += 1
                    continue
                depth -= 1
            j += 1
        if depth != 0:
            # Unbalanced braces; stop scanning to avoid infinite loops.
            break
        content_end = j - 1  # index of the closing brace
        content = text[content_start:content_end]
        out.append((macro, m.start(), j, content))
        i = j

    return out


def _has_anchor(text: str) -> bool:
    # Local file path anchor: e.g., paper_audit/data/... or artifacts/...
    if _RE_PATHLIKE.search(text):
        return True
    # Citation + locator (Table/Fig/Eq/Sec/Appendix).
    has_cite = bool(_RE_CITE.search(text))
    has_locator = bool(_RE_LOCATOR.search(text))
    return has_cite and has_locator


def _scan_tex(path: Path, *, macros: list[str], risky_re: re.Pattern[str]) -> list[Finding]:
    text = _read_text(path)
    findings: list[Finding] = []
    for macro, start, _end, content in _extract_macro_blocks(text, macros=macros):
        if not risky_re.search(content):
            continue
        if _has_anchor(content):
            continue
        line = _line_from_index(text, start)
        snippet = _truncate_one_line(content)
        findings.append(
            Finding(
                path=path,
                line=line,
                macro=macro,
                snippet=snippet,
                reason="risky added claim without evidence anchor (need Table/Fig/Eq/Sec + \\cite{...} OR local evidence path)",
            )
        )
    return findings

def _scan_all_text(path: Path, *, risky_re: re.Pattern[str]) -> list[Finding]:
    """
    Scan all text blocks (paragraphs) in a .tex file.

    This mode is useful for freshly drafted sections that do not use revision
    macros like \\revadd{...}.

    Policy: if a block contains risky keywords, it must contain an evidence
    anchor (locator+cite or local evidence path) within the same block.
    """
    raw = _read_text(path)
    text = _strip_latex_comments(raw)

    findings: list[Finding] = []
    block_lines: list[str] = []
    block_start_line = 1

    def flush(current_line: int) -> None:
        nonlocal block_lines, block_start_line
        if not block_lines:
            block_start_line = current_line + 1
            return
        block = "\n".join(block_lines).strip()
        if block and risky_re.search(block) and (not _has_anchor(block)):
            findings.append(
                Finding(
                    path=path,
                    line=block_start_line,
                    macro="ALL",
                    snippet=_truncate_one_line(block),
                    reason="risky claim without evidence anchor in same paragraph (need Table/Fig/Eq/Sec + \\cite{...} OR local evidence path)",
                )
            )
        block_lines = []
        block_start_line = current_line + 1

    for idx, ln in enumerate(text.splitlines(), start=1):
        if not ln.strip():
            flush(idx)
            continue
        if not block_lines:
            block_start_line = idx
        block_lines.append(ln)
    flush(len(text.splitlines()))
    return findings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=None, help="Scan all *.tex under this directory (recursive).")
    ap.add_argument("--tex", type=Path, action="append", default=[], help="Scan a specific .tex file (can repeat).")
    ap.add_argument(
        "--macro",
        action="append",
        default=[],
        help="Addition macro to scan (default: revadd). Can repeat (e.g., --macro revadd --macro added).",
    )
    ap.add_argument(
        "--scan-all",
        action="store_true",
        help="Scan all text blocks (paragraphs) instead of only \\macro{...} additions (useful for new drafts).",
    )
    ap.add_argument("--risk-keyword", action="append", default=[], help="Extra risky keyword/regex fragment to OR into the detector.")
    ap.add_argument("--fail", action="store_true", help="Exit non-zero if any violations are found.")
    args = ap.parse_args()

    macros = [m.strip() for m in (args.macro or []) if m and m.strip()]
    if not macros:
        macros = ["revadd"]

    risky_re = _default_risky_regex()
    if args.risk_keyword:
        # Extend the default regex deterministically.
        extra = [k.strip() for k in args.risk_keyword if k and k.strip()]
        if extra:
            risky_re = re.compile("(" + risky_re.pattern.strip("()") + "|" + "|".join(extra) + ")", flags=re.I)

    paths: list[Path] = []
    if args.root is not None:
        root = args.root.expanduser().resolve()
        if not root.is_dir():
            print(f"ERROR: --root is not a directory: {root}", file=sys.stderr)
            return 2
        paths.extend(list(_iter_tex_files(root)))
    for p in args.tex:
        pp = p.expanduser().resolve()
        if not pp.is_file():
            print(f"ERROR: --tex not found: {pp}", file=sys.stderr)
            return 2
        paths.append(pp)

    if not paths:
        print("ERROR: provide --root or --tex", file=sys.stderr)
        return 2

    findings: list[Finding] = []
    for p in sorted(set(paths)):
        if args.scan_all:
            findings.extend(_scan_all_text(p, risky_re=risky_re))
        else:
            findings.extend(_scan_tex(p, macros=macros, risky_re=risky_re))

    if findings:
        print("[evidence-gate] violations found:")
        for f in findings[:200]:
            rel = str(f.path)
            print(f"- {rel}:{f.line} ({f.macro}): {f.reason}")
            print(f"  snippet: {f.snippet}")
        if len(findings) > 200:
            print(f"... ({len(findings) - 200} more omitted)")
        if args.fail:
            return 2
        print("[evidence-gate] WARN-only mode: run with --fail to enforce.")
        return 0

    print("[evidence-gate] ok: no violations found")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
