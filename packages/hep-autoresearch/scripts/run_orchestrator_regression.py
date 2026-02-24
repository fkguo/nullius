#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT if SRC_ROOT.exists() else REPO_ROOT))

from hep_autoresearch.toolkit.orchestrator_regression import OrchestratorRegressionInputs, run_orchestrator_regression  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Orchestrator regression runner (approval gates + exit codes + output paths)."
    )
    parser.add_argument("--tag", required=True, help="Run tag (artifacts/runs/<tag>/orchestrator_regression/...).")
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=600,
        help="Timeout for each orchestrator invocation (default: 600).",
    )
    parser.add_argument("--w2-ns", default="0,1,2", help="W2 ns list (comma-separated).")
    parser.add_argument(
        "--scenarios",
        default="w2,wcompute,w3",
        help="Comma-separated scenarios to run: project_init,plan,branching,sandbox,w2,wcompute,w3,survey_polish,bypass (default: w2,wcompute,w3). ('branch' is an alias for 'branching')",
    )
    parser.add_argument(
        "--wcompute-run-card",
        default="examples/schrodinger_ho/run_cards/ho_groundstate.json",
        help="Run-card path for the wcompute scenario (default: examples/schrodinger_ho/run_cards/ho_groundstate.json).",
    )
    args = parser.parse_args()

    ns = tuple(int(x.strip()) for x in str(args.w2_ns).split(",") if x.strip())
    scenarios = tuple(s.strip() for s in str(args.scenarios).split(",") if s.strip())
    repo_root = Path.cwd()
    res = run_orchestrator_regression(
        OrchestratorRegressionInputs(
            tag=str(args.tag),
            scenarios=scenarios,
            w2_ns=ns,
            timeout_seconds=int(args.timeout_seconds),
            wcompute_run_card=str(args.wcompute_run_card),
        ),
        repo_root=repo_root,
    )

    artifact_paths = res.get("artifact_paths") or {}
    print("[ok] wrote artifacts:")
    for k in ["manifest", "summary", "analysis"]:
        v = artifact_paths.get(k)
        if v:
            print(f"- {k}: {v}")

    errors = res.get("errors") or []
    if errors:
        print("[warn] errors:")
        for e in errors:
            print(f"- {e}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
