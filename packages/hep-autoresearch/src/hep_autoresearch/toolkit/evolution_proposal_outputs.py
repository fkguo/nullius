from __future__ import annotations

import os
import platform
import sys
from pathlib import Path
from typing import Any

from ._git import try_get_git_metadata
from ._json import write_json
from ._paths import manifest_cwd
from .artifact_report import write_artifact_report
from .evolution_proposal_render import render_proposals_md, render_trace_stub_md


def _rel(repo_root: Path, path: Path) -> str:
    return os.fspath(path.relative_to(repo_root))


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


def make_output_paths(*, repo_root: Path, tag: str) -> dict[str, Path]:
    out_dir = repo_root / "artifacts" / "runs" / tag / "evolution_proposal"
    out_dir.mkdir(parents=True, exist_ok=True)
    return {
        "out_dir": out_dir,
        "manifest": out_dir / "manifest.json",
        "summary": out_dir / "summary.json",
        "analysis": out_dir / "analysis.json",
        "report": out_dir / "report.md",
        "proposal_md": out_dir / "proposal.md",
        "trace_stub_md": out_dir / "trace_stub.md",
        "suggested_eval_case": out_dir / "suggested_eval_case.case.json",
    }


def write_output_bundle(
    *,
    repo_root: Path,
    tag: str,
    source_run_tag: str,
    max_proposals: int,
    include_eval_failures: bool,
    write_kb_trace: bool,
    kb_trace_path: str | None,
    trigger_mode: str | None,
    terminal_status: str | None,
    created_at: str,
    paths: dict[str, Path],
    analysis: dict[str, Any],
) -> dict[str, Any]:
    out_dir = paths["out_dir"]
    versions = {"python": sys.version.split()[0], "os": platform.platform()}
    manifest = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_evolution_proposal.py",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {
            "tag": tag,
            "source_run_tag": source_run_tag,
            "max_proposals": max_proposals,
            "include_eval_failures": include_eval_failures,
            "write_kb_trace": write_kb_trace,
            "trigger_mode": trigger_mode,
            "terminal_status": terminal_status,
        },
        "versions": versions,
        "outputs": [_rel(repo_root, paths[key]) for key in ("manifest", "summary", "analysis", "report", "proposal_md", "trace_stub_md", "suggested_eval_case")],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta
    summary = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"workflow": "EVOLUTION_proposal", "kind": "evolution_proposal"},
        "stats": {
            "proposals_total": ((analysis.get("results") or {}).get("proposals_total")) if isinstance(analysis, dict) else 0,
            "suppressed_duplicates_total": ((analysis.get("results") or {}).get("suppressed_duplicates_total")) if isinstance(analysis, dict) else 0,
            "repair_loop_detected": bool(((analysis.get("results") or {}).get("repair_loop_detected"))) if isinstance(analysis, dict) else False,
            "consecutive_empty_cycles": ((analysis.get("results") or {}).get("consecutive_empty_cycles")) if isinstance(analysis, dict) else 0,
        },
        "outputs": {key: _rel(repo_root, paths[key]) for key in ("analysis", "proposal_md", "trace_stub_md", "suggested_eval_case")},
    }
    suggested_eval = {
        "schema_version": 1,
        "case_id": "E??-todo-failure-regression-anchor",
        "workflow": "custom",
        "description": "TODO: turn one proposal into a deterministic eval case (no live network).",
        "inputs": {"source_run_tag": source_run_tag, "proposal_tag": tag},
        "acceptance": {"required_paths_exist": [_rel(repo_root, paths["proposal_md"]), _rel(repo_root, paths["analysis"])]},
        "notes": "Generated as a skeleton. Copy into evals/cases/ and refine case_id + acceptance.",
    }
    write_json(paths["manifest"], manifest)
    write_json(paths["summary"], summary)
    report_rel = write_artifact_report(repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis)
    proposals = ((analysis.get("results") or {}).get("proposals")) if isinstance(analysis, dict) and isinstance((analysis.get("results") or {}).get("proposals"), list) else []
    proposal_dir_rel = _rel(repo_root, out_dir)
    _write_text(paths["proposal_md"], render_proposals_md(repo_root=repo_root, out_dir=out_dir, analysis=analysis))
    trace_stub = render_trace_stub_md(source_run_tag=source_run_tag, proposals=proposals, proposal_dir_rel=proposal_dir_rel)
    _write_text(paths["trace_stub_md"], trace_stub)
    write_json(paths["suggested_eval_case"], suggested_eval)
    if write_kb_trace:
        kb_path = repo_root / kb_trace_path if kb_trace_path else repo_root / "knowledge_base" / "methodology_traces" / f"{created_at[:10]}_t23_evolution_proposal_{tag}.md"
        _write_text(kb_path, trace_stub)
    write_json(paths["analysis"], analysis)
    return {
        "artifact_dir": proposal_dir_rel,
        "artifact_paths": {key: _rel(repo_root, path) for key, path in paths.items() if key != "out_dir"} | {"report": report_rel},
        "proposals_total": len(proposals),
    }
