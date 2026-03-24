from __future__ import annotations

import datetime as dt
import json
import pathlib
import re
from typing import Any

ALLOWED_PLATFORMS = {"claude_code", "codex", "opencode"}
RE_VERSION = re.compile(r"^(v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.]+)?|schemas-v[0-9]+\.[0-9]+\.[0-9]+)$")
RE_INDEX_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
RE_PACKAGE_ID = re.compile(r"^[A-Za-z0-9_.-]+$")
RE_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
RE_RANGE = re.compile(r"^>=?[0-9]+\.[0-9]+\.[0-9]+(?:\s+<[=]?[0-9]+\.[0-9]+\.[0-9]+)?$")
RE_SEMVER = re.compile(r"^(?:schemas-)?v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+][A-Za-z0-9.]+)?$")
RE_NON_PORTABLE_SOURCE = re.compile(r"^(?:/Users/|/home/|[A-Za-z]:\\Users\\)")
RE_SKILL_SOURCE_PATH = re.compile(r"^~/\.codex/skills/[A-Za-z0-9_.-]+/SKILL\.md$")
RE_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")
RE_SOURCE_REF = re.compile(r"^(?!/)(?!.*\.\.)(?!.*//)[A-Za-z0-9._/-]+$")


def load_json(path: pathlib.Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Invalid JSON: {path}: {exc}") from exc


def parse_timestamp(value: str) -> dt.datetime | None:
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def parse_semver(value: str) -> tuple[int, int, int] | None:
    match = RE_SEMVER.fullmatch(value)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def parse_bound(token: str) -> tuple[str, tuple[int, int, int]] | None:
    for op in (">=", ">", "<=", "<"):
        if token.startswith(op):
            parsed = parse_semver(token[len(op) :])
            if parsed is not None:
                return op, parsed
    return None


def satisfies_range(version: str, dep_range: str) -> bool | None:
    parsed = parse_semver(version)
    if parsed is None:
        return None
    for token in dep_range.split():
        bound = parse_bound(token)
        if bound is None:
            return None
        op, edge = bound
        if op == ">=" and not (parsed >= edge):
            return False
        if op == ">" and not (parsed > edge):
            return False
        if op == "<=" and not (parsed <= edge):
            return False
        if op == "<" and not (parsed < edge):
            return False
    return True


def is_safe_relative_path(value: str) -> bool:
    text = value.strip()
    if not text:
        return False
    if text.startswith("/") or text.startswith("\\") or RE_WINDOWS_DRIVE.match(text):
        return False
    if "\\" in text:
        return False
    return ".." not in pathlib.PurePosixPath(text).parts


def is_safe_glob_pattern(value: str) -> bool:
    text = value.strip()
    return is_safe_relative_path(text) and "//" not in text
