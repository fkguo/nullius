import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _run_cli(argv: list[str]) -> int:
    rc, _, _ = _run_cli_capture(argv)
    return rc


def _run_cli_capture(argv: list[str]) -> tuple[int, str, str]:
    from hep_autoresearch.orchestrator_cli import main as cli_main

    argv0 = list(sys.argv)
    try:
        sys.argv = list(argv)
        buf_out, buf_err = StringIO(), StringIO()
        with redirect_stdout(buf_out), redirect_stderr(buf_err):
            rc = int(cli_main())
        return rc, buf_out.getvalue(), buf_err.getvalue()
    finally:
        sys.argv = argv0


def _disable_compute_approval(repo_root: Path) -> None:
    policy_path = repo_root / ".autoresearch" / "approval_policy.json"
    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    policy.setdefault("require_approval_for", {})["compute_runs"] = False
    policy_path.write_text(json.dumps(policy, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_run_card(project_dir: Path, *, script_name: str, script_body: str) -> Path:
    (project_dir / "run_cards").mkdir(parents=True, exist_ok=True)
    (project_dir / "scripts").mkdir(parents=True, exist_ok=True)
    (project_dir / "results").mkdir(parents=True, exist_ok=True)
    (project_dir / "scripts" / script_name).write_text(script_body, encoding="utf-8")
    run_card = {
        "schema_version": 2,
        "run_id": "IGNORED",
        "workflow_id": "computation",
        "title": script_name,
        "phases": [
            {
                "phase_id": "p1",
                "backend": {"kind": "shell", "argv": [sys.executable, f"scripts/{script_name}"], "cwd": "."},
                "outputs": ["results/out.json"],
            }
        ],
    }
    path = project_dir / "run_cards" / "main.json"
    path.write_text(json.dumps(run_card, indent=2) + "\n", encoding="utf-8")
    return path


class TestEvolutionTrigger(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        sys.path.insert(0, str(_src_root()))

    def test_trigger_is_idempotent_for_same_run(self) -> None:
        from hep_autoresearch.toolkit.evolution_trigger import trigger_evolution_proposal

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            _write_json(
                repo_root / "artifacts" / "runs" / "run-idem" / "computation" / "analysis.json",
                {"results": {"ok": False, "errors": ["missing required input file"]}},
            )

            first = trigger_evolution_proposal(
                repo_root=repo_root,
                run_id="run-idem",
                workflow_id="computation",
                terminal_status="completed",
            )
            second = trigger_evolution_proposal(
                repo_root=repo_root,
                run_id="run-idem",
                workflow_id="computation",
                terminal_status="completed",
            )

            self.assertEqual(first.status, "triggered")
            self.assertEqual(second.status, "skipped")
            self.assertEqual(second.reason, "already_exists")
            self.assertIn("analysis", second.artifact_paths or {})

    def test_trigger_returns_failed_when_proposal_generation_raises(self) -> None:
        from hep_autoresearch.toolkit.evolution_trigger import trigger_evolution_proposal

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            (repo_root / "artifacts" / "runs" / "run-exc").mkdir(parents=True, exist_ok=True)
            with patch(
                "hep_autoresearch.toolkit.evolution_trigger.evolution_proposal_one",
                side_effect=RuntimeError("boom"),
            ):
                result = trigger_evolution_proposal(
                    repo_root=repo_root,
                    run_id="run-exc",
                    workflow_id="computation",
                    terminal_status="failed",
                )

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.artifact_paths, None)
            self.assertIn("RuntimeError while auto-triggering computation: boom", result.reason or "")

    def test_cmd_run_completed_triggers_bounded_follow_up(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            self.assertEqual(_run_cli(["hepar", "--project-root", str(repo_root), "init"]), 0)
            _disable_compute_approval(repo_root)

            run_card_path = _write_run_card(
                repo_root / "proj-ok",
                script_name="write_ok.py",
                script_body=(
                    "from pathlib import Path\n"
                    "Path('results').mkdir(parents=True, exist_ok=True)\n"
                    "Path('results/out.json').write_text('{\"ok\": true}\\n', encoding='utf-8')\n"
                ),
            )

            rc = _run_cli(
                [
                    "hepar",
                    "--project-root",
                    str(repo_root),
                    "run",
                    "--run-id",
                    "run-ok",
                    "--workflow-id",
                    "computation",
                    "--run-card",
                    str(run_card_path),
                    "--trust-project",
                ]
            )
            self.assertEqual(rc, 0)

            analysis_path = repo_root / "artifacts" / "runs" / "run-ok" / "evolution_proposal" / "analysis.json"
            self.assertTrue(analysis_path.exists())
            analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
            self.assertEqual(((analysis.get("inputs") or {}).get("trigger_mode")), "auto_terminal")
            self.assertEqual(((analysis.get("inputs") or {}).get("terminal_status")), "completed")
            self.assertFalse((repo_root / "knowledge_base" / "methodology_traces").exists())

    def test_cmd_run_completed_warns_when_trigger_result_is_failed(self) -> None:
        from hep_autoresearch.toolkit.evolution_trigger import EvolutionTriggerResult

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            self.assertEqual(_run_cli(["hepar", "--project-root", str(repo_root), "init"]), 0)
            _disable_compute_approval(repo_root)

            run_card_path = _write_run_card(
                repo_root / "proj-warn",
                script_name="write_ok.py",
                script_body=(
                    "from pathlib import Path\n"
                    "Path('results').mkdir(parents=True, exist_ok=True)\n"
                    "Path('results/out.json').write_text('{\"ok\": true}\\n', encoding='utf-8')\n"
                ),
            )

            with patch(
                "hep_autoresearch.orchestrator_cli.trigger_evolution_proposal",
                return_value=EvolutionTriggerResult(status="failed", reason="simulated trigger failure"),
            ):
                rc, _, stderr = _run_cli_capture(
                    [
                        "hepar",
                        "--project-root",
                        str(repo_root),
                        "run",
                        "--run-id",
                        "run-warn",
                        "--workflow-id",
                        "computation",
                        "--run-card",
                        str(run_card_path),
                        "--trust-project",
                    ]
                )
            self.assertEqual(rc, 0)
            state = json.loads((repo_root / ".autoresearch" / "state.json").read_text(encoding="utf-8"))
            self.assertEqual(state.get("run_status"), "completed")
            self.assertIn("evolution trigger failed: simulated trigger failure", stderr)
            self.assertFalse((repo_root / "artifacts" / "runs" / "run-warn" / "evolution_proposal").exists())

    def test_cmd_run_failed_triggers_without_overwriting_failed_state(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            self.assertEqual(_run_cli(["hepar", "--project-root", str(repo_root), "init"]), 0)
            _disable_compute_approval(repo_root)

            run_card_path = _write_run_card(
                repo_root / "proj-fail",
                script_name="fail.py",
                script_body="raise SystemExit(1)\n",
            )

            rc = _run_cli(
                [
                    "hepar",
                    "--project-root",
                    str(repo_root),
                    "run",
                    "--run-id",
                    "run-fail",
                    "--workflow-id",
                    "computation",
                    "--run-card",
                    str(run_card_path),
                    "--trust-project",
                ]
            )
            self.assertEqual(rc, 2)

            state = json.loads((repo_root / ".autoresearch" / "state.json").read_text(encoding="utf-8"))
            self.assertEqual(state.get("run_status"), "failed")
            analysis = json.loads(
                (repo_root / "artifacts" / "runs" / "run-fail" / "evolution_proposal" / "analysis.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(((analysis.get("inputs") or {}).get("terminal_status")), "failed")


if __name__ == "__main__":
    unittest.main()
