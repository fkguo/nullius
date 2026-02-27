"""
text_utils.py — Pure text/string utility functions for idea-core engine.

Extracted from IdeaCoreService for reuse across coordinator modules.
"""

from __future__ import annotations

import re
from typing import Any, Iterable


def sanitize_text(value: Any, fallback: str) -> str:
    if not isinstance(value, str):
        return fallback
    compact = " ".join(value.split())
    return compact if compact else fallback


def sanitize_text_list(value: Any, fallback: list[str]) -> list[str]:
    if not isinstance(value, list):
        return fallback
    cleaned: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        compact = " ".join(item.split())
        if compact:
            cleaned.append(compact)
    return cleaned or fallback


def dedupe_preserve_order(values: Iterable[str]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        deduped.append(value)
    return deduped


def token_set(text: str) -> set[str]:
    tokens: set[str] = set()
    for raw in text.lower().split():
        token = "".join(ch for ch in raw if ch.isalnum())
        if len(token) >= 3:
            tokens.add(token)
    return tokens


def contains_any(text: str, keywords: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return any(keyword in lowered for keyword in keywords)


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def contains_unit_token(text: str, units: tuple[str, ...]) -> bool:
    lowered = text.lower()
    pattern = r"\b(?:" + "|".join(re.escape(unit) for unit in units) + r")\b"
    return re.search(pattern, lowered) is not None
