#!/usr/bin/env python3

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path


def _utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _record_abs_paths() -> bool:
    return os.environ.get("HEPAR_RECORD_ABS_PATHS", "").strip().lower() in {"1", "true", "yes", "y"}


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate minimal planning artifacts (M0).")
    parser.add_argument("--tag", default="M0-r1", help="Run tag, e.g. M0-r1")
    parser.add_argument(
        "--out-root",
        default="artifacts/runs",
        help="Artifacts root directory (project-relative)",
    )
    args = parser.parse_args()

    project_root = Path.cwd()
    out_dir = project_root / args.out_root / args.tag / "planning"
    created_at = _utc_now_iso()

    record_abs = _record_abs_paths()
    cwd_str = os.fspath(project_root) if record_abs else "<PROJECT_ROOT>"
    try:
        cmd0 = os.fspath(Path(sys.argv[0]).relative_to(project_root))
    except Exception:
        cmd0 = Path(sys.argv[0]).name

    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"

    manifest = {
        "schema_version": 1,
        "created_at": created_at,
        "command": " ".join([cmd0] + sys.argv[1:]),
        "cwd": cwd_str,
        "params": {"tag": args.tag, "out_root": args.out_root},
        "versions": {"python": sys.version.split()[0]},
        "outputs": [
            os.fspath(manifest_path.relative_to(project_root)),
            os.fspath(summary_path.relative_to(project_root)),
            os.fspath(analysis_path.relative_to(project_root)),
        ],
        "notes": "Planning-only artifacts generated to satisfy minimal reproducibility gates for M0.",
    }

    summary = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {
            "kind": "planning_only",
            "purpose": "This run contains no physics numerics; it only records that the project skeleton/specs were created.",
        },
        "stats": {},
        "outputs": {
            "docs_seeded": [
                "README.md",
                "docs/VISION.md",
                "docs/ARCHITECTURE.md",
                "docs/ROADMAP.md",
                "docs/WORKFLOWS.md",
                "docs/EVALS.md",
                "docs/ARTIFACT_CONTRACT.md",
                "docs/SECURITY.md",
            ]
        },
    }

    analysis = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {"tag": args.tag},
        "results": {
            "status": "planning_only",
            "project_root": cwd_str,
            "workflow_specs_present": True,
            "eval_case_seeded": True,
        },
        "comparisons": {},
        "uncertainty": {},
    }

    _write_json(manifest_path, manifest)
    _write_json(summary_path, summary)
    _write_json(analysis_path, analysis)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
