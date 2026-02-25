"""M-14a: Log redaction — Python temporary stopgap.

WARNING: This module is a temporary stopgap for Pipeline A (Python orchestrator).
Once log redaction is integrated into the TS trace-jsonl pipeline (Phase 2),
this file MUST be deleted immediately (no buffer period).

Pure function that redacts sensitive patterns from text.
Designed for use in logging pipelines — no async, no side effects.
"""

from __future__ import annotations

import re

_REDACTION_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # API keys: sk-..., key-..., Bearer tokens
    (re.compile(r"\b(sk-)[a-zA-Z0-9]{20,}"), r"\1***"),
    (re.compile(r"\b(key-)[a-zA-Z0-9]{20,}"), r"\1***"),
    (re.compile(r"(Bearer\s+)[a-zA-Z0-9._\-]{20,}", re.IGNORECASE), r"\1***"),
    # Generic long API key patterns
    (re.compile(r"\b(api[_-]?key[=: ]+)[a-zA-Z0-9]{16,}", re.IGNORECASE), r"\1***"),
    # User home directory paths
    (re.compile(r"/Users/[^/\s]+/"), "/Users/<redacted>/"),
    (re.compile(r"/home/[^/\s]+/"), "/home/<redacted>/"),
    (re.compile(r"C:\\Users\\[^\\]+\\", re.IGNORECASE), "C:\\\\Users\\\\<redacted>\\\\"),
]


def redact(text: str) -> str:
    """Redact sensitive patterns from text.

    Args:
        text: Input text (e.g. log message, error message).

    Returns:
        Text with sensitive values replaced by ``***`` or ``<redacted>``.
    """
    result = text
    for pattern, replacement in _REDACTION_PATTERNS:
        result = pattern.sub(replacement, result)
    return result
