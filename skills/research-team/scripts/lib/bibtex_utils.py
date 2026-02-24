#!/usr/bin/env python3
from __future__ import annotations

"""
Minimal BibTeX helpers used by deterministic workflows.

Intentionally conservative:
- Do not try to fully parse or reformat BibTeX.
- Provide small, targeted normalization steps that are safe to apply automatically.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class BibtexPatch:
    key: str
    entry_type: str
    start: int
    end: int


def _detect_indent(body: str) -> str:
    for ln in body.splitlines():
        if not ln.strip():
            continue
        if "=" not in ln:
            continue
        return ln[: len(ln) - len(ln.lstrip(" \t"))] or "  "
    return "  "


def _top_level_fields(body: str) -> set[str]:
    fields: set[str] = set()
    depth = 0
    in_quote = False
    i = 0
    while i < len(body):
        ch = body[i]
        if in_quote:
            if ch == '"' and (i == 0 or body[i - 1] != "\\"):
                in_quote = False
            i += 1
            continue

        if ch == '"' and (i == 0 or body[i - 1] != "\\"):
            in_quote = True
            i += 1
            continue

        if ch == "{":
            depth += 1
            i += 1
            continue
        if ch == "}":
            depth = max(0, depth - 1)
            i += 1
            continue
        if depth > 0:
            i += 1
            continue

        if ch in " \t\r\n,":
            i += 1
            continue

        if ch.isalpha() or ch == "_":
            j = i + 1
            while j < len(body) and (body[j].isalnum() or body[j] == "_"):
                j += 1
            name = body[i:j].strip().lower()
            k = j
            while k < len(body) and body[k].isspace():
                k += 1
            if k < len(body) and body[k] == "=":
                fields.add(name)
            i = j
            continue

        i += 1
    return fields


def _find_entry_end(text: str, *, start_after_open: int, open_ch: str, close_ch: str) -> int | None:
    """
    Return the index of the matching close delimiter for a BibTeX entry (the close char itself).
    """
    if open_ch == "{":
        depth = 1
        i = start_after_open
        while i < len(text):
            ch = text[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return i
            i += 1
        return None

    # Paren-delimited entries: ignore ')' inside quotes or curly-brace values.
    depth = 1
    curly = 0
    in_quote = False
    i = start_after_open
    while i < len(text):
        ch = text[i]
        if ch == '"' and (i == 0 or text[i - 1] != "\\"):
            in_quote = not in_quote
            i += 1
            continue
        if ch == "{":
            curly += 1
            i += 1
            continue
        if ch == "}":
            curly = max(0, curly - 1)
            i += 1
            continue
        if not in_quote and curly == 0:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    return None


def _scan_patches_for_missing_article_journal(text: str) -> list[BibtexPatch]:
    patches: list[BibtexPatch] = []
    i = 0
    n = len(text)

    while i < n:
        at = text.find("@", i)
        if at < 0:
            break
        j = at + 1
        while j < n and text[j].isspace():
            j += 1
        t0 = j
        while j < n and text[j].isalpha():
            j += 1
        entry_type = text[t0:j].strip().lower()
        if not entry_type:
            i = at + 1
            continue
        while j < n and text[j].isspace():
            j += 1
        if j >= n or text[j] not in "{(":
            i = at + 1
            continue
        open_ch = text[j]
        close_ch = "}" if open_ch == "{" else ")"
        start_after_open = j + 1
        end_idx = _find_entry_end(text, start_after_open=start_after_open, open_ch=open_ch, close_ch=close_ch)
        if end_idx is None:
            i = at + 1
            continue

        # Parse key up to the first comma.
        k = start_after_open
        while k < end_idx and text[k].isspace():
            k += 1
        key_start = k
        while k < end_idx and text[k] not in ",\r\n\t ":
            k += 1
        key = text[key_start:k].strip()
        comma = text.find(",", k, end_idx)
        if comma < 0:
            i = end_idx + 1
            continue

        body = text[comma + 1 : end_idx]
        if entry_type == "article":
            fields = _top_level_fields(body)
            if "journal" not in fields:
                patches.append(BibtexPatch(key=key or "(unknown)", entry_type=entry_type, start=comma + 1, end=end_idx))

        i = end_idx + 1

    return patches


def _apply_insert_journal_field(body: str) -> str:
    indent = _detect_indent(body)
    if body.startswith("\n"):
        return "\n" + f"{indent}journal = \"\",\n" + body[1:]
    if body.startswith("\r\n"):
        return body[:2] + f"{indent}journal = \"\",\n" + body[2:]
    return "\n" + f"{indent}journal = \"\",\n" + body.lstrip("\r\n")


def normalize_revtex4_2_bibtex(text: str) -> tuple[str, list[BibtexPatch]]:
    """
    Insert `journal=""` for `@article{...}` entries missing a journal field.
    """
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    patches = _scan_patches_for_missing_article_journal(text)
    if not patches:
        return text, []

    out = text
    for p in sorted(patches, key=lambda x: x.start, reverse=True):
        body = out[p.start : p.end]
        fixed = _apply_insert_journal_field(body)
        out = out[: p.start] + fixed + out[p.end :]
    return out, patches

