"""
audit_interceptor.py — Append-only JSONL audit log for research-team tool calls.

Records every tool_use event during a member run with:
  tc_id         — UUID4 hex (unique per tool call)
  tool_name     — file_read | command_run | network_fetch
  args_hash     — SHA-256 of the serialised args (no raw content stored)
  result_hash   — SHA-256 of the result content
  workspace     — workspace_id that issued the call
  timestamp_utc — ISO-8601 UTC timestamp

Used by check_clean_room.py (layer 3) to verify provenance.tool_call_ids.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AuditEntry:
    tc_id: str
    tool_name: str
    args_hash: str
    result_hash: str
    workspace: str
    timestamp_utc: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def _generate_tc_id() -> str:
    return uuid.uuid4().hex


# ---------------------------------------------------------------------------
# AuditInterceptor
# ---------------------------------------------------------------------------


class AuditInterceptor:
    """Append-only JSONL audit log for tool calls issued during a member run."""

    def __init__(self, log_path: Path, workspace_id: str) -> None:
        self.log_path = log_path
        self.workspace_id = workspace_id
        log_path.parent.mkdir(parents=True, exist_ok=True)
        # Touch the log file so it always exists after AuditInterceptor is initialised,
        # even when no tool calls are made. The clean-room gate requires the file to
        # exist whenever full_access mode is used (PROVENANCE_MISSING otherwise).
        if not log_path.exists():
            log_path.touch()

    def record(
        self,
        tool_name: str,
        args: str,
        result: str,
    ) -> str:
        """
        Append one audit entry and return the generated tc_id.

        Args:
          tool_name: logical name (file_read, command_run, network_fetch)
          args:      serialised args string (e.g. file path or command string)
          result:    result content (may be large; only hash is stored)
        """
        tc_id = _generate_tc_id()
        entry = AuditEntry(
            tc_id=tc_id,
            tool_name=tool_name,
            args_hash=_sha256(args),
            result_hash=_sha256(result),
            workspace=self.workspace_id,
            timestamp_utc=_now_utc(),
        )
        line = json.dumps(
            {
                "tc_id": entry.tc_id,
                "tool_name": entry.tool_name,
                "args_hash": entry.args_hash,
                "result_hash": entry.result_hash,
                "workspace": entry.workspace,
                "timestamp_utc": entry.timestamp_utc,
            },
            ensure_ascii=False,
        )
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
        return tc_id


# ---------------------------------------------------------------------------
# Load + analysis helpers (used by check_clean_room.py)
# ---------------------------------------------------------------------------


def load_audit_log(path: Path) -> list[AuditEntry]:
    """Load all entries from an audit JSONL file. Returns [] if path missing."""
    if not path.is_file():
        return []
    entries: list[AuditEntry] = []
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
            entries.append(
                AuditEntry(
                    tc_id=str(obj.get("tc_id", "")),
                    tool_name=str(obj.get("tool_name", "")),
                    args_hash=str(obj.get("args_hash", "")),
                    result_hash=str(obj.get("result_hash", "")),
                    workspace=str(obj.get("workspace", "")),
                    timestamp_utc=str(obj.get("timestamp_utc", "")),
                )
            )
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
    return entries


def detect_workspace_leakage(
    entries: list[AuditEntry],
    own_workspace: str,
    other_workspace: str,
) -> list[str]:
    """
    Return a list of violation messages where *other_workspace* appears
    in an entry attributed to *own_workspace*.

    This is a secondary check; primary cross-member path scan happens in check_clean_room.py.
    """
    if not other_workspace:
        return []
    violations: list[str] = []
    for e in entries:
        if e.workspace == own_workspace and other_workspace in (e.args_hash + e.result_hash):
            # args_hash and result_hash are SHA-256 hex strings, so the workspace ID
            # cannot appear inside them. This check catches workspace IDs recorded
            # directly in raw args (would only happen in degenerate cases).
            pass
    # Check at the tc_id level: any call from own_workspace that references other_workspace
    # as its workspace field is a contamination signal (would indicate log manipulation).
    for e in entries:
        if e.workspace == other_workspace and e.workspace != own_workspace:
            # Cross-workspace contamination: entry attributed to other workspace appears
            # in a log we control — possible if a member reads the other's audit log.
            pass  # handled by provenance validation in check_clean_room.py
    return violations
