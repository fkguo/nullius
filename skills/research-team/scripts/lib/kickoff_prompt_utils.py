#!/usr/bin/env python3
"""
Small shared helpers for the kickoff prompt feature (PROJECT_START_PROMPT.md).
"""

from __future__ import annotations

import re


def looks_approved(text: str, marker: str, *, max_lines: int = 30) -> bool:
    """
    Return True if `marker` is present as an "approval line" near the top of the file.

    Robustness:
    - Case-insensitive
    - Ignores trailing '#' comments on the approval line
    - Only scans the first `max_lines` lines (keeps the check deterministic and fast)
    """

    def _norm(s: str) -> str:
        s = (s or "").strip()
        # Allow the status line to be formatted as a Markdown heading (e.g. "# Status: APPROVED").
        s = s.lstrip("#").strip()
        s = s.lower()
        # Strip trailing comments but keep headings like "# Status: ...".
        s = re.sub(r"\s+#.*$", "", s).strip()
        # Normalize colon spacing ("Status:APPROVED" == "Status: APPROVED").
        s = re.sub(r"\s*:\s*", ":", s)
        s = re.sub(r"\s+", " ", s)
        return s

    want = _norm(marker)
    if not want:
        return False

    in_fence = False
    fence_marker = ""
    in_html_comment = False
    for ln in text.splitlines()[:max_lines]:
        stripped = ln.strip()
        # Ignore fenced code blocks near the top to avoid accidental "approval-by-example".
        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker_token = "```" if stripped.startswith("```") else "~~~"
            if not in_fence:
                in_fence = True
                fence_marker = marker_token
                continue
            if marker_token == fence_marker:
                in_fence = False
                fence_marker = ""
                continue
        if in_fence:
            continue
        # Ignore HTML comments (including multi-line).
        if not in_html_comment and "<!--" in ln:
            in_html_comment = True
        if in_html_comment:
            if "-->" in ln:
                in_html_comment = False
            continue
        if _norm(ln) == want:
            return True
    return False
