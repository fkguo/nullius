from __future__ import annotations

import subprocess
from pathlib import Path


def try_get_git_metadata(repo_root: Path) -> dict | None:
    try:
        commit = (
            subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo_root, stderr=subprocess.DEVNULL)
            .decode("utf-8", "replace")
            .strip()
        )
        dirty = (
            subprocess.check_output(["git", "status", "--porcelain"], cwd=repo_root, stderr=subprocess.DEVNULL)
            .decode("utf-8", "replace")
            .strip()
            != ""
        )
        return {"commit": commit, "dirty": dirty}
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort optional read
        return None
