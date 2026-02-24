from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .kb_index import kb_index_path, write_kb_index


def _safe_rel(repo_root: Path, p: Path) -> str:
    try:
        return os.fspath(p.relative_to(repo_root)).replace(os.sep, "/")
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        return os.fspath(p)
def _write_text_if_missing(*, repo_root: Path, path: Path, text: str, created: list[str], skipped: list[str]) -> None:
    rel = _safe_rel(repo_root, path)
    if path.exists():
        skipped.append(rel)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")
    created.append(rel)


def _write_json_if_missing(
    *,
    repo_root: Path,
    path: Path,
    payload: dict[str, Any],
    created: list[str],
    skipped: list[str],
) -> None:
    rel = _safe_rel(repo_root, path)
    if path.exists():
        skipped.append(rel)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    created.append(rel)


def _load_plan_schema_template() -> dict[str, Any]:
    """Load the canonical plan schema template (SSOT).

    This schema is required for reproducibility. If it is missing, the install/bundle is incomplete
    and project init should fail fast.
    """
    candidates: list[Path] = []

    # 1) Prefer installed package data: `<hep_autoresearch>/specs/plan.schema.json`.
    pkg_root = Path(__file__).resolve().parent.parent  # toolkit/ -> hep_autoresearch/
    candidates.append(pkg_root / "specs" / "plan.schema.json")

    # 2) Dev checkout / bundle layout: walk upward a few levels to find `<repo_root>/specs/plan.schema.json`.
    here = Path(__file__).resolve()
    for parent in list(here.parents)[:8]:
        candidates.append(parent / "specs" / "plan.schema.json")

    import hashlib

    seen: set[Path] = set()
    found: list[tuple[Path, dict[str, Any], str]] = []
    for cand in candidates:
        if cand in seen:
            continue
        seen.add(cand)
        if not cand.is_file():
            continue
        try:
            raw = json.loads(cand.read_text(encoding="utf-8"))
        except Exception as e:
            raise RuntimeError(f"failed to parse plan schema template: {cand}: {e}") from e
        if not isinstance(raw, dict) or not raw:
            raise RuntimeError(f"plan schema template must be a non-empty JSON object: {cand}")
        norm = json.dumps(raw, sort_keys=True, ensure_ascii=False).encode("utf-8")
        sha = hashlib.sha256(norm).hexdigest()
        found.append((cand, raw, sha))

    if found:
        unique = sorted({sha for _, _, sha in found})
        if len(unique) > 1:
            details = "\n".join(f"- {os.fspath(p)}: {sha}" for p, _, sha in found)
            raise RuntimeError("multiple differing plan schema templates found:\n" + details)
        return found[0][1]

    raise FileNotFoundError("plan schema template not found (expected specs/plan.schema.json in install tree)")


def ensure_project_scaffold(*, repo_root: Path) -> dict[str, Any]:
    """Bootstrap a minimal research project layout.

    Safe-by-default: creates missing files/directories but does not overwrite.
    Returns a summary of created/skipped paths and whether kb_index was generated.
    """
    created: list[str] = []
    skipped: list[str] = []

    # Directories used by core workflows.
    for rel in [
        "artifacts/runs",
        "docs",
        "specs",
        "knowledge_base/literature",
        "knowledge_base/methodology_traces",
        "knowledge_base/priors",
        "knowledge_base/_index/kb_profiles",
    ]:
        (repo_root / rel).mkdir(parents=True, exist_ok=True)

    # Root docs required by the context pack (and expected by research-team).
    _write_text_if_missing(
        repo_root=repo_root,
        path=repo_root / "AGENTS.md",
        created=created,
        skipped=skipped,
        text=(
            "# AGENTS.md\n\n"
            "This file anchors the workflow for this research project.\n\n"
            "## Quick rules\n\n"
            "- Evidence-first: every meaningful action writes auditable artifacts under `artifacts/runs/<TAG>/`.\n"
            "- Approval gates A1–A5 are the default safety contract (see `docs/APPROVAL_GATES.md`).\n"
            "- Keep the notebook `Draft_Derivation.md` as the SSOT for derivations (no hidden steps in capsules).\n"
        ),
    )
    _write_text_if_missing(
        repo_root=repo_root,
        path=repo_root / "PROJECT_CHARTER.md",
        created=created,
        skipped=skipped,
        text=(
            "# PROJECT_CHARTER.md\n\n"
            "Status: DRAFT  # change to APPROVED after human review\n"
            "Project: (fill)\n"
            "Root: <PROJECT_ROOT>\n"
            "Created: (fill)\n"
            "Last updated: (fill)\n\n"
            "## 0. Goal Hierarchy\n\n"
            "Primary goal: (fill)\n\n"
            "Anti-goals:\n"
            "- (fill)\n"
        ),
    )
    _write_text_if_missing(
        repo_root=repo_root,
        path=repo_root / "PROJECT_MAP.md",
        created=created,
        skipped=skipped,
        text=(
            "# PROJECT_MAP.md\n\n"
            "High-level map of key files and how to run the workflow.\n\n"
            "- Notebook: `Draft_Derivation.md`\n"
            "- KB: `knowledge_base/`\n"
            "- Artifacts: `artifacts/runs/<TAG>/`\n"
            "- Orchestrator state: `.autoresearch/`\n"
        ),
    )
    _write_text_if_missing(
        repo_root=repo_root,
        path=repo_root / "RESEARCH_PLAN.md",
        created=created,
        skipped=skipped,
        text=(
            "# RESEARCH_PLAN.md\n\n"
            "Created: (fill)\n"
            "Last updated: (fill)\n\n"
            "## Task Board\n\n"
            "- [ ] T1: (fill)\n"
        ),
    )
    _write_text_if_missing(
        repo_root=repo_root,
        path=repo_root / "PREWORK.md",
        created=created,
        skipped=skipped,
        text=(
            "# PREWORK.md\n\n"
            "## Problem Framing Snapshot\n\n"
            "- Problem interpretation: (fill)\n"
            "- P/D separation: (fill)\n"
            "- Sequential review checklist: (fill)\n\n"
            "## Literature coverage matrix\n\n"
            "| Dimension | Status | Gaps |\n"
            "|---|---|---|\n"
            "| theory | (fill) | (fill) |\n"
            "| method | (fill) | (fill) |\n"
            "| numerics | (fill) | (fill) |\n"
            "| baselines | (fill) | (fill) |\n"
            "| data | (fill) | (fill) |\n"
        ),
    )
    _write_text_if_missing(
        repo_root=repo_root,
        path=repo_root / "Draft_Derivation.md",
        created=created,
        skipped=skipped,
        text=(
            "# Draft_Derivation.md\n\n"
            "## Capsule (reproducibility contract)\n\n"
            "- Project root: <PROJECT_ROOT>\n"
            "- Runs: `artifacts/runs/<TAG>/...`\n\n"
            "## Notebook\n\n"
            "- (fill)\n\n"
            "## References\n\n"
            "- (fill) Add clickable links + local KB note links.\n"
        ),
    )
    _write_json_if_missing(
        repo_root=repo_root,
        path=repo_root / ".mcp.json.example",
        payload={
            "_comment": "Copy this file to .mcp.json and fill in your local MCP server command/args/env.",
            "mcpServers": {
                "hep-research": {
                    "command": "node",
                    "args": ["<path-to-hep-research-mcp-entrypoint.js>"],
                    "env": {"HEP_DATA_DIR": ".hep-research-mcp"},
                }
            },
        },
        created=created,
        skipped=skipped,
    )

    # Policy/contract docs used by the context pack.
    _write_text_if_missing(
        repo_root=repo_root,
        path=repo_root / "docs" / "APPROVAL_GATES.md",
        created=created,
        skipped=skipped,
        text=(
            "# Approval gates (A1–A5)\n\n"
            "Default: require human approval before high-risk actions.\n\n"
            "| Gate | Category | Examples |\n"
            "|---|---|---|\n"
            "| A1 | mass_search | large retrieval/citation expansion |\n"
            "| A2 | code_changes | edits to core logic/scripts |\n"
            "| A3 | compute_runs | heavy compute, parameter sweeps |\n"
            "| A4 | paper_edits | manuscript edits / LaTeX compilation |\n"
            "| A5 | final_conclusions | strong novelty claims |\n"
        ),
    )
    _write_text_if_missing(
        repo_root=repo_root,
        path=repo_root / "docs" / "ARTIFACT_CONTRACT.md",
        created=created,
        skipped=skipped,
        text=(
            "# Artifact contract (SSOT)\n\n"
            "Every workflow run must write:\n\n"
            "- `manifest.json` (what ran, params, versions, outputs)\n"
            "- `summary.json` (headline stats)\n"
            "- `analysis.json` (machine-checkable results)\n\n"
            "`report.md` is a derived human view.\n"
        ),
    )
    _write_text_if_missing(
        repo_root=repo_root,
        path=repo_root / "docs" / "EVAL_GATE_CONTRACT.md",
        created=created,
        skipped=skipped,
        text=(
            "# Eval gate contract\n\n"
            "Evals are deterministic checks over on-disk artifacts.\n\n"
            "- Prefer `required_paths_exist` and JSON pointer checks.\n"
            "- Keep eval inputs and expected outputs stable.\n"
        ),
    )

    # Structured Plan schema (required by orchestrator_state.validate_plan).
    _write_json_if_missing(
        repo_root=repo_root,
        path=repo_root / "specs" / "plan.schema.json",
        payload=_load_plan_schema_template(),
        created=created,
        skipped=skipped,
    )

    # Append-only query log (required by W1 ingestion).
    _write_text_if_missing(
        repo_root=repo_root,
        path=repo_root / "knowledge_base" / "methodology_traces" / "literature_queries.md",
        created=created,
        skipped=skipped,
        text=(
            "# literature_queries.md\n\n"
            "Purpose: append-only log of literature/code searches and selection decisions.\n\n"
            "## Log\n\n"
            "| Timestamp (UTC) | Source | Query | Filters / criteria | Shortlist (links) | Decision / notes | Local KB notes |\n"
            "|---|---|---|---|---|---|---|\n"
        ),
    )

    # KB seed content + KB profile definitions (only if minimal profile is missing).
    kb_profiles_dir = repo_root / "knowledge_base" / "_index" / "kb_profiles"
    minimal_profile_path = kb_profiles_dir / "minimal.json"
    if not minimal_profile_path.exists():
        _write_text_if_missing(
            repo_root=repo_root,
            path=repo_root / "knowledge_base" / "priors" / "initial_priors.md",
            created=created,
            skipped=skipped,
            text=(
                "# Research automation priors (initial)\n\n"
                "RefKey: initial-priors\n\n"
                "Principles:\n"
                "- Evidence-first: every result points to artifacts or a checkable derivation.\n"
                "- Use the KB index (`knowledge_base/_index/kb_index.json`) to keep context selection auditable.\n"
                "- Prefer stable anchors for citations (INSPIRE/arXiv/DOI/GitHub).\n"
            ),
        )
        _write_text_if_missing(
            repo_root=repo_root,
            path=repo_root / "knowledge_base" / "methodology_traces" / "initial_autopilot_scope.md",
            created=created,
            skipped=skipped,
            text=(
                "# Autopilot scope (initial)\n\n"
                "RefKey: initial-autopilot-scope\n\n"
                "Candidate methods:\n"
                "- (fill)\n\n"
                "Chosen approach:\n"
                "- (fill)\n"
            ),
        )

        minimal_def = {
            "schema_version": 1,
            "profile": "minimal",
            "paths": [
                "knowledge_base/priors/initial_priors.md",
                "knowledge_base/methodology_traces/initial_autopilot_scope.md",
            ],
            "notes": "minimal profile: initial priors + initial methodology trace (project-scaffold).",
        }
        curated_def = {
            "schema_version": 1,
            "profile": "curated",
            "paths": list(minimal_def["paths"]),
            "notes": "curated profile (initial): same as minimal until the project curator expands it.",
        }
        _write_json_if_missing(
            repo_root=repo_root,
            path=minimal_profile_path,
            payload=minimal_def,
            created=created,
            skipped=skipped,
        )
        _write_json_if_missing(
            repo_root=repo_root,
            path=kb_profiles_dir / "curated.json",
            payload=curated_def,
            created=created,
            skipped=skipped,
        )
    else:
        pass

    # KB index (SSOT). Only write if missing to avoid noisy updates in existing repos.
    idx_path = kb_index_path(repo_root=repo_root)
    wrote_kb_index = False
    kb_index_rel: str | None = None
    kb_index_sha256: str | None = None
    if not idx_path.exists():
        kb_index_rel, kb_index_sha256 = write_kb_index(repo_root=repo_root)
        wrote_kb_index = True
    else:
        skipped.append(_safe_rel(repo_root, idx_path))

    # Post-write validation for critical JSON files (fail-fast; prevents silent broken scaffolds).
    for rel_path in [
        "specs/plan.schema.json",
        "knowledge_base/_index/kb_index.json",
        "knowledge_base/_index/kb_profiles/minimal.json",
        "knowledge_base/_index/kb_profiles/curated.json",
    ]:
        p = repo_root / rel_path
        if not p.exists():
            continue
        try:
            json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            raise RuntimeError(f"scaffolded JSON is invalid: {rel_path}: {e}") from e

    return {
        "created": sorted(created),
        "skipped": sorted(dict.fromkeys(skipped)),
        "kb_index": {"wrote": bool(wrote_kb_index), "path": kb_index_rel, "sha256": kb_index_sha256},
    }
