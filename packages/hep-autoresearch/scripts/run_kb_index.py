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
from hep_autoresearch.toolkit.artifact_report import write_artifact_report  # noqa: E402
from hep_autoresearch.toolkit.kb_index import write_kb_index  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Build KB index export (deterministic) + write artifacts.")
    parser.add_argument("--tag", required=True, help="Run tag (artifacts/runs/<tag>/kb_index/...).")
    args = parser.parse_args()

    repo_root = Path.cwd()
    tag = str(args.tag).strip()
    if not tag:
        raise SystemExit("tag is required")

    created_at = utc_now_iso().replace("+00:00", "Z")
    out_dir = repo_root / "artifacts" / "runs" / tag / "kb_index"
    out_dir.mkdir(parents=True, exist_ok=True)

    kb_index_rel, kb_index_sha = write_kb_index(repo_root=repo_root)

    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_kb_index.py",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {"tag": tag},
        "versions": {"python": os.sys.version.split()[0]},
        "outputs": [
            os.fspath(manifest_path.relative_to(repo_root)),
            os.fspath(summary_path.relative_to(repo_root)),
            os.fspath(analysis_path.relative_to(repo_root)),
            kb_index_rel,
        ],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"kind": "kb_index"},
        "stats": {},
        "outputs": {"kb_index": kb_index_rel},
    }
    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {"tag": tag},
        "results": {
            "ok": True,
            "kb_index_path": kb_index_rel,
            "kb_index_sha256": kb_index_sha,
        },
    }

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)
    report_rel = write_artifact_report(repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis)

    print("[ok] wrote artifacts:")
    print(f"- kb_index: {kb_index_rel} sha256={kb_index_sha}")
    print(f"- manifest: {os.fspath(manifest_path.relative_to(repo_root))}")
    print(f"- summary: {os.fspath(summary_path.relative_to(repo_root))}")
    print(f"- analysis: {os.fspath(analysis_path.relative_to(repo_root))}")
    print(f"- report: {report_rel}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

