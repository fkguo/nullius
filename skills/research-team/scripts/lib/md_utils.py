#!/usr/bin/env python3
"""
Shared Markdown utilities for deterministic gates and autofix helpers.

Intentionally small and boring:
- File iteration for Markdown targets
- Inline code span parsing (variable-length backticks)

Design goals:
- Preserve existing behavior of the duplicated implementations.
- Avoid adding new policy or changing gate semantics.
"""

from __future__ import annotations

import fnmatch
from pathlib import Path


def iter_md_files_under(root: Path) -> list[Path]:
    """
    Return Markdown files under `root`.

    Behavior matches the previous duplicated `_iter_md_files()` helpers:
    - If `root` is a file: return `[root]` (caller decides whether to skip non-md).
    - If `root` is a directory: recursive scan for *.md and *.markdown
    - Skip any paths under a `.git/` directory
    - Sorted deterministically
    """
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


def iter_md_files_by_targets(root: Path, targets: list[str], exclude_globs: list[str]) -> tuple[list[Path], list[str]]:
    """
    Resolve a deterministic list of Markdown files from `targets` (paths/globs relative to `root`).

    Returns:
      (files, missing_targets)

    Matching semantics:
    - For exclusion, we `fnmatch` against repo-relative POSIX paths.
    - Targets may be concrete paths or globs.
    """
    missing: list[str] = []
    found: set[Path] = set()

    def _add_path(p: Path) -> None:
        if p.is_dir():
            for q in p.rglob("*.md"):
                if ".git" in q.parts:
                    continue
                found.add(q)
            for q in p.rglob("*.markdown"):
                if ".git" in q.parts:
                    continue
                found.add(q)
            return
        if p.is_file() and p.suffix.lower() in (".md", ".markdown"):
            found.add(p)

    for t in targets:
        t = str(t).strip()
        if not t:
            continue

        is_glob = any(ch in t for ch in "*?[]")
        if is_glob:
            for p in root.glob(t):
                _add_path(p)
            continue

        p = root / t
        if not p.exists():
            missing.append(t)
            continue
        _add_path(p)

    # Apply excludes (match against repo-relative POSIX paths).
    out: list[Path] = []
    for p in found:
        try:
            rel = p.resolve().relative_to(root.resolve()).as_posix()
        except Exception:
            rel = p.as_posix()
        if any(fnmatch.fnmatch(rel, pat) for pat in exclude_globs):
            continue
        out.append(p)

    return sorted(out, key=lambda x: x.as_posix()), missing


def iter_inline_code_spans(line: str) -> list[tuple[int, int, str, str]]:
    """
    Return (start, end, content, delim) for inline code spans, supporting variable-length backtick delimiters.

    Notes / limitations (preserved from the prior duplicated implementations):
    - Does not attempt to interpret escaped backticks (\\`) or HTML entities.
    - Unclosed spans are ignored (treated as normal text).
    """
    spans: list[tuple[int, int, str, str]] = []
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
                spans.append((i, r, line[j:k], delim))
                i = r
                break
            k = r
        else:
            i = j
    return spans


def strip_inline_code_spans(line: str) -> str:
    spans = iter_inline_code_spans(line)
    if not spans:
        return line
    out: list[str] = []
    last = 0
    for a, b, _, __ in spans:
        out.append(line[last:a])
        last = b
    out.append(line[last:])
    return "".join(out)

