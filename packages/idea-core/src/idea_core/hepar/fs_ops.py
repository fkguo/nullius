from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


def atomic_write_text(path: Path, text: str, *, encoding: str = "utf-8") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.tmp-", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding=encoding) as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, path)
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def safe_resolve_under(root: Path, rel: str | Path) -> Path:
    root_resolved = root.resolve(strict=False)

    raw = str(rel).strip()
    if not raw:
        raise ValueError("path must be non-empty")

    parsed = urlparse(raw)
    if parsed.scheme:
        if parsed.scheme != "file":
            raise ValueError(f"unsupported path scheme: {parsed.scheme}")
        if parsed.netloc and parsed.netloc != "localhost":
            raise ValueError("file URI netloc bypass is not allowed")
        raw = unquote(parsed.path)

    candidate_rel = Path(raw)
    if candidate_rel.is_absolute():
        raise ValueError("absolute paths are not allowed")
    if any(part == ".." for part in candidate_rel.parts):
        raise ValueError("path traversal with '..' is not allowed")

    resolved = (root_resolved / candidate_rel).resolve(strict=False)
    try:
        resolved.relative_to(root_resolved)
    except ValueError as exc:
        raise ValueError("resolved path escapes root") from exc
    return resolved


def safe_resolve_file_uri_under(root: Path, artifact_ref: str) -> Path:
    parsed = urlparse(artifact_ref)
    if parsed.scheme != "file":
        raise ValueError(f"unsupported artifact ref scheme: {artifact_ref}")
    if parsed.netloc and parsed.netloc != "localhost":
        raise ValueError("file URI netloc bypass is not allowed")

    absolute = Path(unquote(parsed.path)).resolve(strict=False)
    root_resolved = root.resolve(strict=False)
    try:
        rel = absolute.relative_to(root_resolved)
    except ValueError as exc:
        raise ValueError("artifact path escapes bridge root") from exc
    return safe_resolve_under(root_resolved, rel.as_posix())
