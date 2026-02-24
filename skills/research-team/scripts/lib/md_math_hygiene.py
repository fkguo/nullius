#!/usr/bin/env python3
"""
Shared validator for Markdown math rendering hygiene (domain-neutral).

This is extracted to avoid duplicating the same state machine in:
- scripts/gates/check_markdown_math_hygiene.py
- scripts/gates/check_knowledge_layers.py

The implementation intentionally preserves current gate semantics.
"""

from __future__ import annotations

import re

from pathlib import Path

from md_utils import strip_inline_code_spans


def validate_markdown_math_hygiene(text: str, *, path_for_msgs: str | Path) -> list[str]:
    """
    Validate math formatting hazards in Markdown `text` (outside fenced code blocks).

    Returns:
      list of error strings, each prefixed with "<path>:<line>: ...".
    """
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    path_s = str(path_for_msgs)

    errors: list[str] = []

    # Disallow LaTeX \( \) and \[ \] environments (policy).
    # Allow TeX linebreak spacing like \\[2pt] by only flagging single-backslash \[ and \].
    delim_pat = r"\\\(|\\\)|(?<!\\)\\\[|(?<!\\)\\\]"
    cont_pat = re.compile(r"^\\(?:qquad|quad|times|cdot)\b")

    def _iter_lines() -> list[tuple[int, str]]:
        in_fence = False
        out: list[tuple[int, str]] = []
        for lineno, raw_ln in enumerate(text.splitlines(), start=1):
            if raw_ln.strip().startswith(("```", "~~~")):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            out.append((lineno, strip_inline_code_spans(raw_ln)))
        return out

    lines = _iter_lines()

    # Pass 1: fail-fast on non-standalone $$ markers to avoid state-machine desync.
    # We prefer fenced display math with $$ on its own line for stable rendering across Markdown engines.
    has_inline_dollars = False
    for lineno, ln_nc in lines:
        if re.search(delim_pat, ln_nc):
            for m in re.finditer(delim_pat, ln_nc):
                errors.append(f"{path_s}:{lineno}: disallowed LaTeX math delimiter '{m.group(0)}' (use $...$ or $$...$$)")

        if "$$" in ln_nc and not re.match(r"^\s*\$\$\s*$", ln_nc):
            errors.append(
                f"{path_s}:{lineno}: found '$$' not on its own line. Rewrite as fenced display math with standalone '$$' lines "
                "(policy: prefer `$$` fences for display math; avoid inline `$$ ... $$`)."
            )
            has_inline_dollars = True

    if has_inline_dollars:
        return errors

    # Pass 2: parse fenced $$ blocks and enforce operator/continuation hygiene.
    in_display = False
    prev_nonblank_kind = ""  # "dollar" | "other" | ""
    prev_nonblank_line = 0
    adjacent_prev_fence_line = 0
    expecting_continuation_check = False

    for lineno, ln_nc in lines:
        if re.match(r"^\s*\$\$\s*$", ln_nc):
            if not in_display:
                # Opening fence.
                in_display = True
                expecting_continuation_check = prev_nonblank_kind == "dollar"
                adjacent_prev_fence_line = prev_nonblank_line if expecting_continuation_check else 0
            else:
                # Closing fence.
                in_display = False
                expecting_continuation_check = False
                adjacent_prev_fence_line = 0

            prev_nonblank_kind = "dollar"
            prev_nonblank_line = lineno
            continue

        if ln_nc.strip():
            prev_nonblank_kind = "other"
            prev_nonblank_line = lineno

        if not in_display:
            continue

        s = ln_nc.lstrip()
        if not s:
            continue

        if expecting_continuation_check:
            expecting_continuation_check = False
            if s[0] in ("+", "-", "="):
                errors.append(
                    f"{path_s}:{lineno}: suspected split display equation: '$$' block starts right after a previous '$$' block "
                    f"(prev fence at line {adjacent_prev_fence_line}) and begins with operator '{s[0]}'. "
                    "Merge into a single $$...$$ block."
                )
            else:
                m_cont = cont_pat.match(s)
                if m_cont:
                    tok = m_cont.group(0)
                    errors.append(
                        f"{path_s}:{lineno}: suspected split display equation: '$$' block starts right after a previous '$$' block "
                        f"(prev fence at line {adjacent_prev_fence_line}) and begins with continuation token '{tok}'. "
                        "Merge into a single $$...$$ block."
                    )

        if s[0] in ("+", "-", "="):
            errors.append(
                f"{path_s}:{lineno}: line inside $$...$$ starts with '+', '-', or '=' (Markdown hazard). "
                "Move the operator to the previous line or prefix with '\\quad'."
            )

    if in_display:
        errors.append(f"{path_s}: unterminated $$ display-math block (missing closing '$$').")

    return errors

