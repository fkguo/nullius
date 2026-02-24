import json
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestRunQualityMetrics(unittest.TestCase):
    def test_build_run_quality_metrics_minimal(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.run_quality_metrics import build_run_quality_metrics, validate_run_quality_metrics

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            runtime_dir = repo_root / ".autopilot"
            runtime_dir.mkdir(parents=True, exist_ok=True)
            ledger_path = runtime_dir / "ledger.jsonl"
            ledger_path.write_text(
                "\n".join(
                    [
                        json.dumps({"ts": "2026-02-01T00:00:00Z", "event_type": "run_started", "run_id": "R1", "workflow_id": "W2"}),
                        json.dumps(
                            {
                                "ts": "2026-02-01T00:00:01Z",
                                "event_type": "approval_requested",
                                "run_id": "R1",
                                "workflow_id": "W2",
                                "details": {"category": "A3"},
                            }
                        ),
                        json.dumps(
                            {
                                "ts": "2026-02-01T00:00:02Z",
                                "event_type": "approval_approved",
                                "run_id": "R1",
                                "workflow_id": "W2",
                                "details": {"category": "A3"},
                            }
                        ),
                        json.dumps({"ts": "2026-02-01T00:00:03Z", "event_type": "completed", "run_id": "R1", "workflow_id": "W2"}),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            run_dir = repo_root / "artifacts" / "runs" / "R1"
            run_dir.mkdir(parents=True, exist_ok=True)
            (run_dir / "dummy.txt").write_text("x\n", encoding="utf-8")

            payload = build_run_quality_metrics(
                repo_root=repo_root,
                run_id="R1",
                workflow_id="W2",
                ledger_path=ledger_path,
                run_dir=run_dir,
            )
            validate_run_quality_metrics(payload)
            self.assertEqual(payload["run_id"], "R1")
            self.assertEqual(payload.get("workflow_id"), "W2")
            self.assertGreaterEqual(payload["ledger"]["total_events"], 1)
            self.assertTrue(payload["artifacts"]["run_dir_exists"])

