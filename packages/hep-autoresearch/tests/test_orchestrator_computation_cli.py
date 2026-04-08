import json
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestOrchestratorWComputeCLI(unittest.TestCase):
    def test_run_w_compute(self) -> None:
        import sys
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.orchestrator_cli import main as cli_main

        def run_cli(argv: list[str]) -> int:
            argv0 = list(sys.argv)
            try:
                sys.argv = list(argv)
                buf_out, buf_err = StringIO(), StringIO()
                with redirect_stdout(buf_out), redirect_stderr(buf_err):
                    return int(cli_main())
            finally:
                sys.argv = argv0

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)

            # Init creates the minimal scaffold required by the context pack and run state.
            self.assertEqual(run_cli(["hepar", "--project-root", str(repo_root), "init"]), 0)

            # Disable A3 compute approval for this integration-style test.
            policy_path = repo_root / ".autoresearch" / "approval_policy.json"
            policy = json.loads(policy_path.read_text(encoding="utf-8"))
            policy.setdefault("require_approval_for", {})["compute_runs"] = False
            policy_path.write_text(json.dumps(policy, indent=2, sort_keys=True) + "\n", encoding="utf-8")

            # Minimal computation project + run_card v2.
            proj = repo_root / "proj"
            (proj / "run_cards").mkdir(parents=True, exist_ok=True)
            (proj / "scripts").mkdir(parents=True, exist_ok=True)
            (proj / "results").mkdir(parents=True, exist_ok=True)

            script = proj / "scripts" / "write_ok.py"
            script.write_text(
                "from __future__ import annotations\n"
                "import json\n"
                "from pathlib import Path\n"
                "Path('results').mkdir(parents=True, exist_ok=True)\n"
                "Path('results/ok.json').write_text(json.dumps({'ok': True}) + '\\n', encoding='utf-8')\n",
                encoding="utf-8",
            )

            run_card = {
                "schema_version": 2,
                "run_id": "IGNORED",  # overridden by --run-id
                "workflow_id": "computation",
                "title": "minimal",
                "phases": [
                    {
                        "phase_id": "p1",
                        "backend": {"kind": "shell", "argv": [sys.executable, "scripts/write_ok.py"], "cwd": "."},
                        "outputs": ["results/ok.json"],
                    }
                ],
            }
            run_card_path = proj / "run_cards" / "basic.json"
            run_card_path.write_text(json.dumps(run_card, indent=2) + "\n", encoding="utf-8")

            # Run computation via hepar CLI.
            rc = run_cli(
                [
                    "hepar",
                    "--project-root",
                    str(repo_root),
                    "run",
                    "--run-id",
                    "M1-test-computation-cli",
                    "--workflow-id",
                    "computation",
                    "--run-card",
                    str(run_card_path),
                    "--trust-project",
                ]
            )
            self.assertEqual(rc, 0)

            out_dir = repo_root / "artifacts" / "runs" / "M1-test-computation-cli" / "computation"
            analysis = json.loads((out_dir / "analysis.json").read_text(encoding="utf-8"))
            self.assertEqual(((analysis.get("results") or {}).get("status")), "completed")
            self.assertTrue((out_dir / "phases" / "p1" / "results" / "ok.json").exists())

    def test_computation_phase_gate_requests_approval(self) -> None:
        import sys
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.orchestrator_cli import main as cli_main

        def run_cli(argv: list[str]) -> int:
            argv0 = list(sys.argv)
            try:
                sys.argv = list(argv)
                buf_out, buf_err = StringIO(), StringIO()
                with redirect_stdout(buf_out), redirect_stderr(buf_err):
                    return int(cli_main())
            finally:
                sys.argv = argv0

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)

            self.assertEqual(run_cli(["hepar", "--project-root", str(repo_root), "init"]), 0)

            # Disable the *default* compute gate (A3) so we can exercise phase-level gates inside computation.
            policy_path = repo_root / ".autoresearch" / "approval_policy.json"
            policy = json.loads(policy_path.read_text(encoding="utf-8"))
            policy.setdefault("require_approval_for", {})["compute_runs"] = False
            policy_path.write_text(json.dumps(policy, indent=2, sort_keys=True) + "\n", encoding="utf-8")

            proj = repo_root / "proj"
            (proj / "run_cards").mkdir(parents=True, exist_ok=True)
            (proj / "scripts").mkdir(parents=True, exist_ok=True)
            (proj / "results").mkdir(parents=True, exist_ok=True)

            script = proj / "scripts" / "write_ok.py"
            script.write_text(
                "from __future__ import annotations\n"
                "import json\n"
                "from pathlib import Path\n"
                "Path('results').mkdir(parents=True, exist_ok=True)\n"
                "Path('results/ok.json').write_text(json.dumps({'ok': True}) + '\\n', encoding='utf-8')\n",
                encoding="utf-8",
            )

            run_card = {
                "schema_version": 2,
                "run_id": "IGNORED",
                "workflow_id": "computation",
                "title": "phase gate",
                "phases": [
                    {
                        "phase_id": "p1",
                        "gates": ["A1"],
                        "backend": {"kind": "shell", "argv": [sys.executable, "scripts/write_ok.py"], "cwd": "."},
                        "outputs": ["results/ok.json"],
                    }
                ],
            }
            run_card_path = proj / "run_cards" / "gate.json"
            run_card_path.write_text(json.dumps(run_card, indent=2) + "\n", encoding="utf-8")

            rc = run_cli(
                [
                    "hepar",
                    "--project-root",
                    str(repo_root),
                    "run",
                    "--run-id",
                    "M2-test-computation-gate",
                    "--workflow-id",
                    "computation",
                    "--run-card",
                    str(run_card_path),
                    "--trust-project",
                ]
            )
            self.assertEqual(rc, 3)

            out_dir = repo_root / "artifacts" / "runs" / "M2-test-computation-gate" / "computation"
            analysis = json.loads((out_dir / "analysis.json").read_text(encoding="utf-8"))
            self.assertEqual(((analysis.get("results") or {}).get("status")), "blocked_by_gate")

            state = json.loads((repo_root / ".autoresearch" / "state.json").read_text(encoding="utf-8"))
            pending = state.get("pending_approval")
            self.assertIsInstance(pending, dict)
            self.assertEqual((pending or {}).get("category"), "A1")
            self.assertEqual(state.get("run_status"), "awaiting_approval")

            packet_rel = (pending or {}).get("packet_path")
            self.assertIsInstance(packet_rel, str)
            self.assertTrue((repo_root / str(packet_rel)).exists())

    def test_internal_parser_rejects_run_card_command(self) -> None:
        import sys
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.orchestrator_cli import main as cli_main

        argv0 = list(sys.argv)
        try:
            sys.argv = ["hepar", "run-card", "validate"]
            buf_out, buf_err = StringIO(), StringIO()
            with redirect_stdout(buf_out), redirect_stderr(buf_err):
                with self.assertRaises(SystemExit) as exc:
                    cli_main()
        finally:
            sys.argv = argv0

        self.assertEqual(int(exc.exception.code), 2)
        self.assertIn("invalid choice", buf_err.getvalue())
        self.assertIn("run-card", buf_err.getvalue())
