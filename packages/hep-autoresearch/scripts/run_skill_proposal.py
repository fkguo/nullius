#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT if SRC_ROOT.exists() else REPO_ROOT))

from hep_autoresearch.toolkit.skill_proposal import SkillProposalInputs, skill_proposal_one  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Skill proposal generator (v0, deterministic).")
    parser.add_argument("--tag", required=True, help="Run tag for output artifacts, e.g. M46-t38-r1")
    parser.add_argument("--source-run-tag", required=True, help="Existing run tag to analyze, e.g. M45-t40-r1")
    parser.add_argument("--max-proposals", type=int, default=5, help="Max proposals to emit (default: 5).")
    args = parser.parse_args()

    repo_root = Path.cwd()
    res = skill_proposal_one(
        SkillProposalInputs(
            tag=str(args.tag),
            source_run_tag=str(args.source_run_tag),
            max_proposals=int(args.max_proposals),
        ),
        repo_root=repo_root,
    )
    print("SKILL_proposal: OK")
    print(f"- proposals_total: {res.get('proposals_total')}")
    for k, v in sorted((res.get("artifact_paths") or {}).items()):
        print(f"- {k}: {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

