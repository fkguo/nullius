#!/usr/bin/env python3
"""
Shared review-output contract helpers for swarm runners and standalone checker.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional


# --- Markdown contract constants ---
REQUIRED_FIRST_LINES = {"VERDICT: READY", "VERDICT: NOT_READY"}
REQUIRED_HEADERS = [
    "## Blockers",
    "## Non-blocking",
    "## Real-research fit",
    "## Robustness & safety",
    "## Specific patch suggestions",
]

# Optional headers recognized by the contract but not required.
# Reviews that include these get proper parsing.
OPTIONAL_HEADERS = [
    "## Methodology",
]

# --- JSON contract constants ---
JSON_REQUIRED_FIELDS = {"blocking_issues", "verdict", "summary"}
JSON_VALID_VERDICTS = {"PASS", "FAIL"}

_RE_GEMINI_HOOK_PREAMBLE = re.compile(r"^Hook registry initialized with \d+ hook entries\s*$")
_RE_GEMINI_STARTUP_LINES = [
    _RE_GEMINI_HOOK_PREAMBLE,
    re.compile(r"^MCP issues detected\. Run /mcp list for status\.\s*$"),
    re.compile(r"^Registering notification handlers for server '.*'\. Capabilities: .*$"),
    re.compile(r"^(completions|resources|tools): .*$"),
    re.compile(r"^\}$"),
    re.compile(
        r"^Server '.*' has tools but did not declare 'listChanged' capability\. Listening anyway for robustness\.\.\.\s*$"
    ),
    re.compile(
        r"^Server '.*' has resources but did not declare 'listChanged' capability\. Listening anyway for robustness\.\.\.\s*$"
    ),
    re.compile(
        r"^Server '.*' has prompts but did not declare 'listChanged' capability\. Listening anyway for robustness\.\.\.\s*$"
    ),
    re.compile(r"^Server '.*' supports tool updates\. Listening for changes\.\.\.\s*$"),
    re.compile(r"^Server '.*' supports resource updates\. Listening for changes\.\.\.\s*$"),
    re.compile(r"^Scheduling MCP context refresh\.\.\.\s*$"),
    re.compile(r"^Executing MCP context refresh\.\.\.\s*$"),
    re.compile(r"^MCP context refresh complete\.\s*$"),
]
_RE_VERDICT_LINE = re.compile(r"^VERDICT: (READY|NOT_READY)\s*$")


def normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _detect_format(text: str) -> str:
    """Detect if output is markdown contract or JSON contract."""
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("```"):
        return "json"
    return "markdown"


def strip_markdown_fences(text: str) -> str:
    """Strip leading ```json/``` and trailing ``` if present."""
    stripped = text.strip()
    if stripped.startswith("```"):
        first_nl = stripped.index("\n") if "\n" in stripped else len(stripped)
        stripped = stripped[first_nl + 1:]
    if stripped.rstrip().endswith("```"):
        stripped = stripped.rstrip()[:-3]
    return stripped.strip()


def check_json_review_contract_text(text: str) -> list[str]:
    """Validate JSON review output contract."""
    errs: list[str] = []
    try:
        obj = json.loads(strip_markdown_fences(text))
    except (json.JSONDecodeError, ValueError) as e:
        return [f"invalid JSON: {e}"]
    if not isinstance(obj, dict):
        return ["JSON root must be an object"]
    for field in sorted(JSON_REQUIRED_FIELDS):
        if field not in obj:
            errs.append(f"missing field: {field}")
    verdict = obj.get("verdict")
    if isinstance(verdict, str) and verdict not in JSON_VALID_VERDICTS:
        errs.append(f"bad verdict: {verdict!r} (expected PASS or FAIL)")
    if "blocking_issues" in obj and not isinstance(obj["blocking_issues"], list):
        errs.append("blocking_issues must be an array")
    return errs


def sanitize_contract_text(text: str) -> str:
    raw = normalize_newlines(text)
    lines = raw.splitlines()

    # Strip leading blank lines
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    cleaned = "\n".join(lines[i:]).rstrip() + "\n"

    # Auto-detect format
    fmt = _detect_format(cleaned)
    if fmt == "json":
        inner = strip_markdown_fences(cleaned)
        return inner.rstrip() + "\n"

    # Markdown: find VERDICT line and truncate preamble
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
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if any(pattern.match(line) for pattern in _RE_GEMINI_STARTUP_LINES):
            i += 1
            continue
        break

    cleaned = "\n".join(lines[i:]).rstrip() + "\n"
    cleaned = sanitize_contract_text(cleaned)
    if cleaned != raw:
        path.write_text(cleaned, encoding="utf-8")
        return True
    return False


def check_review_contract_text(text: str) -> list[str]:
    normalized = normalize_newlines(text)
    fmt = _detect_format(normalized)
    if fmt == "json":
        return check_json_review_contract_text(normalized)

    # Markdown contract
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

    # Try JSON format first
    fmt = _detect_format(text)
    if fmt == "json":
        try:
            obj = json.loads(strip_markdown_fences(text))
            if isinstance(obj, dict) and isinstance(obj.get("verdict"), str):
                v = obj["verdict"]
                return f"VERDICT: {'READY' if v == 'PASS' else 'NOT_READY'}"
        except (json.JSONDecodeError, ValueError):
            pass

    # Markdown fallback
    for ln in text.splitlines():
        s = ln.strip()
        if s in REQUIRED_FIRST_LINES:
            return s
    return None
