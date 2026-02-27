"""
provenance.py — Provenance extraction and audit-log cross-validation.

Extracts tool_call_ids from member evidence JSON and validates them
against the audit log produced by audit_interceptor.py.

Three-level provenance chain:
  claim_id → step_id → tool_call_ids (list of tc_ids)

Used by check_clean_room.py (provenance cross-validation, layer 2).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from audit_interceptor import AuditEntry  # type: ignore


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class ProvenanceRecord:
    claim_id: str
    step_id: str
    tool_call_ids: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Extraction helpers
# ---------------------------------------------------------------------------


def _as_list(obj: Any, key: str) -> list:
    v = obj.get(key, []) if isinstance(obj, dict) else []
    return v if isinstance(v, list) else []


def extract_tool_call_ids(evidence: dict[str, Any]) -> list[str]:
    """
    Extract all tc_ids recorded in a member evidence dict.

    tc_ids are stored as optional 'tc_id' fields on individual items in:
      files_read, commands_run, network_queries, fetched_sources, outputs_produced
    """
    tc_ids: list[str] = []
    for key in ("files_read", "commands_run", "network_queries", "fetched_sources", "outputs_produced"):
        for item in _as_list(evidence, key):
            if isinstance(item, dict):
                tc = str(item.get("tc_id", "")).strip()
                if tc:
                    tc_ids.append(tc)
    return tc_ids


def extract_provenance(evidence: dict[str, Any]) -> list[ProvenanceRecord]:
    """
    Build ProvenanceRecord list from evidence.

    Currently maps each evidence item to a single-step record keyed by
    its sequential index. Extends naturally if evidence gains explicit
    claim_id / step_id fields in the future.
    """
    records: list[ProvenanceRecord] = []
    for key in ("files_read", "commands_run", "network_queries", "fetched_sources", "outputs_produced"):
        for idx, item in enumerate(_as_list(evidence, key)):
            if not isinstance(item, dict):
                continue
            tc = str(item.get("tc_id", "")).strip()
            if not tc:
                continue
            records.append(
                ProvenanceRecord(
                    claim_id=f"evidence.{key}",
                    step_id=f"{key}[{idx}]",
                    tool_call_ids=[tc],
                )
            )
    return records


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate_tool_call_ids_against_audit(
    tc_ids: list[str],
    audit_entries: list[AuditEntry],
    own_workspace: str = "",
) -> list[str]:
    """
    Validate that each tc_id in *tc_ids* appears in *audit_entries*.

    Returns a list of issue messages (empty = PASS).

    Checks:
      1. Each tc_id must exist in the audit log.
      2. Each tc_id's audit entry must belong to *own_workspace* (if provided).
    """
    if not tc_ids:
        return []

    audit_by_tc: dict[str, AuditEntry] = {e.tc_id: e for e in audit_entries}
    issues: list[str] = []

    for tc in tc_ids:
        if tc not in audit_by_tc:
            issues.append(f"PROVENANCE_MISMATCH: tc_id {tc!r} not found in audit log")
            continue
        entry = audit_by_tc[tc]
        if own_workspace and entry.workspace != own_workspace:
            issues.append(
                f"PROVENANCE_MISMATCH: tc_id {tc!r} belongs to workspace {entry.workspace!r}, "
                f"expected {own_workspace!r}"
            )

    return issues
