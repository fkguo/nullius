from __future__ import annotations

import os
from datetime import date
from pathlib import Path
from typing import Any

from .project_policy import (
    PROJECT_POLICY_REAL_PROJECT,
    assert_project_root_allowed,
)
from .project_surface import (
    BOUNDARY_NAMING_AUDIT,
    SCAFFOLD_CONTEXT_FILES,
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


def ensure_project_scaffold(
    *,
    repo_root: Path,
    project_name: str | None = None,
    profile: str | None = None,
    force: bool = False,
    project_policy: str | None = PROJECT_POLICY_REAL_PROJECT,
) -> dict[str, Any]:
    repo_root = repo_root.expanduser().resolve()
    assert_project_root_allowed(repo_root, project_policy=project_policy)

    created: list[str] = []
    skipped: list[str] = []
    project = (project_name or repo_root.name or "Research Project").strip() or "Research Project"
    profile_name = (profile or "mixed").strip() or "mixed"

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
