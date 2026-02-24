#!/usr/bin/env python3
"""
fix_markdown_latex_macros.py

Deterministic macro-expansion helper for Markdown math rendering.

Why:
- Project-specific LaTeX macros (e.g. \\Rc, \\Mc) usually come from paper sources (\\newcommand),
  but Markdown math renderers typically do not know those macros.

What it fixes (outside fenced code blocks, and ignoring inline code spans):
- Rewrites occurrences of configured macros (default: Rc/Mc/Cc/cK) into explicit expansions like {\\mathcal{R}}.

Config source:
- If a research-team config is discoverable from --root, uses latex_macro_hygiene.expansions and forbidden_macros.
- Otherwise uses built-in defaults matching team_config.py.

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


_CODE_FENCE_PREFIXES = ("```", "~~~")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
try:
    from team_config import DEFAULT_CONFIG, load_team_config  # type: ignore
except Exception:  # pragma: no cover
    DEFAULT_CONFIG = {}  # type: ignore
    load_team_config = None  # type: ignore

from md_utils import iter_inline_code_spans, iter_md_files_under, strip_inline_code_spans  # type: ignore


@dataclass(frozen=True)
class Change:
    line: int
    kind: str
    detail: str


def _load_macro_config(seed: Path) -> tuple[list[str], dict[str, str]]:
    # Defaults (match scripts/lib/team_config.py).
    default_forbidden = ["Rc", "Mc", "Cc", "cK", "re", "im"]
    default_exp = {
        "Rc": "{\\mathcal{R}}",
        "Mc": "{\\mathcal{M}}",
        "Cc": "{\\mathcal{C}}",
        "cK": "{\\mathcal{K}}",
        "re": "{\\operatorname{Re}}",
        "im": "{\\operatorname{Im}}",
    }

    if load_team_config is None:
        return default_forbidden, default_exp

    try:
        cfg = load_team_config(seed)
    except Exception:
        return default_forbidden, default_exp

    lm = cfg.data.get("latex_macro_hygiene", {}) if isinstance(cfg.data.get("latex_macro_hygiene", {}), dict) else {}
    forbid_raw = lm.get("forbidden_macros", default_forbidden)
    forbidden = [str(x) for x in (forbid_raw if isinstance(forbid_raw, list) else default_forbidden) if str(x).strip()]

    exp_raw = lm.get("expansions", default_exp)
    expansions: dict[str, str] = {}
    if isinstance(exp_raw, dict):
        for k, v in exp_raw.items():
            ks = str(k).strip()
            vs = str(v)
            if ks:
                expansions[ks] = vs

    # Ensure all forbidden macros have an expansion (fall back to defaults).
    for k, v in default_exp.items():
        if k in forbidden and k not in expansions:
            expansions[k] = v

    return forbidden, expansions


def _compile_macro_re(macros: list[str]) -> re.Pattern[str]:
    alts = "|".join(re.escape(m) for m in macros if str(m).strip())
    if not alts:
        alts = r"$^"
    return re.compile(r"\\(" + alts + r")(?![A-Za-z])")

def _rewrite_line(line: str, macro_re: re.Pattern[str], expansions: dict[str, str]) -> tuple[str, list[Change]]:
    changes: list[Change] = []

    # Keep inline code spans untouched.
    out_parts: list[str] = []
    last = 0
    for a, b, _, __ in iter_inline_code_spans(line):
        seg = line[last:a]
        seg2, ch = _rewrite_segment(seg, macro_re, expansions)
        out_parts.append(seg2)
        changes.extend(ch)
        out_parts.append(line[a:b])
        last = b

    tail = line[last:]
    tail2, ch2 = _rewrite_segment(tail, macro_re, expansions)
    out_parts.append(tail2)
    changes.extend(ch2)

    return "".join(out_parts), changes


def _rewrite_segment(seg: str, macro_re: re.Pattern[str], expansions: dict[str, str]) -> tuple[str, list[Change]]:
    changes: list[Change] = []

    def _repl(m: re.Match[str]) -> str:
        name = m.group(1)
        repl = expansions.get(name)
        if repl is None:
            return m.group(0)
        changes.append(Change(0, "expand_macro", f"replace \\{name} -> {repl}"))
        return repl

    return macro_re.sub(_repl, seg), changes


def _normalize(text: str, macro_re: re.Pattern[str], expansions: dict[str, str]) -> tuple[str, list[Change]]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    had_trailing_nl = text.endswith("\n")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines = lines[:-1]

    out: list[str] = []
    changes: list[Change] = []
    in_code = False
    fence_ch = ""
    fence_len = 0

    for i, raw in enumerate(lines, start=1):
        fence = raw.lstrip()
        if fence.startswith(_CODE_FENCE_PREFIXES):
            ch = fence[0]
            run_len = 0
            while run_len < len(fence) and fence[run_len] == ch:
                run_len += 1
            if not in_code:
                in_code = True
                fence_ch = ch
                fence_len = run_len
                out.append(raw)
                continue
            if ch == fence_ch and run_len >= fence_len:
                in_code = False
                fence_ch = ""
                fence_len = 0
                out.append(raw)
                continue
        if in_code:
            out.append(raw)
            continue

        new_line, ch = _rewrite_line(raw, macro_re, expansions)
        if ch:
            for c in ch:
                changes.append(Change(i, c.kind, c.detail))
        out.append(new_line)

    new_text = "\n".join(out)
    if had_trailing_nl:
        new_text += "\n"
    return new_text, changes


def _find_unexpandable_macros(text: str, missing_re: re.Pattern[str]) -> list[tuple[int, str]]:
    hits: list[tuple[int, str]] = []
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    in_fence = False
    fence_ch = ""
    fence_len = 0
    for lineno, raw in enumerate(text.splitlines(), start=1):
        fence = raw.lstrip()
        if fence.startswith(_CODE_FENCE_PREFIXES):
            ch = fence[0]
            run_len = 0
            while run_len < len(fence) and fence[run_len] == ch:
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

        ln = strip_inline_code_spans(raw)
        for m in missing_re.finditer(ln):
            hits.append((lineno, m.group(1)))
            if len(hits) >= 50:
                return hits
    return hits


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

    seed = root if root.is_file() else root
    forbidden, expansions = _load_macro_config(seed)

    missing = [m for m in forbidden if m not in expansions]
    missing_re = _compile_macro_re(missing) if missing else None
    macro_re = _compile_macro_re(forbidden)

    changed_files = 0
    total_changes = 0
    needs_changes = False

    for p in files:
        try:
            orig = p.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            print(f"ERROR: failed to read {p}: {exc}", file=sys.stderr)
            return 2

        if missing_re is not None:
            hits = _find_unexpandable_macros(orig, missing_re)
            if hits:
                uniq = sorted({name for _, name in hits})
                print(f"ERROR: missing expansions for forbidden macro(s): {', '.join(uniq)}", file=sys.stderr)
                for lineno, name in hits[:20]:
                    print(f"  - {p}:L{lineno}: \\{name}", file=sys.stderr)
                print("Add latex_macro_hygiene.expansions entries in research_team_config.json, then rerun.", file=sys.stderr)
                return 2

        new, changes = _normalize(orig, macro_re, expansions)
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
        print("[ok] no LaTeX macro expansions needed")
        return 0

    if args.in_place:
        print(f"[ok] fixed {changed_files} file(s), {total_changes} change(s) total")
        return 0

    print(f"[fail] fixes needed: {changed_files} file(s), {total_changes} change(s) total")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
