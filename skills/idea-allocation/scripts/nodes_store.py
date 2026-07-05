#!/usr/bin/env python3
"""Shared loader and validation helpers for the idea-allocation skill.

Standard library only. This module owns the PINNED read-side interface to the
campaign store (agreed with the campaign-store side; integration is re-checked
at closeout):

``nodes_latest.json`` is a JSON object::

    {
      "campaign_id": "<uuid>",            # optional if supplied on the CLI
      "nodes": [ {...}, ... ]             # list, or mapping node_id -> node
    }

Each node object carries:

- ``node_id``: non-empty string (when ``nodes`` is a mapping, the key is the
  node id and must match any inline ``node_id``).
- ``lifecycle_state``: one of ``"active"``, ``"waiting_activation"``,
  ``"archived"``. Missing means ``"active"``.
- ``posterior`` (optional): ``{"value": float in [0, 1],
  "evidence_count": int >= 0, "updated_at": ISO 8601 date-time,
  "gaia_package_ref": optional string}``. The posterior is produced by the
  belief graph; this decision layer only reads it.
- ``activation_condition`` (required when ``lifecycle_state`` is
  ``"waiting_activation"``): ``{"kind": one of tool_readiness | data_release |
  stage_reached | exploratory_computation | other, "description": non-empty
  string, "satisfied": bool, "last_checked_at": optional ISO 8601 date-time}``.

Unknown extra keys on a node or on ``posterior`` are tolerated (the campaign
store may grow fields); values of the pinned keys are validated strictly, and
a store that fails validation is rejected as a whole — the scripts refuse to
allocate on top of malformed belief data.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

LIFECYCLE_STATES = ("active", "waiting_activation", "archived")
DEFAULT_LIFECYCLE_STATE = "active"

ACTIVATION_KINDS = (
    "tool_readiness",
    "data_release",
    "stage_reached",
    "exploratory_computation",
    "other",
)

ALLOCATION_KINDS = ("deep_investment", "reconnaissance", "hold")

METHOD_NAME = "thompson_sampling"

# Deterministic uuid5 namespaces (uuid5 is a pure function of namespace+name,
# so ids derived below are reproducible across runs and machines).
DECISION_ID_NAMESPACE = uuid.uuid5(
    uuid.NAMESPACE_URL, "https://nullius.invalid/idea-allocation/allocation_decision_v1"
)
ACTIVATION_KEY_NAMESPACE = uuid.uuid5(
    uuid.NAMESPACE_URL, "https://nullius.invalid/idea-allocation/activation-idempotency"
)


class StoreError(ValueError):
    """Raised when nodes_latest.json fails validation. Carries all problems."""

    def __init__(self, problems: List[str]):
        self.problems = list(problems)
        super().__init__("; ".join(self.problems))


def parse_datetime(value: Any) -> Optional[datetime]:
    """Parse an ISO 8601 date-time string; accept a trailing 'Z'. None if invalid."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def is_uuid_text(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        uuid.UUID(value)
        return True
    except ValueError:
        return False


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _validate_posterior(node_id: str, posterior: Any, problems: List[str]) -> None:
    prefix = f"node {node_id!r}: posterior"
    if not isinstance(posterior, dict):
        problems.append(f"{prefix} must be an object, got {type(posterior).__name__}")
        return
    value = posterior.get("value")
    if not _is_number(value) or not (0.0 <= float(value) <= 1.0):
        problems.append(f"{prefix}.value must be a number in [0, 1], got {value!r}")
    count = posterior.get("evidence_count")
    if not _is_int(count) or count < 0:
        problems.append(f"{prefix}.evidence_count must be an integer >= 0, got {count!r}")
    if parse_datetime(posterior.get("updated_at")) is None:
        problems.append(
            f"{prefix}.updated_at must be an ISO 8601 date-time string, "
            f"got {posterior.get('updated_at')!r}"
        )
    ref = posterior.get("gaia_package_ref")
    if ref is not None and not isinstance(ref, str):
        problems.append(f"{prefix}.gaia_package_ref must be a string when present, got {ref!r}")


def _validate_activation_condition(node_id: str, condition: Any, problems: List[str]) -> None:
    prefix = f"node {node_id!r}: activation_condition"
    if not isinstance(condition, dict):
        problems.append(f"{prefix} must be an object, got {type(condition).__name__}")
        return
    kind = condition.get("kind")
    if kind not in ACTIVATION_KINDS:
        problems.append(
            f"{prefix}.kind must be one of {list(ACTIVATION_KINDS)}, got {kind!r}"
        )
    description = condition.get("description")
    if not isinstance(description, str) or not description.strip():
        problems.append(f"{prefix}.description must be a non-empty string, got {description!r}")
    satisfied = condition.get("satisfied")
    if not isinstance(satisfied, bool):
        problems.append(f"{prefix}.satisfied must be a boolean, got {satisfied!r}")
    checked = condition.get("last_checked_at")
    if checked is not None and parse_datetime(checked) is None:
        problems.append(
            f"{prefix}.last_checked_at must be an ISO 8601 date-time string when present, "
            f"got {checked!r}"
        )


def _normalize_nodes(raw_nodes: Any, problems: List[str]) -> List[Dict[str, Any]]:
    """Accept a list of node objects or a mapping node_id -> node object."""
    nodes: List[Dict[str, Any]] = []
    if isinstance(raw_nodes, list):
        for index, entry in enumerate(raw_nodes):
            if not isinstance(entry, dict):
                problems.append(f"nodes[{index}] must be an object, got {type(entry).__name__}")
                continue
            nodes.append(dict(entry))
    elif isinstance(raw_nodes, dict):
        for key in sorted(raw_nodes):
            entry = raw_nodes[key]
            if not isinstance(entry, dict):
                problems.append(f"nodes[{key!r}] must be an object, got {type(entry).__name__}")
                continue
            entry = dict(entry)
            inline = entry.get("node_id")
            if inline is not None and inline != key:
                problems.append(
                    f"nodes mapping key {key!r} disagrees with inline node_id {inline!r}"
                )
                continue
            entry["node_id"] = key
            nodes.append(entry)
    else:
        problems.append(
            f"'nodes' must be a list or a mapping, got {type(raw_nodes).__name__}"
        )
    return nodes


def load_nodes_file(
    path: str, cli_campaign_id: Optional[str] = None
) -> Tuple[str, List[Dict[str, Any]]]:
    """Load and strictly validate nodes_latest.json.

    Returns ``(campaign_id, nodes)`` where every node has ``node_id`` and
    ``lifecycle_state`` filled in. Raises :class:`StoreError` carrying the
    full problem list when anything is malformed.
    """
    problems: List[str] = []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise StoreError([f"cannot read nodes file {path!r}: {exc}"]) from exc

    if not isinstance(payload, dict):
        raise StoreError([f"nodes file top level must be an object, got {type(payload).__name__}"])

    file_campaign_id = payload.get("campaign_id")
    campaign_id: Optional[str] = None
    if file_campaign_id is not None and not is_uuid_text(file_campaign_id):
        problems.append(f"campaign_id in file must be a UUID string, got {file_campaign_id!r}")
        file_campaign_id = None
    if cli_campaign_id is not None and not is_uuid_text(cli_campaign_id):
        problems.append(f"--campaign-id must be a UUID string, got {cli_campaign_id!r}")
        cli_campaign_id = None
    if file_campaign_id is not None and cli_campaign_id is not None:
        if file_campaign_id != cli_campaign_id:
            problems.append(
                f"campaign_id mismatch: file has {file_campaign_id!r}, "
                f"--campaign-id gave {cli_campaign_id!r}"
            )
        campaign_id = file_campaign_id
    else:
        campaign_id = file_campaign_id or cli_campaign_id
    if campaign_id is None:
        problems.append("campaign_id missing: provide it in the file or via --campaign-id")

    if "nodes" not in payload:
        problems.append("'nodes' key missing from nodes file")
        raise StoreError(problems)

    nodes = _normalize_nodes(payload["nodes"], problems)

    seen_ids: set = set()
    for node in nodes:
        node_id = node.get("node_id")
        if not isinstance(node_id, str) or not node_id.strip():
            problems.append(f"node with missing or empty node_id: {node!r}")
            continue
        if node_id in seen_ids:
            problems.append(f"duplicate node_id {node_id!r}")
            continue
        seen_ids.add(node_id)

        state = node.get("lifecycle_state", DEFAULT_LIFECYCLE_STATE)
        if state not in LIFECYCLE_STATES:
            problems.append(
                f"node {node_id!r}: lifecycle_state must be one of {list(LIFECYCLE_STATES)}, "
                f"got {state!r}"
            )
            continue
        node["lifecycle_state"] = state

        if node.get("posterior") is not None:
            _validate_posterior(node_id, node["posterior"], problems)

        condition = node.get("activation_condition")
        if state == "waiting_activation":
            if condition is None:
                problems.append(
                    f"node {node_id!r}: waiting_activation requires an activation_condition"
                )
            else:
                _validate_activation_condition(node_id, condition, problems)
        elif condition is not None:
            _validate_activation_condition(node_id, condition, problems)

    if problems:
        raise StoreError(problems)
    return campaign_id, nodes


def waiting_entry(node: Dict[str, Any]) -> Dict[str, Any]:
    """Build the pinned waiting_activation artifact entry for a node.

    ``last_checked_at`` is read from ``activation_condition.last_checked_at``
    first, then from a node-level ``last_checked_at``, else null. Whoever
    actually performs a check is responsible for updating it in the store.
    """
    condition = node["activation_condition"]
    last_checked = condition.get("last_checked_at")
    if last_checked is None:
        last_checked = node.get("last_checked_at")
    return {
        "node_id": node["node_id"],
        "activation_condition": {
            "kind": condition["kind"],
            "description": condition["description"],
            "satisfied": condition["satisfied"],
        },
        "last_checked_at": last_checked if isinstance(last_checked, str) else None,
    }
