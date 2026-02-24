#!/usr/bin/env python3
"""
Shared review-output contract helpers for swarm runners and standalone checker.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Optional


REQUIRED_FIRST_LINES = {"VERDICT: READY", "VERDICT: NOT_READY"}
REQUIRED_HEADERS = [
    "## Blockers",
    "## Non-blocking",
    "## Real-research fit",
    "## Robustness & safety",
    "## Specific patch suggestions",
]

_RE_GEMINI_HOOK_PREAMBLE = re.compile(r"^Hook registry initialized with \d+ hook entries\s*$")
_RE_VERDICT_LINE = re.compile(r"^VERDICT: (READY|NOT_READY)\s*$")


def normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def sanitize_contract_text(text: str) -> str:
    raw = normalize_newlines(text)
    lines = raw.splitlines()

    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    cleaned = "\n".join(lines[i:]).rstrip() + "\n"

    cleaned_lines = cleaned.splitlines()
    for j, ln in enumerate(cleaned_lines):
        if _RE_VERDICT_LINE.match(ln.strip()):
            if j > 0:
                cleaned = "\n".join(cleaned_lines[j:]).rstrip() + "\n"
            break

    return cleaned


def sanitize_contract_output(path: Path) -> bool:
    if not path.exists() or not path.is_file():
        return False
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return False
    cleaned = sanitize_contract_text(raw)
    if cleaned != raw:
        path.write_text(cleaned, encoding="utf-8")
        return True
    return False


def sanitize_gemini_output(path: Path) -> bool:
    if not path.exists() or not path.is_file():
        return False
    try:
        raw = normalize_newlines(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return False

    lines = raw.splitlines()
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i < len(lines) and _RE_GEMINI_HOOK_PREAMBLE.match(lines[i]):
        i += 1
        while i < len(lines) and not lines[i].strip():
            i += 1

    cleaned = "\n".join(lines[i:]).rstrip() + "\n"
    cleaned = sanitize_contract_text(cleaned)
    if cleaned != raw:
        path.write_text(cleaned, encoding="utf-8")
        return True
    return False


def check_review_contract_text(text: str) -> list[str]:
    normalized = normalize_newlines(text)
    lines = normalized.splitlines()
    if not lines:
        return ["empty file"]

    first = lines[0].strip()
    errs: list[str] = []
    if first not in REQUIRED_FIRST_LINES:
        errs.append(f"bad first line: {first!r}")
    for h in REQUIRED_HEADERS:
        if h not in normalized:
            errs.append(f"missing header: {h}")
    return errs


def check_review_contract_file(path: Path) -> list[str]:
    if not path.exists() or not path.is_file():
        return [f"missing file: {path}"]
    text = path.read_text(encoding="utf-8", errors="replace")
    return check_review_contract_text(text)


def review_contract_ok(path: Path) -> tuple[bool, list[str]]:
    errs = check_review_contract_file(path)
    return (len(errs) == 0), errs


def first_verdict(path: Path) -> Optional[str]:
    if not path.exists() or not path.is_file():
        return None
    try:
        text = normalize_newlines(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return None
    for ln in text.splitlines():
        s = ln.strip()
        if s in REQUIRED_FIRST_LINES:
            return s
    return None
