from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ._git import try_get_git_metadata
from ._json import read_json, write_json
from ._paths import manifest_cwd
from ._time import utc_now_iso
from .literature_survey import write_literature_survey


@dataclass(frozen=True)
class LiteratureSurveyExportInputs:
    tag: str
    topic: str | None = None
    refkeys: list[str] | None = None


def literature_survey_export_one(inps: LiteratureSurveyExportInputs, *, repo_root: Path) -> dict[str, Any]:
    tag = str(inps.tag).strip()
    if not tag:
        raise ValueError("tag is required")

    refkeys: list[str]
    if inps.refkeys:
        refkeys = [str(x).strip() for x in inps.refkeys if str(x).strip()]
    else:
        # v0 demo set: one INSPIRE-backed note and one arXiv-only note.
        refkeys = ["recid-3112995-madagants", "arxiv-2512.19799-physmaster"]

    created_at = utc_now_iso().replace("+00:00", "Z")
    out_dir = repo_root / "artifacts" / "runs" / tag / "literature_survey"
    out_dir.mkdir(parents=True, exist_ok=True)

    outs = write_literature_survey(repo_root=repo_root, out_dir=out_dir, refkeys=refkeys, topic=inps.topic)

    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "hep-autoresearch (literature_survey_export)",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {"tag": tag, "topic": inps.topic or None, "refkeys": refkeys},
        "versions": {"python": sys.version.split()[0]},
        "outputs": [
            os.fspath(manifest_path.relative_to(repo_root)),
            os.fspath(summary_path.relative_to(repo_root)),
            os.fspath(analysis_path.relative_to(repo_root)),
            outs["survey_json"],
            outs["refkey_to_citekey"],
            outs["citekey_to_refkeys"],
            outs["bib"],
            outs["tex"],
            outs["report"],
        ],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    # Load SSOT to summarize counts without re-implementing logic.
    survey: dict[str, Any] = {}
    errors: list[str] = []
    try:
        raw = read_json(repo_root / outs["survey_json"])
        survey = raw if isinstance(raw, dict) else {}
        if not isinstance(raw, dict):
            errors.append("survey.json is not a JSON object")
    except Exception as e:
        errors.append(f"failed to read survey.json: {e}")

    issues = survey.get("issues") if isinstance(survey.get("issues"), dict) else {}
    missing_inspire = (
        issues.get("missing_inspire_citekeys")
        if isinstance(issues, dict) and isinstance(issues.get("missing_inspire_citekeys"), list)
        else []
    )
    missing_bib = (
        issues.get("missing_bib_entries")
        if isinstance(issues, dict) and isinstance(issues.get("missing_bib_entries"), list)
        else []
    )
    missing_kb = (
        issues.get("missing_kb_notes")
        if isinstance(issues, dict) and isinstance(issues.get("missing_kb_notes"), list)
        else []
    )
    warnings = issues.get("warnings") if isinstance(issues, dict) and isinstance(issues.get("warnings"), list) else []

    stats = survey.get("stats") if isinstance(survey, dict) else {}
    total_entries = int(stats.get("total_entries") or 0) if isinstance(stats, dict) else 0
    unique_citekeys = int(stats.get("unique_citekeys") or 0) if isinstance(stats, dict) else 0
    ok = not (missing_kb or missing_inspire or missing_bib)

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"kind": "literature_survey"},
        "stats": {
            "ok": bool(ok),
            "total_entries": total_entries,
            "unique_citekeys": unique_citekeys,
            "missing_kb_notes": int(len(missing_kb)),
            "missing_inspire_citekeys": int(len(missing_inspire)),
            "missing_bib_entries": int(len(missing_bib)),
            "warnings": int(len(warnings)),
        },
        "outputs": outs,
    }

    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {"tag": tag, "topic": inps.topic or None, "refkeys": refkeys},
        "results": {
            "ok": bool(ok),
            "outputs": outs,
            "issues": {
                "missing_kb_notes": list(missing_kb),
                "missing_inspire_citekeys": list(missing_inspire),
                "missing_bib_entries": list(missing_bib),
                "warnings": list(warnings),
            },
            "errors": errors,
        },
    }

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)

    artifact_paths = {
        "manifest": os.fspath(manifest_path.relative_to(repo_root)),
        "summary": os.fspath(summary_path.relative_to(repo_root)),
        "analysis": os.fspath(analysis_path.relative_to(repo_root)),
        **outs,
    }

    return {"errors": errors, "ok": bool(ok), "artifact_paths": artifact_paths}

