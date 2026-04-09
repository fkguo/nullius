import json
import shutil
import sys
import unittest
import uuid
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


def _package_root() -> Path:
    return Path(__file__).resolve().parents[1]


sys.path.insert(0, str(_src_root()))

from hep_autoresearch.toolkit.orchestrator_regression import OrchestratorRegressionInputs, run_orchestrator_regression


class TestOrchestratorRegression(unittest.TestCase):
    def test_rejects_unknown_scenarios_including_retired_branch_alias(self) -> None:
        repo_root = _package_root().resolve()

        with self.assertRaisesRegex(ValueError, "unknown orchestrator regression scenarios: branch"):
            run_orchestrator_regression(
                OrchestratorRegressionInputs(
                    tag="T-orchestrator-regression-invalid-scenario",
                    scenarios=("branch",),
                    timeout_seconds=30,
                ),
                repo_root=repo_root,
            )

    def test_computation_regression_uses_external_project_root(self) -> None:
        repo_root = _package_root().resolve()
        tag = "T-orchestrator-regression-computation"
        regression_root = repo_root / "artifacts" / "runs" / tag
        computation_root = repo_root / "artifacts" / "runs" / f"{tag}-computation"

        shutil.rmtree(regression_root, ignore_errors=True)
        shutil.rmtree(computation_root, ignore_errors=True)
        try:
            result = run_orchestrator_regression(
                OrchestratorRegressionInputs(
                    tag=tag,
                    scenarios=("computation",),
                    timeout_seconds=180,
                ),
                repo_root=repo_root,
            )

            self.assertEqual(result.get("errors"), [], msg=str(result))

            analysis = json.loads(
                (regression_root / "orchestrator_regression" / "analysis.json").read_text(encoding="utf-8")
            )
            results = analysis.get("results") or {}
            computation = results.get("computation") or {}

            self.assertEqual(results.get("orchestrator_init_exit_code"), 0)
            self.assertEqual(computation.get("pending_category"), "A3")
            self.assertEqual(computation.get("gate_exit_code"), 3)
            self.assertEqual(computation.get("approve_exit_code"), 0)
            self.assertEqual(computation.get("final_exit_code"), 0)

            expected_outputs = computation.get("expected_outputs") or {}
            for key in ("run_card", "manifest", "summary", "analysis", "report"):
                self.assertTrue((repo_root / str(expected_outputs.get(key) or "")).exists(), msg=key)
        finally:
            shutil.rmtree(regression_root, ignore_errors=True)
            shutil.rmtree(computation_root, ignore_errors=True)

    def test_project_init_regression_mirrors_external_project_anchor(self) -> None:
        repo_root = _package_root().resolve()
        tag = f"T-orchestrator-regression-project-init-{uuid.uuid4().hex[:8]}"
        regression_root = repo_root / "artifacts" / "runs" / tag
        out_dir = regression_root / "orchestrator_regression"

        shutil.rmtree(regression_root, ignore_errors=True)
        try:
            result = run_orchestrator_regression(
                OrchestratorRegressionInputs(
                    tag=tag,
                    scenarios=("project_init",),
                    timeout_seconds=180,
                ),
                repo_root=repo_root,
            )

            self.assertEqual(result.get("errors"), [], msg=json.dumps(result, indent=2, sort_keys=True))

            analysis = json.loads((out_dir / "analysis.json").read_text(encoding="utf-8"))
            project_init = ((analysis.get("results") or {}).get("project_init") or {})
            expected_outputs = project_init.get("expected_outputs") or {}
            expected_project_root = f"artifacts/runs/{tag}/orchestrator_regression/project_init_project"

            self.assertEqual(project_init.get("project_root"), expected_project_root)
            self.assertEqual(expected_outputs.get("project_root"), expected_project_root)
            self.assertTrue((repo_root / expected_project_root / ".autoresearch" / "state.json").exists())
            self.assertTrue((repo_root / str(expected_outputs.get("approval_packet") or "")).exists())

            init_log = (out_dir / "logs" / "init.txt").read_text(encoding="utf-8")
            self.assertNotIn("must resolve outside the autoresearch-lab dev repo", init_log)

            status_log = (out_dir / "logs" / "project_init_status_subdir.txt").read_text(encoding="utf-8")
            self.assertIn("<EXTERNAL_PROJECT_ROOT>", status_log)
        finally:
            shutil.rmtree(regression_root, ignore_errors=True)
