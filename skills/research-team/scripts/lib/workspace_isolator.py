"""
workspace_isolator.py — Isolated workspace management for research-team clean-room.

Provides:
  - create_isolated_workspace(): generate a randomised workspace dir under the run dir
  - validate_path_in_workspace(): detect path-traversal attacks
  - generate_workspace_id(): 16-char hex UUID4
"""

from __future__ import annotations

import uuid
from pathlib import Path


def generate_workspace_id() -> str:
    """Return a 16-char hex token (UUID4 prefix) for a member workspace."""
    return uuid.uuid4().hex[:16]


def create_isolated_workspace(run_dir: Path, member_id: str, workspace_id: str) -> Path:
    """
    Create and return an isolated workspace directory.

    Path: <run_dir>/workspaces/<member_id>_<workspace_id>/

    The directory is created with mode 0o700 (owner-only access).
    """
    ws_dir = run_dir / "workspaces" / f"{member_id}_{workspace_id}"
    ws_dir.mkdir(parents=True, exist_ok=True)
    ws_dir.chmod(0o700)
    return ws_dir


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
    """
    Return environment variable overrides that lock a subprocess cwd to *workspace_root*.

    Pass these env overrides as `env=` to subprocess calls to restrict shell execution.
    Currently sets HOME and PWD to the workspace root; combine with cwd=workspace_root
    in subprocess calls for maximum isolation.
    """
    ws = str(workspace_root.resolve())
    return {
        "HOME": ws,
        "PWD": ws,
    }
