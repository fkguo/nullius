from __future__ import annotations

import os
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from .project_policy import (
    PROJECT_POLICY_REAL_PROJECT,
    assert_path_within_project,
    assert_project_root_allowed,
)
from .project_surface import (
    BOUNDARY_NAMING_AUDIT,
    SCAFFOLD_CONTEXT_FILES,
    SCAFFOLD_ROOT_FILES,
    SCAFFOLD_SUPPORT_FILES,
    SCAFFOLD_TEMPLATE_MAP,
    SCAFFOLD_TEMPLATE_FILES,
)
from .research_contract import sync_research_contract
from .scaffold_template_loader import load_scaffold_template


def _safe_rel(repo_root: Path, path: Path) -> str:
    try:
        return os.fspath(path.relative_to(repo_root)).replace(os.sep, "/")
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        return os.fspath(path)


def _write_text_if_missing(*, repo_root: Path, path: Path, text: str, created: list[str], skipped: list[str], force: bool) -> None:
    rel = _safe_rel(repo_root, path)
    if path.exists() and not force:
        skipped.append(rel)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")
    created.append(rel)


def _render_template(name: str, *, project_name: str, project_root: Path, profile: str) -> str:
    today = date.today().isoformat()
    text = load_scaffold_template(name)
    return (
        text.replace("<PROJECT_NAME>", project_name)
        .replace("<PROJECT_ROOT>", os.fspath(project_root))
        .replace("<PROFILE>", profile or "mixed")
        .replace("<YYYY-MM-DD>", today)
    )


def _managed_scaffold_text(rel: str, *, project: str, repo_root: Path, profile: str) -> str:
    rendered = _render_template(
        SCAFFOLD_TEMPLATE_MAP[rel],
        project_name=project,
        project_root=repo_root,
        profile=profile,
    )
    return rendered.rstrip() + "\n"


def _refresh_project_scaffold(
    *,
    repo_root: Path,
    project: str,
    profile: str,
    dry_run: bool,
) -> dict[str, Any]:
    """Re-apply the managed scaffold boilerplate, never touching user seed files.

    Managed support files are re-rendered from the current templates; a changed
    file's prior content is backed up before it is overwritten. Seed (user-owned)
    files are reported but never written. ``sync_research_contract`` is deliberately
    not run here: notebook->contract sync is a plain-init concern and would write a
    seed file. The pass is non-transactional but recoverable via the backup copy.
    """
    # Seed (user-owned) files: status only, never written by refresh.
    preserved: list[str] = []
    missing_seed: list[str] = []
    for rel in SCAFFOLD_ROOT_FILES:
        (preserved if (repo_root / rel).exists() else missing_seed).append(rel)

    # Preflight-render every managed file first (deterministic; cannot fail), so a
    # later write failure cannot leave a half-rendered file on disk.
    rendered = {
        rel: _managed_scaffold_text(rel, project=project, repo_root=repo_root, profile=profile)
        for rel in SCAFFOLD_SUPPORT_FILES
    }

    # Microsecond precision so two refreshes in the same second cannot share a
    # backup directory and clobber an earlier managed-file backup.
    backup_stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
    backup_root = repo_root / ".autoresearch" / "backups" / backup_stamp

    created: list[str] = []
    refreshed: list[str] = []
    backed_up: list[str] = []
    unchanged: list[str] = []

    for rel in SCAFFOLD_SUPPORT_FILES:
        path = repo_root / rel
        new_text = rendered[rel]
        if not path.exists():
            if not dry_run:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(new_text, encoding="utf-8")
            created.append(rel)
            continue
        # Read raw bytes so the backup is byte-exact even if a managed file was
        # replaced with non-UTF-8 content; decode only for the change comparison.
        old_bytes = path.read_bytes()
        if old_bytes.decode("utf-8", errors="replace") == new_text:
            unchanged.append(rel)
            continue
        if not dry_run:
            backup_path = backup_root / rel
            assert_path_within_project(backup_path, project_root=repo_root, label="scaffold backup")
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            backup_path.write_bytes(old_bytes)
            path.write_text(new_text, encoding="utf-8")
        refreshed.append(rel)
        backed_up.append(rel)

    backup_dir = _safe_rel(repo_root, backup_root) if backed_up and not dry_run else None

    return {
        "created": sorted(dict.fromkeys(created)),
        "skipped": [],
        "refreshed": sorted(dict.fromkeys(refreshed)),
        "backed_up": sorted(dict.fromkeys(backed_up)),
        "unchanged": sorted(dict.fromkeys(unchanged)),
        "preserved": sorted(dict.fromkeys(preserved)),
        "missing": sorted(dict.fromkeys(missing_seed)),
        "backup_dir": backup_dir,
        "dry_run": dry_run,
        "context_files": list(SCAFFOLD_CONTEXT_FILES),
        "naming_audit": [decision.__dict__ for decision in BOUNDARY_NAMING_AUDIT],
        "scaffold": "canonical",
    }


def ensure_project_scaffold(
    *,
    repo_root: Path,
    project_name: str | None = None,
    profile: str | None = None,
    force: bool = False,
    refresh: bool = False,
    dry_run: bool = False,
    project_policy: str | None = PROJECT_POLICY_REAL_PROJECT,
) -> dict[str, Any]:
    if force and refresh:
        raise ValueError("force and refresh are mutually exclusive")
    if dry_run and not refresh:
        raise ValueError("dry_run is only valid together with refresh")

    repo_root = repo_root.expanduser().resolve()
    assert_project_root_allowed(repo_root, project_policy=project_policy)

    project = (project_name or repo_root.name or "Research Project").strip() or "Research Project"
    profile_name = (profile or "mixed").strip() or "mixed"

    if refresh:
        return _refresh_project_scaffold(
            repo_root=repo_root,
            project=project,
            profile=profile_name,
            dry_run=dry_run,
        )

    created: list[str] = []
    skipped: list[str] = []

    scaffold_dirs = ["artifacts/runs", "docs"]
    for rel in scaffold_dirs:
        (repo_root / rel).mkdir(parents=True, exist_ok=True)

    for rel in SCAFFOLD_TEMPLATE_FILES:
        _write_text_if_missing(
            repo_root=repo_root,
            path=repo_root / rel,
            text=_render_template(
                SCAFFOLD_TEMPLATE_MAP[rel],
                project_name=project,
                project_root=repo_root,
                profile=profile_name,
            ),
            created=created,
            skipped=skipped,
            force=force,
        )

    sync_research_contract(repo_root=repo_root, create_missing=False, project_policy=project_policy)
    return {
        "created": sorted(dict.fromkeys(created)),
        "skipped": sorted(dict.fromkeys(skipped)),
        "context_files": list(SCAFFOLD_CONTEXT_FILES),
        "naming_audit": [decision.__dict__ for decision in BOUNDARY_NAMING_AUDIT],
        "scaffold": "canonical",
    }
