import json
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestOrchestratorStatusRevisionReconcile(unittest.TestCase):
    def _run_cli(self, repo_root: Path, argv: list[str]) -> tuple[int, str, str]:
        import sys
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO

        src_root = str(_src_root())
        added_path = False
        if src_root not in sys.path:
            sys.path.insert(0, src_root)
            added_path = True

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
            if added_path:
                try:
                    sys.path.remove(src_root)
                except ValueError:
                    pass

    def _write_state(self, repo_root: Path, *, run_id: str) -> None:
        ap = repo_root / ".autoresearch"
        ap.mkdir(parents=True, exist_ok=True)
        state = {
            "schema_version": 1,
            "run_id": run_id,
            "workflow_id": "paper_reviser",
            "run_status": "running",
            "current_step": {
                "step_id": "paper_reviser.round_01",
                "title": "Step A",
                "started_at": "2026-02-11T00:00:00Z",
            },
            "plan": {
                "schema_version": 1,
                "run_id": run_id,
                "workflow_id": "paper_reviser",
                "current_step_id": "paper_reviser.round_01",
                "steps": [
                    {"step_id": "paper_reviser.round_01", "status": "in_progress", "description": "A"},
                    {"step_id": "paper_reviser.verification_plan", "status": "pending", "description": "B"},
                    {"step_id": "paper_reviser.retrieval", "status": "pending", "description": "C"},
                    {"step_id": "paper_reviser.evidence_synthesis", "status": "pending", "description": "D"},
                    {"step_id": "paper_reviser.round_02", "status": "pending", "description": "E"},
                    {"step_id": "paper_reviser.apply", "status": "pending", "description": "APPLY"},
                ],
            },
            "plan_md_path": ".autoresearch/plan.md",
            "checkpoints": {"last_checkpoint_at": "2026-02-11T00:00:00Z", "checkpoint_interval_seconds": 900},
            "pending_approval": None,
            "approval_seq": {"A1": 0, "A2": 0, "A3": 0, "A4": 0, "A5": 0},
            "gate_satisfied": {},
            "approval_history": [],
            "artifacts": {},
            "notes": "",
        }
        (ap / "state.json").write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        (ap / "approval_policy.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "mode": "safe",
                    "require_approval_for": {
                        "mass_search": True,
                        "code_changes": True,
                        "compute_runs": True,
                        "paper_edits": True,
                        "final_conclusions": True,
                    },
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        (ap / "ledger.jsonl").write_text("", encoding="utf-8")

    def _manifest_path(self, repo_root: Path, run_id: str) -> Path:
        return repo_root / "artifacts" / "runs" / run_id / "paper_reviser" / "manifest.json"

    def test_case_a_reconcile_completed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            run_id = "R-REVISION-A"
            self._write_state(repo_root, run_id=run_id)
            mp = self._manifest_path(repo_root, run_id)
            mp.parent.mkdir(parents=True, exist_ok=True)
            mp.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "steps": {
                            "A": {"status": "completed"},
                            "B": {"status": "completed"},
                            "C": {"status": "completed"},
                            "D": {"status": "completed"},
                            "E": {"status": "completed"},
                            "APPLY": {"status": "completed"},
                        },
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            rc, out, _ = self._run_cli(repo_root, ["hepar", "--project-root", str(repo_root), "status", "--json"])
            self.assertEqual(rc, 0)
            data = json.loads(out)
            self.assertEqual(data.get("run_status"), "completed")
            self.assertTrue(bool(data.get("reconciled")))
            self.assertEqual(((data.get("revision_substeps") or {}).get("source")), "manifest")

    def test_case_b_manifest_partial_in_progress(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            run_id = "R-REVISION-B"
            self._write_state(repo_root, run_id=run_id)
            mp = self._manifest_path(repo_root, run_id)
            mp.parent.mkdir(parents=True, exist_ok=True)
            mp.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "steps": {
                            "A": {"status": "completed"},
                            "B": {"status": "completed"},
                            "C": {"status": "in_progress"},
                            "D": {"status": "pending"},
                            "E": {"status": "pending"},
                            "APPLY": {"status": "pending"},
                        },
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            rc, out, _ = self._run_cli(repo_root, ["hepar", "--project-root", str(repo_root), "status", "--json"])
            self.assertEqual(rc, 0)
            data = json.loads(out)
            self.assertEqual(data.get("run_status"), "in_progress")
            self.assertFalse(bool(data.get("reconciled")))
            self.assertEqual(((data.get("revision_substeps") or {}).get("source")), "manifest")
            statuses = ((data.get("revision_substeps") or {}).get("statuses")) or {}
            self.assertEqual(statuses.get("C"), "in_progress")

    def test_case_c_manifest_missing_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            run_id = "R-REVISION-C"
            self._write_state(repo_root, run_id=run_id)

            rc, out, _ = self._run_cli(repo_root, ["hepar", "--project-root", str(repo_root), "status", "--json"])
            self.assertEqual(rc, 0)
            data = json.loads(out)
            self.assertEqual(((data.get("revision_substeps") or {}).get("source")), "state")
            codes = [str(w.get("code")) for w in (data.get("warnings") or []) if isinstance(w, dict)]
            self.assertIn("revision_manifest_missing", codes)

    def test_case_d_manifest_steps_malformed_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            run_id = "R-REVISION-D"
            self._write_state(repo_root, run_id=run_id)
            mp = self._manifest_path(repo_root, run_id)
            mp.parent.mkdir(parents=True, exist_ok=True)
            mp.write_text(json.dumps({"schema_version": 1, "steps": {"A": {"status": "completed"}}}) + "\n", encoding="utf-8")

            rc, out, _ = self._run_cli(repo_root, ["hepar", "--project-root", str(repo_root), "status", "--json"])
            self.assertEqual(rc, 0)
            data = json.loads(out)
            self.assertEqual(((data.get("revision_substeps") or {}).get("source")), "state")
            codes = [str(w.get("code")) for w in (data.get("warnings") or []) if isinstance(w, dict)]
            self.assertIn("revision_manifest_steps_schema_invalid", codes)

    def test_status_stale_checkpoint_is_display_only_no_writeback(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            run_id = "R-REVISION-READONLY"
            self._write_state(repo_root, run_id=run_id)

            state_path = repo_root / ".autoresearch" / "state.json"
            before = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(before.get("run_status"), "running")

            rc, out, _ = self._run_cli(repo_root, ["hepar", "--project-root", str(repo_root), "status", "--json"])
            self.assertEqual(rc, 0)
            data = json.loads(out)
            self.assertEqual(data.get("run_status"), "needs_recovery")

            after = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(after.get("run_status"), "running")

            codes = [str(w.get("code")) for w in (data.get("warnings") or []) if isinstance(w, dict)]
            self.assertIn("checkpoint_stale", codes)


if __name__ == "__main__":
    unittest.main()
