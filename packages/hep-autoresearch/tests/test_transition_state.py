"""Tests for H-09: Idempotent CAS (transition_state) and H-10 event validation in append_ledger_event."""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from hep_autoresearch.toolkit.orchestrator_state import (
    append_ledger_event,
    default_state,
    ensure_runtime_dirs,
    save_state,
    transition_state,
)


class TestAppendLedgerEventValidation(unittest.TestCase):
    """H-10: append_ledger_event rejects unknown event types."""

    def test_valid_event_type(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            ensure_runtime_dirs(root)
            # Should not raise
            append_ledger_event(
                root,
                event_type="initialized",
                run_id=None,
                workflow_id=None,
            )

    def test_invalid_event_type_raises(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            ensure_runtime_dirs(root)
            with self.assertRaises(ValueError) as ctx:
                append_ledger_event(
                    root,
                    event_type="totally_invalid_event",
                    run_id=None,
                    workflow_id=None,
                )
            self.assertIn("totally_invalid_event", str(ctx.exception))

    def test_trace_id_is_written_when_provided(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            ensure_runtime_dirs(root)
            append_ledger_event(
                root,
                event_type="initialized",
                run_id=None,
                workflow_id=None,
                trace_id="trace-123",
            )
            ledger_file = root / ".autoresearch" / "ledger.jsonl"
            event = json.loads(ledger_file.read_text(encoding="utf-8").strip())
            self.assertEqual(event["trace_id"], "trace-123")


class TestTransitionState(unittest.TestCase):
    """H-09: CAS state transition."""

    def _setup_state(self, td: str, run_id: str = "run_001", status: str = "running") -> Path:
        root = Path(td)
        state = default_state()
        state["run_id"] = run_id
        state["run_status"] = status
        save_state(root, state)
        return root

    def test_successful_transition(self) -> None:
        with TemporaryDirectory() as td:
            root = self._setup_state(td, run_id="run_001", status="running")
            result = transition_state(
                root,
                run_id="run_001",
                expected_status="running",
                new_status="paused",
            )
            self.assertTrue(result)

            # Verify state was persisted
            state_file = root / ".autoresearch" / "state.json"
            state = json.loads(state_file.read_text())
            self.assertEqual(state["run_status"], "paused")

    def test_cas_failure_wrong_status(self) -> None:
        with TemporaryDirectory() as td:
            root = self._setup_state(td, run_id="run_001", status="running")
            with self.assertRaises(ValueError) as ctx:
                transition_state(
                    root,
                    run_id="run_001",
                    expected_status="paused",  # wrong!
                    new_status="running",
                )
            self.assertIn("CAS failure", str(ctx.exception))
            self.assertIn("paused", str(ctx.exception))
            self.assertIn("running", str(ctx.exception))

    def test_cas_failure_wrong_run_id(self) -> None:
        with TemporaryDirectory() as td:
            root = self._setup_state(td, run_id="run_001", status="running")
            with self.assertRaises(ValueError) as ctx:
                transition_state(
                    root,
                    run_id="run_999",  # wrong!
                    expected_status="running",
                    new_status="paused",
                )
            self.assertIn("CAS failure", str(ctx.exception))
            self.assertIn("run_id mismatch", str(ctx.exception))

    def test_cas_failure_no_state(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaises(ValueError) as ctx:
                transition_state(
                    root,
                    run_id="run_001",
                    expected_status="running",
                    new_status="paused",
                )
            self.assertIn("no state file", str(ctx.exception))

    def test_transition_writes_ledger_event(self) -> None:
        with TemporaryDirectory() as td:
            root = self._setup_state(td, run_id="run_001", status="running")
            transition_state(
                root,
                run_id="run_001",
                expected_status="running",
                new_status="paused",
            )

            ledger_file = root / ".autoresearch" / "ledger.jsonl"
            lines = [l for l in ledger_file.read_text().splitlines() if l.strip()]
            last_event = json.loads(lines[-1])
            self.assertEqual(last_event["event_type"], "state_transition")
            self.assertEqual(last_event["details"]["from"], "running")
            self.assertEqual(last_event["details"]["to"], "paused")


if __name__ == "__main__":
    unittest.main()
