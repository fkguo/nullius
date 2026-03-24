from __future__ import annotations

import fnmatch
import pathlib
import shutil
import subprocess
from typing import Sequence

DEFAULT_EXCLUDES = {
    ".git",
    ".git/**",
    "**/.git/**",
    "tests/**",
    "test/**",
    "**/.pytest_cache/**",
    "**/__pycache__/**",
    "**/*.pyc",
    "**/.DS_Store",
}


def run_checked(cmd: Sequence[str], *, cwd: pathlib.Path | None = None) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        list(cmd),
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "command failed:\n"
            f"$ {' '.join(cmd)}\n"
            f"exit={proc.returncode}\n"
            f"stdout:\n{proc.stdout}\n"
            f"stderr:\n{proc.stderr}"
        )
    return proc


def git_head(repo_path: pathlib.Path) -> str | None:
    try:
        return run_checked(["git", "-C", str(repo_path), "rev-parse", "HEAD"]).stdout.strip() or None
    except RuntimeError:
        return None


def clone_source_repo(repo: str, ref: str, temp_dir: pathlib.Path) -> pathlib.Path:
    clone_dir = temp_dir / f"{repo.replace('/', '__')}@{ref}"
    if clone_dir.exists():
        return clone_dir
    clone_dir.parent.mkdir(parents=True, exist_ok=True)
    try:
        run_checked(["git", "clone", "--depth", "1", "--branch", ref, f"https://github.com/{repo}.git", str(clone_dir)])
    except RuntimeError:
        run_checked(["git", "clone", f"https://github.com/{repo}.git", str(clone_dir)])
        run_checked(["git", "-C", str(clone_dir), "checkout", ref])
    return clone_dir


def collect_payload_files(source_dir: pathlib.Path, include: list[str], exclude: list[str]) -> list[pathlib.Path]:
    if not source_dir.is_dir():
        raise RuntimeError(f"source subpath does not exist: {source_dir}")
    source_root = source_dir.resolve()
    selected: set[pathlib.Path] = set()
    for pattern in include:
        for match in source_dir.glob(pattern):
            if match.is_symlink():
                continue
            if match.is_file():
                selected.add(match)
            elif match.is_dir():
                selected.update(
                    child for child in match.rglob("*") if child.is_file() and not child.is_symlink()
                )

    if not selected:
        raise RuntimeError(f"include patterns matched no files under {source_dir}")

    excluded_patterns = list(DEFAULT_EXCLUDES) + exclude

    def is_excluded(rel_path: pathlib.PurePosixPath) -> bool:
        rel = rel_path.as_posix()
        for pattern in excluded_patterns:
            if rel_path.match(pattern) or fnmatch.fnmatch(rel, pattern):
                return True
            if pattern.endswith("/**"):
                prefix = pattern[:-3].rstrip("/")
                if rel == prefix or rel.startswith(prefix + "/"):
                    return True
        return False

    final_files: list[pathlib.Path] = []
    for file_path in sorted(selected):
        try:
            file_path.resolve().relative_to(source_root)
        except Exception as exc:
            raise RuntimeError(f"include pattern resolved outside source root: {file_path}") from exc
        rel_path = pathlib.PurePosixPath(file_path.relative_to(source_dir).as_posix())
        if not is_excluded(rel_path):
            final_files.append(file_path)

    if not any(file_path.relative_to(source_dir).as_posix() == "SKILL.md" for file_path in final_files):
        raise RuntimeError("payload must include SKILL.md")
    return final_files


def safe_remove(path: pathlib.Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
        return
    if path.is_dir():
        shutil.rmtree(path)
