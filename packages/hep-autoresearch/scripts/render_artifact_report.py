#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT if SRC_ROOT.exists() else REPO_ROOT))

from hep_autoresearch.toolkit._json import read_json  # noqa: E402
from hep_autoresearch.toolkit.artifact_report import write_artifact_report  # noqa: E402


def _has_artifact_ssot(dir_path: Path) -> bool:
    required = ["manifest.json", "summary.json", "analysis.json"]
    return all((dir_path / name).is_file() for name in required)


def _discover_artifact_dirs(base: Path) -> list[Path]:
    found: list[Path] = []
    if not base.exists():
        return found
    for root, dirs, files in os.walk(base):
        root_path = Path(root)
        if {"manifest.json", "summary.json", "analysis.json"}.issubset(set(files)):
            found.append(root_path)
            dirs[:] = []  # do not descend further; artifact_dir is a leaf by convention
    return sorted(set(found))


def render_one(*, repo_root: Path, artifact_dir: Path, force: bool) -> tuple[bool, str]:
    if not artifact_dir.exists():
        return False, f"missing directory: {artifact_dir}"
    if not _has_artifact_ssot(artifact_dir):
        return False, f"missing manifest/summary/analysis in: {artifact_dir}"

    report_path = artifact_dir / "report.md"
    if report_path.exists() and not force:
        return True, os.fspath(report_path.relative_to(repo_root))

    manifest = read_json(artifact_dir / "manifest.json")
    summary = read_json(artifact_dir / "summary.json")
    analysis = read_json(artifact_dir / "analysis.json")
    report_rel = write_artifact_report(
        repo_root=repo_root,
        artifact_dir=artifact_dir,
        manifest=manifest,
        summary=summary,
        analysis=analysis,
    )
    return True, report_rel


def main() -> int:
    ap = argparse.ArgumentParser(description="Render deterministic report.md from manifest/summary/analysis (JSON SSOT).")
    ap.add_argument(
        "--artifact-dir",
        action="append",
        default=[],
        help="Artifact directory containing manifest.json/summary.json/analysis.json (repeatable).",
    )
    ap.add_argument(
        "--tag",
        action="append",
        default=[],
        help="Discover all artifact dirs under artifacts/runs/<tag>/ (repeatable).",
    )
    ap.add_argument("--force", action="store_true", help="Overwrite existing report.md (default: skip if present).")
    args = ap.parse_args()

    repo_root = Path.cwd()
    targets: list[Path] = []
    for rel in args.artifact_dir:
        targets.append(Path(rel) if Path(rel).is_absolute() else (repo_root / rel))
    for tag in args.tag:
        targets.extend(_discover_artifact_dirs(repo_root / "artifacts" / "runs" / str(tag)))

    if not targets:
        print("[error] no targets (pass --artifact-dir or --tag)", file=sys.stderr)
        return 2

    ok = True
    rendered: list[str] = []
    for t in targets:
        success, msg = render_one(repo_root=repo_root, artifact_dir=t, force=bool(args.force))
        if success:
            rendered.append(msg)
        else:
            ok = False
            print(f"[error] {msg}", file=sys.stderr)

    if rendered:
        print("[ok] report.md ready:")
        for r in rendered:
            print(f"- {r}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

