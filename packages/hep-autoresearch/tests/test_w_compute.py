import json
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestWCompute(unittest.TestCase):
    def test_w_compute_minimal_single_phase(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.w_compute import WComputeInputs, w_compute_one

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            project_dir = repo_root / "proj"
            (project_dir / "scripts").mkdir(parents=True, exist_ok=True)
            (project_dir / "results").mkdir(parents=True, exist_ok=True)

            # Script writes one declared output under the project working directory.
            script = project_dir / "scripts" / "write_ok.py"
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
                "run_id": "IGNORED",  # overridden by tag
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
            run_card_path = project_dir / "card.json"
            run_card_path.write_text(json.dumps(run_card, indent=2) + "\n", encoding="utf-8")

            res = w_compute_one(
                WComputeInputs(
                    tag="M1-test-wcompute",
                    project_dir=str(project_dir),
                    run_card=str(run_card_path),
                    trust_project=True,
                    resume=False,
                ),
                repo_root=repo_root,
            )

            self.assertEqual(res.get("errors") or [], [])
            out = repo_root / "artifacts" / "runs" / "M1-test-wcompute" / "w_compute"
            self.assertTrue((out / "manifest.json").exists())
            self.assertTrue((out / "summary.json").exists())
            self.assertTrue((out / "analysis.json").exists())
            self.assertTrue((out / "report.md").exists())
            self.assertTrue((out / "phases" / "p1" / "results" / "ok.json").exists())

            analysis = json.loads((out / "analysis.json").read_text(encoding="utf-8"))
            self.assertEqual(((analysis.get("results") or {}).get("status")), "completed")
            self.assertTrue(bool(((analysis.get("results") or {}).get("ok"))))

    def test_w_compute_report_renders_headline_numbers_and_acceptance_checks(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.w_compute import WComputeInputs, w_compute_one

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            project_dir = repo_root / "proj"
            (project_dir / "scripts").mkdir(parents=True, exist_ok=True)
            (project_dir / "results").mkdir(parents=True, exist_ok=True)

            script = project_dir / "scripts" / "write_vals.py"
            script.write_text(
                "from __future__ import annotations\n"
                "import json\n"
                "from pathlib import Path\n"
                "Path('results').mkdir(parents=True, exist_ok=True)\n"
                "Path('results/out.json').write_text(json.dumps({'a': 1.234, 'b': 5.0}) + '\\n', encoding='utf-8')\n",
                encoding="utf-8",
            )

            run_card = {
                "schema_version": 2,
                "run_id": "IGNORED",
                "workflow_id": "W_compute",
                "title": "report",
                "phases": [
                    {
                        "phase_id": "p1",
                        "backend": {"kind": "shell", "argv": [sys.executable, "scripts/write_vals.py"], "cwd": "."},
                        "outputs": ["results/out.json"],
                    }
                ],
                "headline_numbers": {
                    "source": "phases/p1/results/out.json",
                    "extract": [
                        {"pointer": "#/a", "label": "a", "tier": "T1"},
                        {"pointer": "#/b", "label": "b", "tier": "T2"},
                    ],
                },
                "acceptance": {
                    "json_numeric_checks": [
                        {"path": "phases/p1/results/out.json", "pointer": "#/a", "min": 1.0, "max": 2.0},
                        {"path": "phases/p1/results/out.json", "pointer": "#/b", "min": 4.0, "max": 6.0},
                    ]
                },
            }
            run_card_path = project_dir / "card.json"
            run_card_path.write_text(json.dumps(run_card, indent=2) + "\n", encoding="utf-8")

            res = w_compute_one(
                WComputeInputs(
                    tag="M1-test-wcompute-report",
                    project_dir=str(project_dir),
                    run_card=str(run_card_path),
                    trust_project=True,
                    resume=False,
                ),
                repo_root=repo_root,
            )
            self.assertEqual(res.get("errors") or [], [])

            out = repo_root / "artifacts" / "runs" / "M1-test-wcompute-report" / "w_compute"
            report = (out / "report.md").read_text(encoding="utf-8")
            self.assertIn("### Headline numbers", report)
            self.assertIn("### Acceptance checks", report)
            self.assertIn("phases/p1/results/out.json#/a", report)
            self.assertIn("phases/p1/results/out.json#/b", report)

    def test_w_compute_resume_crash_recovery_running_to_failed(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.w_compute import WComputeInputs, w_compute_one
        from hep_autoresearch.toolkit.adapters.artifacts import sha256_json

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            project_dir = repo_root / "proj"
            (project_dir / "scripts").mkdir(parents=True, exist_ok=True)
            (project_dir / "results").mkdir(parents=True, exist_ok=True)

            script = project_dir / "scripts" / "write_ok.py"
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
                "title": "minimal",
                "phases": [
                    {
                        "phase_id": "p1",
                        "backend": {"kind": "shell", "argv": [sys.executable, "scripts/write_ok.py"], "cwd": "."},
                        "outputs": ["results/ok.json"],
                    }
                ],
            }
            run_card_path = project_dir / "card.json"
            run_card_path.write_text(json.dumps(run_card, indent=2) + "\n", encoding="utf-8")

            # Seed a phase_state.json that simulates a crash mid-phase (RUNNING).
            out = repo_root / "artifacts" / "runs" / "M2-test-wcompute" / "w_compute"
            out.mkdir(parents=True, exist_ok=True)
            phase_state = {
                "schema_version": 1,
                "created_at": "2026-02-08T00:00:00Z",
                "updated_at": "2026-02-08T00:00:00Z",
                "run_id": "M2-test-wcompute",
                "workflow_id": "W_compute",
                "project_dir": str(project_dir),
                "workspace_dir": str(out),
                "run_card_sha256": sha256_json(run_card),
                "phases": {
                    "p1": {"status": "RUNNING", "attempts": 1, "last_exit_code": None, "last_error": None, "updated_at": None}
                },
                "run_status": "RUNNING",
            }
            (out / "phase_state.json").write_text(json.dumps(phase_state, indent=2) + "\n", encoding="utf-8")

            res = w_compute_one(
                WComputeInputs(
                    tag="M2-test-wcompute",
                    project_dir=str(project_dir),
                    run_card=str(run_card_path),
                    trust_project=True,
                    resume=True,
                ),
                repo_root=repo_root,
            )

            self.assertEqual(res.get("errors") or [], [])
            self.assertTrue((out / "phases" / "p1" / "results" / "ok.json").exists())
            st = json.loads((out / "phase_state.json").read_text(encoding="utf-8"))
            self.assertEqual(((st.get("phases") or {}).get("p1") or {}).get("status"), "SUCCEEDED")

    def test_w_compute_cycle_detection_raises(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.w_compute import WComputeInputs, w_compute_one

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            project_dir = repo_root / "proj"
            project_dir.mkdir(parents=True, exist_ok=True)

            run_card = {
                "schema_version": 2,
                "run_id": "IGNORED",
                "workflow_id": "W_compute",
                "title": "cycle",
                "phases": [
                    {
                        "phase_id": "a",
                        "depends_on": ["b"],
                        "backend": {"kind": "shell", "argv": ["true"], "cwd": "."},
                        "outputs": ["a.txt"],
                    },
                    {
                        "phase_id": "b",
                        "depends_on": ["a"],
                        "backend": {"kind": "shell", "argv": ["true"], "cwd": "."},
                        "outputs": ["b.txt"],
                    },
                ],
            }
            run_card_path = project_dir / "card.json"
            run_card_path.write_text(json.dumps(run_card, indent=2) + "\n", encoding="utf-8")

            with self.assertRaises(ValueError):
                w_compute_one(
                    WComputeInputs(
                        tag="M3-test-wcompute",
                        project_dir=str(project_dir),
                        run_card=str(run_card_path),
                        trust_project=True,
                        resume=False,
                    ),
                    repo_root=repo_root,
                )

    def test_w_compute_on_failure_continue_runs_independent_phase(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.w_compute import WComputeInputs, w_compute_one

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            project_dir = repo_root / "proj"
            (project_dir / "scripts").mkdir(parents=True, exist_ok=True)
            (project_dir / "results").mkdir(parents=True, exist_ok=True)

            ok_script = project_dir / "scripts" / "ok.py"
            ok_script.write_text(
                "from __future__ import annotations\n"
                "import json\n"
                "from pathlib import Path\n"
                "Path('results').mkdir(parents=True, exist_ok=True)\n"
                "Path('results/ok.json').write_text(json.dumps({'ok': True}) + '\\n', encoding='utf-8')\n",
                encoding="utf-8",
            )

            fail_script = project_dir / "scripts" / "fail.py"
            fail_script.write_text("raise SystemExit(2)\n", encoding="utf-8")

            run_card = {
                "schema_version": 2,
                "run_id": "IGNORED",
                "workflow_id": "W_compute",
                "title": "continue",
                "on_failure": "continue",
                "phases": [
                    {
                        "phase_id": "a_fail",
                        "backend": {"kind": "shell", "argv": [sys.executable, "scripts/fail.py"], "cwd": "."},
                        "outputs": ["results/fail.json"],
                    },
                    {
                        "phase_id": "b_ok",
                        "backend": {"kind": "shell", "argv": [sys.executable, "scripts/ok.py"], "cwd": "."},
                        "outputs": ["results/ok.json"],
                    },
                ],
            }
            run_card_path = project_dir / "card.json"
            run_card_path.write_text(json.dumps(run_card, indent=2) + "\n", encoding="utf-8")

            res = w_compute_one(
                WComputeInputs(
                    tag="M4-test-wcompute",
                    project_dir=str(project_dir),
                    run_card=str(run_card_path),
                    trust_project=True,
                    resume=False,
                ),
                repo_root=repo_root,
            )

            out = repo_root / "artifacts" / "runs" / "M4-test-wcompute" / "w_compute"
            self.assertTrue((out / "phases" / "b_ok" / "results" / "ok.json").exists())
            st = json.loads((out / "phase_state.json").read_text(encoding="utf-8"))
            self.assertEqual(((st.get("phases") or {}).get("a_fail") or {}).get("status"), "FAILED")
            self.assertEqual(((st.get("phases") or {}).get("b_ok") or {}).get("status"), "SUCCEEDED")
            # Overall run should still be marked as failed (since a_fail failed).
            analysis = json.loads((out / "analysis.json").read_text(encoding="utf-8"))
            self.assertEqual(((analysis.get("results") or {}).get("status")), "failed")
            self.assertTrue(bool(res.get("errors")))
