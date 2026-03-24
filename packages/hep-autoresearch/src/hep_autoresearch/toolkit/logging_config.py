"""Structured JSONL logging configuration (trace-jsonl).

Provides a unified JSONL log format that spans across all components:
MCP server, orchestrator, and ledger.  Each log entry contains a ``trace_id``
for cross-component correlation.

Log output targets:
- **stderr**: human-readable format for CLI (unchanged)
- **file**:   JSONL format parseable by ``jq``

JSONL record format::

    {"ts": "...", "level": "INFO", "component": "orchestrator",
     "trace_id": "...", "event": "step_started", "data": {...}}
"""

from __future__ import annotations

import json
import logging
import os
import sys
from typing import Any


# ---------------------------------------------------------------------------
# JSONL formatter
# ---------------------------------------------------------------------------

class JsonlFormatter(logging.Formatter):
    """Format log records as single-line JSON (JSONL).

    Each output line is a JSON object with keys:
    ``ts``, ``level``, ``component``, ``trace_id``, ``event``, ``data``.
    """

    def __init__(self, component: str) -> None:
        super().__init__()
        self._component = component

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "ts": self.formatTime(record, datefmt="%Y-%m-%dT%H:%M:%S.%fZ"),
            "level": record.levelname,
            "component": self._component,
            "trace_id": getattr(record, "trace_id", None),
            "event": getattr(record, "event", record.getMessage().split(":")[0].strip() if record.getMessage() else "log"),
            "data": getattr(record, "data", None),
        }
        # Include message if no structured event was set
        if not hasattr(record, "event"):
            entry["data"] = {"message": record.getMessage()}
        return json.dumps(entry, default=str, ensure_ascii=False)

    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:  # noqa: N802
        """ISO 8601 UTC timestamp with milliseconds."""
        from datetime import datetime, timezone

        dt = datetime.fromtimestamp(record.created, tz=timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(record.msecs):03d}Z"


# ---------------------------------------------------------------------------
# Human-readable formatter (for stderr)
# ---------------------------------------------------------------------------

class HumanFormatter(logging.Formatter):
    """Compact human-readable format for CLI stderr output."""

    def format(self, record: logging.LogRecord) -> str:
        trace = getattr(record, "trace_id", None)
        trace_suffix = f" [{trace[:8]}]" if trace else ""
        return f"[{record.levelname.lower():7s}]{trace_suffix} {record.getMessage()}"


# ---------------------------------------------------------------------------
# Structured log adapter
# ---------------------------------------------------------------------------

class StructuredLogger:
    """Wrapper around ``logging.Logger`` that adds structured JSONL fields."""

    def __init__(self, logger: logging.Logger, component: str) -> None:
        self._logger = logger
        self._component = component
        self._trace_id: str | None = None

    @property
    def trace_id(self) -> str | None:
        return self._trace_id

    @trace_id.setter
    def trace_id(self, value: str | None) -> None:
        self._trace_id = value

    def log(
        self,
        level: int,
        event: str,
        data: dict[str, Any] | None = None,
        *,
        trace_id: str | None = None,
    ) -> None:
        """Emit a structured log entry."""
        extra = {
            "trace_id": trace_id or self._trace_id,
            "event": event,
            "data": data,
        }
        self._logger.log(level, event, extra=extra)

    def info(self, event: str, data: dict[str, Any] | None = None, *, trace_id: str | None = None) -> None:
        self.log(logging.INFO, event, data, trace_id=trace_id)

    def warning(self, event: str, data: dict[str, Any] | None = None, *, trace_id: str | None = None) -> None:
        self.log(logging.WARNING, event, data, trace_id=trace_id)

    def error(self, event: str, data: dict[str, Any] | None = None, *, trace_id: str | None = None) -> None:
        self.log(logging.ERROR, event, data, trace_id=trace_id)

    def debug(self, event: str, data: dict[str, Any] | None = None, *, trace_id: str | None = None) -> None:
        self.log(logging.DEBUG, event, data, trace_id=trace_id)


# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

def configure_logging(
    component: str,
    *,
    log_file: str | None = None,
    level: int = logging.INFO,
    stderr_human: bool = True,
) -> StructuredLogger:
    """Configure logging for a component.

    Args:
        component: Component name (e.g. ``"orchestrator"``, ``"ledger"``, ``"mcp_client"``).
        log_file: Path to JSONL log file.  If ``None``, reads ``HEP_LOG_FILE`` env var.
        level: Minimum log level.
        stderr_human: If ``True``, add a human-readable handler to stderr.

    Returns:
        A ``StructuredLogger`` instance for emitting structured events.
    """
    logger = logging.getLogger(f"autoresearch.{component}")
    logger.setLevel(level)
    logger.handlers.clear()
    logger.propagate = False

    # stderr: human-readable
    if stderr_human:
        stderr_handler = logging.StreamHandler(sys.stderr)
        stderr_handler.setFormatter(HumanFormatter())
        stderr_handler.setLevel(level)
        logger.addHandler(stderr_handler)

    # File: JSONL
    resolved_log_file = log_file or os.environ.get("HEP_LOG_FILE")
    if resolved_log_file:
        file_handler = logging.FileHandler(resolved_log_file, mode="a", encoding="utf-8")
        file_handler.setFormatter(JsonlFormatter(component))
        file_handler.setLevel(level)
        logger.addHandler(file_handler)

    return StructuredLogger(logger, component)


# ---------------------------------------------------------------------------
# JSONL event type definitions (R7 / EVO-12a)
# ---------------------------------------------------------------------------

JSONL_EVENT_TYPES: dict[str, dict[str, str]] = {
    "file_edit": {
        "description": "A file was edited by an agent or tool.",
        "data_schema": '{"file_path": "string", "diff": "string?", "edit_type": "string"}',
    },
    "fix_applied": {
        "description": "An automated fix was applied to a file.",
        "data_schema": '{"file_path": "string", "fix_type": "string", "signal_context": "string?"}',
    },
    "tool_call": {
        "description": "An MCP tool was invoked.",
        "data_schema": '{"tool_name": "string", "params": "object", "result_status": "success|error", "duration_ms": "number?"}',
    },
    "skill_invoked": {
        "description": "A skill was invoked.",
        "data_schema": '{"skill_id": "string", "trigger": "string?", "result": "string?"}',
    },
}
"""Pre-defined event types for the JSONL trace pipeline (EVO-12a readiness).

These are schema definitions only — emission logic is not yet implemented.
"""
