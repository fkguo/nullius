#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT if SRC_ROOT.exists() else REPO_ROOT))

from hep_autoresearch.toolkit._git import try_get_git_metadata  # noqa: E402
from hep_autoresearch.toolkit._json import write_json  # noqa: E402
from hep_autoresearch.toolkit._paths import manifest_cwd  # noqa: E402
from hep_autoresearch.toolkit._time import utc_now_iso  # noqa: E402
from hep_autoresearch.toolkit.literature_survey_export import resolve_literature_survey_refkeys  # noqa: E402
from hep_autoresearch.toolkit.literature_survey import write_literature_survey  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="KB → literature survey export (deterministic, no-LLM).")
    parser.add_argument("--tag", required=True, help="Run tag (artifacts/runs/<tag>/literature_survey/...).")
    parser.add_argument("--topic", help="Optional topic header.")
    parser.add_argument(
        "--refkeys",
        help="Comma-separated RefKey list. If omitted, uses literature notes listed in knowledge_base/_index/kb_profiles/curated.json.",
    )
    args = parser.parse_args()

    repo_root = Path.cwd()
    tag = str(args.tag).strip()
    if not tag:
        raise SystemExit("tag is required")

    explicit_refkeys = [x.strip() for x in str(args.refkeys).split(",") if x.strip()] if args.refkeys else None
    refkeys = resolve_literature_survey_refkeys(repo_root=repo_root, refkeys=explicit_refkeys)

    created_at = utc_now_iso().replace("+00:00", "Z")
    out_dir = repo_root / "artifacts" / "runs" / tag / "literature_survey"
    out_dir.mkdir(parents=True, exist_ok=True)

    outs = write_literature_survey(repo_root=repo_root, out_dir=out_dir, refkeys=refkeys, topic=args.topic)

    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_literature_survey.py",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {"tag": tag, "topic": args.topic or None, "refkeys": refkeys},
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
    try:
        import json

        survey = json.loads((repo_root / outs["survey_json"]).read_text(encoding="utf-8"))
    except Exception:
        survey = {}

    issues = survey.get("issues") if isinstance(survey, dict) else {}
    missing_inspire = (
        issues.get("missing_inspire_citekeys") if isinstance(issues, dict) and isinstance(issues.get("missing_inspire_citekeys"), list) else []
    )
    missing_bib = (
        issues.get("missing_bib_entries") if isinstance(issues, dict) and isinstance(issues.get("missing_bib_entries"), list) else []
    )
    missing_kb = (
        issues.get("missing_kb_notes") if isinstance(issues, dict) and isinstance(issues.get("missing_kb_notes"), list) else []
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
        "inputs": {"tag": tag, "topic": args.topic or None, "refkeys": refkeys},
        "results": {
            "ok": bool(ok),
            "outputs": outs,
            "issues": {"missing_kb_notes": missing_kb, "missing_inspire_citekeys": missing_inspire, "missing_bib_entries": missing_bib, "warnings": warnings},
        },
    }

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)

    print("[ok] wrote literature survey export:")
    print(f"- artifact_dir: {os.fspath(out_dir.relative_to(repo_root))}")
    print(f"- report: {outs['report']}")
    print(f"- survey_json: {outs['survey_json']}")
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
