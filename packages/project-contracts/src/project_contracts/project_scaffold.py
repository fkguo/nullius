from __future__ import annotations

import json
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
    FULL_TEMPLATE_FILES,
    MCP_CONFIG_EXAMPLE,
    MINIMAL_CONTEXT_FILES,
    MINIMAL_TEMPLATE_FILES,
    SCAFFOLD_TEMPLATE_MAP,
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


def _load_plan_schema_template() -> dict[str, Any]:
    candidates: list[Path] = []
    pkg_root = Path(__file__).resolve().parent
    candidates.append(pkg_root / "specs" / "plan.schema.json")
    for parent in list(Path(__file__).resolve().parents)[:8]:
        candidates.append(parent / "specs" / "plan.schema.json")
    for candidate in candidates:
        if candidate.is_file():
            raw = json.loads(candidate.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and raw:
                return raw
    raise FileNotFoundError("plan schema template not found (expected specs/plan.schema.json in install tree)")


def ensure_project_scaffold(
    *,
    repo_root: Path,
    project_name: str | None = None,
    profile: str | None = None,
    variant: str = "minimal",
    force: bool = False,
    project_policy: str | None = PROJECT_POLICY_REAL_PROJECT,
) -> dict[str, Any]:
    repo_root = repo_root.expanduser().resolve()
    assert_project_root_allowed(repo_root, project_policy=project_policy)
    if variant not in {"minimal", "full"}:
        raise ValueError(f"invalid scaffold variant: {variant}")

    created: list[str] = []
    skipped: list[str] = []
    project = (project_name or repo_root.name or "Research Project").strip() or "Research Project"
    profile_name = (profile or "mixed").strip() or "mixed"

    for rel in ("artifacts/runs", "docs", "specs"):
        (repo_root / rel).mkdir(parents=True, exist_ok=True)

    template_files = FULL_TEMPLATE_FILES if variant == "full" else MINIMAL_TEMPLATE_FILES
    for rel in template_files:
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
    mcp_path = repo_root / MCP_CONFIG_EXAMPLE
    if not mcp_path.exists() or force:
        mcp_path.write_text(
            json.dumps(
                {
                    "_comment": "Copy this file to .mcp.json and replace the placeholder entry with the provider-local MCP server(s) your project actually uses.",
                    "mcpServers": {
                        "example-provider": {
                            "command": "node",
                            "args": ["<path-to-provider-entrypoint.js>"],
                            "env": {"PROVIDER_DATA_DIR": "<provider-local-data-dir>"},
                        }
                    },
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        created.append(_safe_rel(repo_root, mcp_path))
    else:
        skipped.append(_safe_rel(repo_root, mcp_path))

    schema_path = repo_root / "specs" / "plan.schema.json"
    if not schema_path.exists() or force:
        schema_path.write_text(json.dumps(_load_plan_schema_template(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
        created.append(_safe_rel(repo_root, schema_path))
    else:
        skipped.append(_safe_rel(repo_root, schema_path))

    sync_research_contract(repo_root=repo_root, create_missing=False, project_policy=project_policy)
    return {
        "created": sorted(dict.fromkeys(created)),
        "skipped": sorted(dict.fromkeys(skipped)),
        "context_files": list(MINIMAL_CONTEXT_FILES),
        "naming_audit": [decision.__dict__ for decision in BOUNDARY_NAMING_AUDIT],
        "variant": variant,
    }
