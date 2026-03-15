from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path
from typing import Any

from .project_surface import (
    BOUNDARY_NAMING_AUDIT,
    FULL_ROOT_FILES,
    MCP_CONFIG_EXAMPLE,
    MINIMAL_CONTEXT_FILES,
    MINIMAL_ROOT_FILES,
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
    pkg_root = Path(__file__).resolve().parent.parent
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
) -> dict[str, Any]:
    created: list[str] = []
    skipped: list[str] = []
    project = (project_name or repo_root.name or "Research Project").strip() or "Research Project"
    profile_name = (profile or "mixed").strip() or "mixed"

    for rel in ("artifacts/runs", "docs", "specs"):
        (repo_root / rel).mkdir(parents=True, exist_ok=True)

    root_files = FULL_ROOT_FILES if variant == "full" else MINIMAL_ROOT_FILES
    for rel in root_files:
        _write_text_if_missing(
            repo_root=repo_root,
            path=repo_root / rel,
            text=_render_template(rel, project_name=project, project_root=repo_root, profile=profile_name),
            created=created,
            skipped=skipped,
            force=force,
        )

    _write_text_if_missing(
        repo_root=repo_root,
        path=repo_root / "AGENTS.md",
        text=(
            "# AGENTS.md\n\n"
            "This file anchors the workflow for this research project.\n\n"
            "## Quick rules\n\n"
            "- Human notebook: `research_notebook.md`\n"
            "- Machine contract: `research_contract.md`\n"
            "- Evidence-first: every meaningful action writes auditable artifacts under `artifacts/runs/<TAG>/`.\n"
            "- Approval gates A1–A5 remain the default safety contract (see `docs/APPROVAL_GATES.md`).\n"
        ),
        created=created,
        skipped=skipped,
        force=force,
    )
    _write_text_if_missing(
        repo_root=repo_root,
        path=repo_root / "docs" / "APPROVAL_GATES.md",
        text="# Approval gates (A1–A5)\n\nDefault: require human approval before high-risk actions.\n",
        created=created,
        skipped=skipped,
        force=force,
    )
    _write_text_if_missing(
        repo_root=repo_root,
        path=repo_root / "docs" / "ARTIFACT_CONTRACT.md",
        text="# Artifact contract\n\nEvery workflow run writes `manifest.json`, `summary.json`, and `analysis.json`.\n",
        created=created,
        skipped=skipped,
        force=force,
    )
    _write_text_if_missing(
        repo_root=repo_root,
        path=repo_root / "docs" / "EVAL_GATE_CONTRACT.md",
        text="# Eval gate contract\n\nEvals are deterministic checks over on-disk artifacts.\n",
        created=created,
        skipped=skipped,
        force=force,
    )
    mcp_path = repo_root / MCP_CONFIG_EXAMPLE
    if not mcp_path.exists() or force:
        mcp_path.write_text(
            json.dumps(
                {
                    "_comment": "Copy this file to .mcp.json and fill in your local MCP server command/args/env.",
                    "mcpServers": {
                        "hep-research": {
                            "command": "node",
                            "args": ["<path-to-hep-research-mcp-entrypoint.js>"],
                            "env": {"HEP_DATA_DIR": ".hep-research-mcp"},
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

    sync_research_contract(repo_root=repo_root, create_missing=False)
    return {
        "created": sorted(dict.fromkeys(created)),
        "skipped": sorted(dict.fromkeys(skipped)),
        "context_files": list(MINIMAL_CONTEXT_FILES),
        "naming_audit": [decision.__dict__ for decision in BOUNDARY_NAMING_AUDIT],
        "variant": variant,
    }
