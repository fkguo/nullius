"""Workspace snapshot + path helpers for research-team clean-room runs."""

from __future__ import annotations

import os
import shutil
import uuid
from pathlib import Path

_IGNORED_NAMES = {
    ".git",
    ".DS_Store",
    ".idea",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "team",  # default scaffold out-dir; custom out-dir roots are excluded via excluded_root
    "venv",
}


def _copy_tree_filtered(
    src_root: Path,
    dst_root: Path,
    *,
    safe_tag: str = "",
    excluded_root: str = "",
    skip_snapshot_noise: bool = False,
    replace: bool = False,
) -> None:
    src_root = src_root.resolve()
    dst_root = dst_root.resolve()
    if replace and dst_root.exists():
        shutil.rmtree(dst_root)
    dst_root.mkdir(parents=True, exist_ok=True)
    for root_s, dirnames, filenames in os.walk(src_root, topdown=True, followlinks=False):
        root = Path(root_s)
        rel_dir = "" if root == src_root else root.relative_to(src_root).as_posix()
        if skip_snapshot_noise:
            kept_dirs: list[str] = []
            for name in dirnames:
                child = root / name
                if child.is_symlink():
                    continue
                if not rel_dir and excluded_root and name == excluded_root:
                    continue
                if name in _IGNORED_NAMES or name.endswith(".egg-info"):
                    continue
                if safe_tag and rel_dir == f"artifacts/{safe_tag}" and name in {"member_a", "member_b"}:
                    continue
                kept_dirs.append(name)
            dirnames[:] = kept_dirs
        else:
            dirnames[:] = [name for name in dirnames if not (root / name).is_symlink()]
        dest_dir = dst_root if not rel_dir else dst_root / rel_dir
        dest_dir.mkdir(parents=True, exist_ok=True)
        for name in filenames:
            src = root / name
            if src.is_symlink():
                continue
            if skip_snapshot_noise and (name in _IGNORED_NAMES or name.endswith((".pyc", ".pyo"))):
                continue
            dst = dest_dir / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)


def generate_workspace_id() -> str:
    """Return a 16-char hex token (UUID4 prefix) for a member workspace."""
    return uuid.uuid4().hex[:16]


def create_isolated_workspace(
    run_dir: Path,
    member_id: str,
    workspace_id: str,
    project_root: Path | None = None,
    safe_tag: str = "",
) -> Path:
    """Create a member workspace, optionally populated with a filtered project snapshot."""
    ws_dir = run_dir / "workspaces" / f"{member_id}_{workspace_id}"
    ws_dir.mkdir(parents=True, exist_ok=True)
    if project_root is not None and project_root.is_dir():
        excluded_root = ""
        try:
            excluded_root = run_dir.resolve().relative_to(project_root.resolve()).parts[0]
        except Exception:
            excluded_root = ""
        _copy_tree_filtered(
            project_root,
            ws_dir,
            safe_tag=safe_tag,
            excluded_root=excluded_root,
            skip_snapshot_noise=True,
        )
    ws_dir.chmod(0o700)
    return ws_dir


def logical_project_relpath(path: Path, workspace_root: Path, project_root: Path) -> str:
    """Return the stable project-relative path for a workspace-resolved path."""
    resolved = path.resolve()
    try:
        return resolved.relative_to(workspace_root.resolve()).as_posix()
    except Exception:
        try:
            return resolved.relative_to(project_root.resolve()).as_posix()
        except Exception:
            return str(resolved)


def project_path_from_workspace(path: Path, workspace_root: Path, project_root: Path) -> Path:
    """Map a workspace path back onto the real project tree."""
    rel = path.resolve().relative_to(workspace_root.resolve())
    return (project_root.resolve() / rel).resolve()


def sync_workspace_path(
    path: Path,
    workspace_root: Path,
    project_root: Path,
    *,
    replace_tree: bool = False,
) -> Path:
    """Copy a workspace path back into the real project tree, skipping symlinks."""
    src = path.resolve()
    dst = project_path_from_workspace(src, workspace_root, project_root)
    if src.is_dir():
        _copy_tree_filtered(src, dst, replace=replace_tree)
        return dst
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return dst


def validate_path_in_workspace(user_path: str, workspace_root: Path) -> tuple[bool, str]:
    """
    Check that *user_path* resolves within *workspace_root*.

    Returns (ok: bool, reason: str). ok=False means path traversal detected.

    Detects:
      - Absolute paths outside workspace root
      - Relative paths with '../../' components that escape the workspace
      - Symlinks that point outside the workspace root (best-effort)
    """
    try:
        # Resolve relative to workspace root.
        if Path(user_path).is_absolute():
            resolved = Path(user_path).resolve()
        else:
            resolved = (workspace_root / user_path).resolve()
        workspace_root_resolved = workspace_root.resolve()
        resolved.relative_to(workspace_root_resolved)  # raises ValueError if outside
        return True, ""
    except ValueError:
        return False, f"path traversal detected: {user_path!r} escapes workspace {workspace_root}"
    except Exception as exc:
        return False, f"path validation error: {exc}"


def lock_shell_cwd(workspace_root: Path) -> dict[str, str]:
    """Return env overrides that lock subprocess cwd to *workspace_root*."""
    ws = str(workspace_root.resolve())
    return {
        "HOME": ws,
        "PWD": ws,
    }
