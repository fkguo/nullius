#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT if SRC_ROOT.exists() else REPO_ROOT))

from hep_autoresearch.toolkit.ecosystem_bundle import (  # noqa: E402
    DEFAULT_EXCLUDED_SKILLS,
    DEFAULT_GENERAL_SKILLS,
    EcosystemBundleInputs,
    ecosystem_bundle_one,
)


def main() -> int:
    ap = argparse.ArgumentParser(description="Build ecosystem bundle v0 (core container bundle + secret-scan bootstrap).")
    ap.add_argument("--tag", required=True, help="Run tag for artifacts/runs/<tag>/ecosystem_bundle/...")
    ap.add_argument("--bundle-basename", default="core_bundle.zip", help="Zip basename (default: core_bundle.zip).")
    ap.add_argument(
        "--hep-mcp-package-dir",
        default=None,
        help="Path to hep-research-mcp package dir (defaults to $HEP_MCP_PACKAGE_DIR or common locations).",
    )
    ap.add_argument(
        "--skills-root",
        default=None,
        help="Skills root containing skill dirs (defaults to $CODEX_HOME/skills or ~/.codex/skills).",
    )
    ap.add_argument(
        "--include-skill",
        action="append",
        default=[],
        help="Include this skill name (repeatable). Default includes a curated core set.",
    )
    ap.add_argument(
        "--exclude-skill",
        action="append",
        default=[],
        help="Exclude this skill name (repeatable).",
    )
    ap.add_argument("--no-smoke", action="store_true", help="Skip bootstrap smoke checks.")
    args = ap.parse_args()

    repo_root = Path.cwd()
    include = tuple(args.include_skill) if args.include_skill else DEFAULT_GENERAL_SKILLS
    excluded = tuple(sorted(set(DEFAULT_EXCLUDED_SKILLS) | set(args.exclude_skill)))

    res = ecosystem_bundle_one(
        EcosystemBundleInputs(
            tag=str(args.tag),
            bundle_basename=str(args.bundle_basename),
            hep_mcp_package_dir=str(args.hep_mcp_package_dir) if args.hep_mcp_package_dir else None,
            skills_root=str(args.skills_root) if args.skills_root else None,
            include_skills=include,
            excluded_skills=excluded,
            run_smoke_checks=not bool(args.no_smoke),
        ),
        repo_root=repo_root,
    )

    print("[ok] ecosystem bundle artifacts:")
    for k, v in sorted((res.get("artifact_paths") or {}).items()):
        print(f"- {k}: {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

