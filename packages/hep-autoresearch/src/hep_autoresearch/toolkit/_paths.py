from __future__ import annotations

import os
from pathlib import Path


def manifest_cwd(*, repo_root: Path, cwd: Path | None = None) -> str:
    """Return a safe `cwd` string for artifact manifests.

    Default: use a portable `<PROJECT_ROOT>` placeholder (or `<PROJECT_ROOT>/<rel>`).
    Override: set `HEPAR_RECORD_ABS_PATHS=1` to record absolute paths.
    """
    record_abs = os.environ.get("HEPAR_RECORD_ABS_PATHS", "").strip().lower() in {"1", "true", "yes", "y"}
    if record_abs:
        return os.fspath(cwd or repo_root)

    if cwd is None:
        return "<PROJECT_ROOT>"
    try:
        rel = cwd.relative_to(repo_root)
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        return "<PROJECT_ROOT>"
    if str(rel) in {"", "."}:
        return "<PROJECT_ROOT>"
    return f"<PROJECT_ROOT>/{rel.as_posix()}"
