from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Optional


ARTIFACT_SCHEMA_VERSION = 1


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def sha256_bytes(data: bytes) -> str:
    h = sha256()
    h.update(data)
    return h.hexdigest()


def sha256_file(path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    h = sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _run_cmd(cmd: list[str], *, cwd: Optional[Path] = None, timeout_s: float = 2.0) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except FileNotFoundError as exc:
        return 127, "", str(exc)
    except subprocess.TimeoutExpired as exc:
        return 124, "", str(exc)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def _find_git_root(start: Path) -> Optional[Path]:
    cur = start.resolve()
    for p in [cur, *cur.parents]:
        if (p / ".git").exists():
            return p
    return None


def get_git_metadata(*, repo_root: Path) -> dict[str, Any]:
    git_root = _find_git_root(repo_root)
    if git_root is None:
        return {"available": False, "error": "no .git found", "repo_root": str(repo_root)}

    meta: dict[str, Any] = {"available": True, "repo_root": str(git_root)}

    rc, out, err = _run_cmd(["git", "rev-parse", "HEAD"], cwd=git_root)
    if rc == 0:
        meta["commit"] = out
    else:
        meta["commit"] = None
        meta["commit_error"] = err or out

    rc, out, err = _run_cmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=git_root)
    if rc == 0:
        meta["branch"] = out
    else:
        meta["branch"] = None
        meta["branch_error"] = err or out

    rc, out, err = _run_cmd(["git", "status", "--porcelain=v1"], cwd=git_root)
    if rc == 0:
        meta["is_dirty"] = bool(out)
    else:
        meta["is_dirty"] = None
        meta["dirty_error"] = err or out

    rc, out, err = _run_cmd(["git", "config", "--get", "remote.origin.url"], cwd=git_root)
    if rc == 0 and out:
        meta["remote_origin_url"] = out
    else:
        meta["remote_origin_url"] = None

    return meta


def get_pip_freeze(*, python_executable: str) -> dict[str, Any]:
    rc, out, err = _run_cmd([python_executable, "-m", "pip", "freeze"], timeout_s=10.0)
    if rc != 0:
        return {"available": False, "error": err or out}
    lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
    return {"available": True, "packages": lines}


def collect_environment(*, include_pip_freeze: bool = True) -> dict[str, Any]:
    env: dict[str, Any] = {
        "python": {
            "executable": sys.executable,
            "version": sys.version.replace("\n", " "),
        },
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python_build": platform.python_build(),
        },
        "process": {
            "pid": os.getpid(),
        },
    }
    if include_pip_freeze:
        env["pip_freeze"] = get_pip_freeze(python_executable=sys.executable)
    return env


@dataclass(frozen=True)
class ArtifactPaths:
    run_dir: Path
    manifest: Path
    summary: Path
    analysis: Path

    @staticmethod
    def in_dir(run_dir: Path) -> "ArtifactPaths":
        run_dir = run_dir.resolve()
        return ArtifactPaths(
            run_dir=run_dir,
            manifest=run_dir / "manifest.json",
            summary=run_dir / "summary.json",
            analysis=run_dir / "analysis.json",
        )
