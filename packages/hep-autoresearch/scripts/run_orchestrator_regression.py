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
    parser.add_argument("--reproduce-ns", default="0,1,2", help="reproduce ns list (comma-separated).")
    parser.add_argument(
        "--scenarios",
        default="reproduce,computation,revision",
        help="Comma-separated scenarios to run: project_init,plan,branching,sandbox,reproduce,computation,revision,survey_polish,bypass (default: reproduce,computation,revision). Unknown scenarios fail closed.",
    )
    parser.add_argument(
        "--computation-run-card",
        default="",
        help="Optional run-card path for the computation scenario (default: auto-generated minimal fixture).",
    )
    args = parser.parse_args()

    ns = tuple(int(x.strip()) for x in str(args.reproduce_ns).split(",") if x.strip())
    scenarios = tuple(s.strip() for s in str(args.scenarios).split(",") if s.strip())
    repo_root = Path.cwd()
    res = run_orchestrator_regression(
        OrchestratorRegressionInputs(
            tag=str(args.tag),
            scenarios=scenarios,
            reproduce_ns=ns,
            timeout_seconds=int(args.timeout_seconds),
            computation_run_card=str(args.computation_run_card).strip() or None,
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
