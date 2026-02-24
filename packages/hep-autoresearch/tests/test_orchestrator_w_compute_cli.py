import json
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestOrchestratorWComputeCLI(unittest.TestCase):
    def test_run_card_render_mermaid(self) -> None:
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

            proj = repo_root / "proj"
            (proj / "run_cards").mkdir(parents=True, exist_ok=True)
            (proj / "scripts").mkdir(parents=True, exist_ok=True)
            (proj / "results").mkdir(parents=True, exist_ok=True)

            # The scripts are not executed by render; they exist to keep the run-card realistic.
            (proj / "scripts" / "p1.py").write_text("print('p1')\n", encoding="utf-8")
            (proj / "scripts" / "p2.py").write_text("print('p2')\n", encoding="utf-8")

            run_card = {
                "schema_version": 2,
                "run_id": "IGNORED",
                "workflow_id": "W_compute",
                "title": "render",
                "phases": [
                    {
                        "phase_id": "p1",
                        "backend": {"kind": "shell", "argv": [sys.executable, "scripts/p1.py"], "cwd": "."},
                        "outputs": ["results/p1.txt"],
                    },
                    {
                        "phase_id": "p2",
                        "depends_on": ["p1"],
                        "backend": {"kind": "shell", "argv": [sys.executable, "scripts/p2.py"], "cwd": "."},
                        "inputs": ["phases/p1/results/p1.txt"],
                        "outputs": ["results/p2.txt"],
                    },
                ],
            }
            run_card_path = proj / "run_cards" / "render.json"
            run_card_path.write_text(json.dumps(run_card, indent=2) + "\n", encoding="utf-8")

            out_path = repo_root / "render.mmd"
            rc = run_cli(
                [
                    "hepar",
                    "--project-root",
                    str(repo_root),
                    "run-card",
                    "render",
                    "--run-card",
                    str(run_card_path),
                    "--format",
                    "mermaid",
                    "--out",
                    str(out_path),
                ]
            )
            self.assertEqual(rc, 0)
            txt = out_path.read_text(encoding="utf-8")
            self.assertIn("flowchart", txt)
            self.assertIn("p1 --> p2", txt)

    def test_run_card_validate_and_run_w_compute(self) -> None:
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
            policy_path = repo_root / ".autopilot" / "approval_policy.json"
            policy = json.loads(policy_path.read_text(encoding="utf-8"))
            policy.setdefault("require_approval_for", {})["compute_runs"] = False
            policy_path.write_text(json.dumps(policy, indent=2, sort_keys=True) + "\n", encoding="utf-8")

            # Minimal W_compute project + run_card v2.
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
                "workflow_id": "W_compute",
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

            # Validate run_card v2.
            rc = run_cli(
                [
                    "hepar",
                    "--project-root",
                    str(repo_root),
                    "run-card",
                    "validate",
                    "--run-card",
                    str(run_card_path),
                    "--run-id",
                    "M1-test-wcompute-cli",
                ]
            )
            self.assertEqual(rc, 0)

            # Run W_compute via hepar CLI.
            rc = run_cli(
                [
                    "hepar",
                    "--project-root",
                    str(repo_root),
                    "run",
                    "--run-id",
                    "M1-test-wcompute-cli",
                    "--workflow-id",
                    "W_compute",
                    "--run-card",
                    str(run_card_path),
                    "--trust-project",
                ]
            )
            self.assertEqual(rc, 0)

            out_dir = repo_root / "artifacts" / "runs" / "M1-test-wcompute-cli" / "w_compute"
            analysis = json.loads((out_dir / "analysis.json").read_text(encoding="utf-8"))
            self.assertEqual(((analysis.get("results") or {}).get("status")), "completed")
            self.assertTrue((out_dir / "phases" / "p1" / "results" / "ok.json").exists())

    def test_w_compute_phase_gate_requests_approval(self) -> None:
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

            # Disable the *default* compute gate (A3) so we can exercise phase-level gates inside W_compute.
            policy_path = repo_root / ".autopilot" / "approval_policy.json"
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
                "workflow_id": "W_compute",
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
                    "M2-test-wcompute-gate",
                    "--workflow-id",
                    "W_compute",
                    "--run-card",
                    str(run_card_path),
                    "--trust-project",
                ]
            )
            self.assertEqual(rc, 3)

            out_dir = repo_root / "artifacts" / "runs" / "M2-test-wcompute-gate" / "w_compute"
            analysis = json.loads((out_dir / "analysis.json").read_text(encoding="utf-8"))
            self.assertEqual(((analysis.get("results") or {}).get("status")), "blocked_by_gate")

            state = json.loads((repo_root / ".autopilot" / "state.json").read_text(encoding="utf-8"))
            pending = state.get("pending_approval")
            self.assertIsInstance(pending, dict)
            self.assertEqual((pending or {}).get("category"), "A1")
            self.assertEqual(state.get("run_status"), "awaiting_approval")

            packet_rel = (pending or {}).get("packet_path")
            self.assertIsInstance(packet_rel, str)
            self.assertTrue((repo_root / str(packet_rel)).exists())
