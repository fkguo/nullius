"""Exact-byte, project-root-bounded JSON artifact resolution."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from literature_identity_keys import PINNED_PROJECT_REF_RE


def resolve_pinned_project_json(
    ref: object,
    project_root: Path,
    label: str,
    errors: list[str],
) -> tuple[dict[str, Any] | None, Path | None]:
    if not isinstance(ref, str) or not PINNED_PROJECT_REF_RE.fullmatch(ref):
        errors.append(f"{label} must be project://<project-relative path>#sha256:<64 lowercase hex>")
        return None, None
    match = PINNED_PROJECT_REF_RE.fullmatch(ref)
    assert match is not None
    if not re.fullmatch(r"[A-Za-z0-9._~%/-]+", match.group("path")):
        errors.append(f"{label} path must use canonical percent-encoding")
        return None, None
    rel_text = unquote(match.group("path"))
    parts = rel_text.split("/")
    if "\\" in rel_text or any(part in {"", ".", ".."} for part in parts):
        errors.append(f"{label} path escapes or is not canonical: {rel_text!r}")
        return None, None
    root = project_root.resolve()
    path = project_root.joinpath(*parts)
    try:
        resolved = path.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, ValueError):
        errors.append(f"{label} does not resolve inside project root: {path}")
        return None, None
    if not resolved.is_file():
        errors.append(f"{label} target is not a file: {resolved}")
        return None, None
    try:
        payload = resolved.read_bytes()
    except OSError as exc:
        errors.append(f"{label} cannot be read: {exc}")
        return None, None
    actual = hashlib.sha256(payload).hexdigest()
    if actual != match.group("digest"):
        errors.append(
            f"{label} pin does not match exact artifact bytes: expected sha256:{match.group('digest')}, "
            f"got sha256:{actual}"
        )
        return None, resolved
    try:
        document = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        errors.append(f"{label} must contain UTF-8 JSON: {exc}")
        return None, resolved
    if not isinstance(document, dict):
        errors.append(f"{label} JSON must be an object")
        return None, resolved
    return document, resolved
