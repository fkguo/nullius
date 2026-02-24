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
from hep_autoresearch.toolkit._json import read_json, write_json  # noqa: E402
from hep_autoresearch.toolkit._paths import manifest_cwd  # noqa: E402
from hep_autoresearch.toolkit._time import utc_now_iso  # noqa: E402
from hep_autoresearch.toolkit.artifact_report import write_artifact_report  # noqa: E402
from hep_autoresearch.toolkit.kb_profile import build_kb_profile, write_kb_profile  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="KB profile export (deterministic, no-LLM).")
    parser.add_argument("--tag", required=True, help="Run tag (artifacts/runs/<tag>/kb_profile/...).")
    parser.add_argument("--kb-profile", default="curated", choices=["curated", "minimal", "user"], help="KB profile name.")
    parser.add_argument(
        "--kb-profile-user-path",
        help="If --kb-profile=user, path to a kb_profile definition JSON (default: .autoresearch/kb_profile_user.json).",
    )
    args = parser.parse_args()

    repo_root = Path.cwd()
    tag = str(args.tag).strip()
    if not tag:
        raise SystemExit("tag is required")

    created_at = utc_now_iso().replace("+00:00", "Z")
    out_dir = repo_root / "artifacts" / "runs" / tag / "kb_profile"
    out_dir.mkdir(parents=True, exist_ok=True)

    outs = write_kb_profile(
        repo_root=repo_root, out_dir=out_dir, profile=str(args.kb_profile), user_profile_path=args.kb_profile_user_path
    )

    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_kb_profile.py",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {
            "tag": tag,
            "kb_profile": str(args.kb_profile),
            "kb_profile_user_path": args.kb_profile_user_path,
        },
        "versions": {"python": sys.version.split()[0]},
        "outputs": [
            os.fspath(manifest_path.relative_to(repo_root)),
            os.fspath(summary_path.relative_to(repo_root)),
            os.fspath(analysis_path.relative_to(repo_root)),
            outs["kb_profile_json"],
            outs["report"],
        ],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    try:
        profile = read_json(repo_root / outs["kb_profile_json"])
    except Exception:
        profile = {}

    stats = profile.get("stats") if isinstance(profile, dict) else {}
    total_entries = int(stats.get("total_entries") or 0) if isinstance(stats, dict) else 0
    total_bytes = int(stats.get("total_bytes") or 0) if isinstance(stats, dict) else 0
    issues = profile.get("issues") if isinstance(profile, dict) else {}
    missing_paths = issues.get("missing_paths") if isinstance(issues, dict) and isinstance(issues.get("missing_paths"), list) else []
    ok = not bool(missing_paths)

    # Compare built-in profiles (benefit vs noise proxy).
    try:
        minimal = build_kb_profile(repo_root=repo_root, profile="minimal")
        curated = build_kb_profile(repo_root=repo_root, profile="curated")
    except Exception:
        minimal = {}
        curated = {}

    def _stats(p: dict[str, Any]) -> dict[str, int]:
        s = p.get("stats") if isinstance(p.get("stats"), dict) else {}
        te = int(s.get("total_entries") or 0) if isinstance(s, dict) else 0
        tb = int(s.get("total_bytes") or 0) if isinstance(s, dict) else 0
        return {"total_entries": te, "total_bytes": tb}

    minimal_stats = _stats(minimal) if isinstance(minimal, dict) else {"total_entries": 0, "total_bytes": 0}
    curated_stats = _stats(curated) if isinstance(curated, dict) else {"total_entries": 0, "total_bytes": 0}
    delta_entries = int(curated_stats["total_entries"] - minimal_stats["total_entries"])
    delta_bytes = int(curated_stats["total_bytes"] - minimal_stats["total_bytes"])

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"kind": "kb_profile"},
        "stats": {
            "ok": bool(ok),
            "profile": str(args.kb_profile),
            "total_entries": total_entries,
            "total_bytes": total_bytes,
            "missing_paths": int(len(missing_paths)),
            "minimal_total_entries": int(minimal_stats["total_entries"]),
            "curated_total_entries": int(curated_stats["total_entries"]),
            "delta_entries_curated_minus_minimal": int(delta_entries),
        },
        "outputs": outs,
    }
    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {
            "tag": tag,
            "kb_profile": str(args.kb_profile),
            "kb_profile_user_path": args.kb_profile_user_path,
        },
        "results": {
            "ok": bool(ok),
            "outputs": outs,
            "missing_paths": missing_paths,
            "benefit_vs_noise_proxy": {
                "minimal": minimal_stats,
                "curated": curated_stats,
                "delta_entries_curated_minus_minimal": delta_entries,
                "delta_bytes_curated_minus_minimal": delta_bytes,
            },
        },
    }

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)
    report_rel = write_artifact_report(
        repo_root=repo_root,
        artifact_dir=out_dir,
        manifest=manifest,
        summary=summary,
        analysis=analysis,
        report_name="artifact_report.md",
    )

    print("[ok] wrote kb_profile artifacts:")
    print(f"- profile: {args.kb_profile} entries={total_entries} bytes={total_bytes} missing={len(missing_paths)}")
    print(f"- kb_profile_json: {outs['kb_profile_json']}")
    print(f"- report: {outs['report']}")
    print(f"- artifact_report: {report_rel}")
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
