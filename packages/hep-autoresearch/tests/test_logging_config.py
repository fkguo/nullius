"""Tests for structured JSONL logging (trace-jsonl)."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest

from hep_autoresearch.toolkit.logging_config import (
    JSONL_EVENT_TYPES,
    JsonlFormatter,
    StructuredLogger,
    configure_logging,
)


class TestJsonlFormatter:
    def test_produces_valid_json(self) -> None:
        fmt = JsonlFormatter("test_component")
        record = logging.LogRecord(
            name="test",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="hello",
            args=(),
            exc_info=None,
        )
        line = fmt.format(record)
        parsed = json.loads(line)
        assert parsed["component"] == "test_component"
        assert parsed["level"] == "INFO"
        assert "ts" in parsed

    def test_includes_trace_id(self) -> None:
        fmt = JsonlFormatter("test")
        record = logging.LogRecord(
            name="test", level=logging.INFO, pathname="", lineno=0,
            msg="ev", args=(), exc_info=None,
        )
        record.trace_id = "abc-123"  # type: ignore[attr-defined]
        record.event = "step_started"  # type: ignore[attr-defined]
        record.data = {"step": 1}  # type: ignore[attr-defined]
        line = fmt.format(record)
        parsed = json.loads(line)
        assert parsed["trace_id"] == "abc-123"
        assert parsed["event"] == "step_started"
        assert parsed["data"] == {"step": 1}

    def test_parseable_by_jq(self, tmp_path: Path) -> None:
        """JSONL output must be parseable by jq (verification: valid JSON per line)."""
        fmt = JsonlFormatter("orchestrator")
        lines = []
        for i in range(5):
            record = logging.LogRecord(
                name="test", level=logging.INFO, pathname="", lineno=0,
                msg=f"event_{i}", args=(), exc_info=None,
            )
            record.trace_id = f"trace-{i}"  # type: ignore[attr-defined]
            record.event = f"event_{i}"  # type: ignore[attr-defined]
            record.data = {"index": i}  # type: ignore[attr-defined]
            lines.append(fmt.format(record))

        # Verify each line is valid JSON
        for line in lines:
            parsed = json.loads(line)
            assert "ts" in parsed
            assert "trace_id" in parsed


class TestStructuredLogger:
    def test_info_emits_record(self, tmp_path: Path) -> None:
        log_file = tmp_path / "test.jsonl"
        slog = configure_logging(
            "test_component",
            log_file=str(log_file),
            level=logging.DEBUG,
            stderr_human=False,
        )
        slog.trace_id = "trace-xyz"
        slog.info("step_started", {"step_id": "s1", "workflow": "ingest"})

        content = log_file.read_text(encoding="utf-8").strip()
        assert content
        parsed = json.loads(content)
        assert parsed["component"] == "test_component"
        assert parsed["trace_id"] == "trace-xyz"
        assert parsed["event"] == "step_started"
        assert parsed["data"]["step_id"] == "s1"

    def test_trace_id_override(self, tmp_path: Path) -> None:
        log_file = tmp_path / "test.jsonl"
        slog = configure_logging(
            "orchestrator",
            log_file=str(log_file),
            stderr_human=False,
        )
        slog.trace_id = "default-trace"
        slog.info("event_a", trace_id="override-trace")

        content = log_file.read_text(encoding="utf-8").strip()
        parsed = json.loads(content)
        assert parsed["trace_id"] == "override-trace"

    def test_multiple_levels(self, tmp_path: Path) -> None:
        log_file = tmp_path / "test.jsonl"
        slog = configure_logging(
            "ledger",
            log_file=str(log_file),
            level=logging.DEBUG,
            stderr_human=False,
        )
        slog.debug("debug_event")
        slog.info("info_event")
        slog.warning("warn_event")
        slog.error("error_event")

        lines = log_file.read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 4
        levels = [json.loads(line)["level"] for line in lines]
        assert levels == ["DEBUG", "INFO", "WARNING", "ERROR"]


class TestConfigureLogging:
    def test_env_log_file(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        log_file = tmp_path / "env.jsonl"
        monkeypatch.setenv("HEP_LOG_FILE", str(log_file))
        slog = configure_logging("mcp_client", stderr_human=False)
        slog.info("test_event")
        assert log_file.exists()
        parsed = json.loads(log_file.read_text(encoding="utf-8").strip())
        assert parsed["component"] == "mcp_client"

    def test_no_file_no_crash(self) -> None:
        slog = configure_logging("test", stderr_human=False)
        slog.info("should_not_crash")


class TestTraceIdSpanning:
    """Verify trace_id spans across components (orchestrator → ledger → mcp_client)."""

    def test_same_trace_id_across_components(self, tmp_path: Path) -> None:
        log_file = tmp_path / "unified.jsonl"
        trace = "unified-trace-001"

        for component in ("orchestrator", "ledger", "mcp_client"):
            slog = configure_logging(
                component,
                log_file=str(log_file),
                stderr_human=False,
            )
            slog.info(f"{component}_event", {"detail": component}, trace_id=trace)

        lines = log_file.read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 3
        for line in lines:
            parsed = json.loads(line)
            assert parsed["trace_id"] == trace

        components = [json.loads(line)["component"] for line in lines]
        assert set(components) == {"orchestrator", "ledger", "mcp_client"}


class TestJsonlEventTypes:
    """Verify pre-defined event types for EVO-12a readiness."""

    def test_required_events_defined(self) -> None:
        required = {"file_edit", "fix_applied", "tool_call", "skill_invoked"}
        assert required.issubset(set(JSONL_EVENT_TYPES.keys()))

    def test_each_has_description_and_schema(self) -> None:
        for name, spec in JSONL_EVENT_TYPES.items():
            assert "description" in spec, f"{name} missing description"
            assert "data_schema" in spec, f"{name} missing data_schema"

    def test_tool_call_schema_matches_track_b_contract(self) -> None:
        schema = JSONL_EVENT_TYPES["tool_call"]["data_schema"]
        assert '"tool_name"' in schema
        assert '"params"' in schema
        assert '"result_status"' in schema
        assert '"duration_ms"' in schema
