#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT if SRC_ROOT.exists() else REPO_ROOT))

from hep_autoresearch.toolkit.evolution_proposal import (  # noqa: E402
    EvolutionProposalInputs,
    evolution_proposal_one,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="EVOLUTION proposal generator (v0, deterministic).")
    parser.add_argument("--tag", required=True, help="Run tag for output artifacts, e.g. M17-t23-evolution-r1")
    parser.add_argument(
        "--source-run-tag",
        required=True,
        help="Existing run tag to analyze, e.g. M15-agentlit-src-r1",
    )
    parser.add_argument("--max-proposals", type=int, default=20, help="Max proposals to emit (default: 20).")
    parser.add_argument("--no-eval-failures", action="store_true", help="Do not include eval failures even if present.")
    parser.add_argument("--no-kb-trace", action="store_true", help="Do not write a KB methodology trace file.")
    parser.add_argument("--kb-trace-path", help="Override KB trace path (project-relative).")
    args = parser.parse_args()

    repo_root = Path.cwd()
    res = evolution_proposal_one(
        EvolutionProposalInputs(
            tag=str(args.tag),
            source_run_tag=str(args.source_run_tag),
            max_proposals=int(args.max_proposals),
            include_eval_failures=not bool(args.no_eval_failures),
            write_kb_trace=not bool(args.no_kb_trace),
            kb_trace_path=str(args.kb_trace_path) if args.kb_trace_path else None,
        ),
        repo_root=repo_root,
    )

    print("EVOLUTION_proposal: OK")
    print(f"- proposals_total: {res.get('proposals_total')}")
    for k, v in sorted((res.get('artifact_paths') or {}).items()):
        print(f"- {k}: {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

