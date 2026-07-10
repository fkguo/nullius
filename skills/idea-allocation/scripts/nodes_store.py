#!/usr/bin/env python3
"""Shared loader and validation helpers for the idea-allocation skill.

Standard library only. This module owns the PINNED read-side interface to the
campaign store (agreed with the campaign-store side; integration is re-checked
at closeout):

``nodes_latest.json`` is either the engine's native top-level node map::

    {
      "<node_id>": {...},
      ...
    }

or an explicit wrapper used by standalone fixtures::

    {
      "campaign_id": "<short id>",        # optional if supplied on the CLI
      "nodes": [ {...}, ... ]             # list, or mapping node_id -> node
    }

For the native map form, the campaign id is supplied on the CLI or inferred
from the standard engine path ``.../campaigns/<campaign_id>/nodes_latest.json``.

``campaign_id`` and every ``node_id`` are engine short ids: 8 characters of
lowercase Crockford base32 (see ``SHORT_ID_ALPHABET`` below), the handle-id
convention pinned by the engine contracts.

Each node object carries:

- ``node_id``: engine short id (when ``nodes`` is a mapping, the key is the
  node id and must match any inline ``node_id``).
- ``lifecycle_state``: one of the engine lifecycle machine's states —
  ``"candidate"``, ``"admission_review"``, ``"admitted"``, ``"needs_refresh"``,
  ``"admission_blocked"``, ``"waiting_activation"``, ``"archived"``. Required:
  there is no default, and the retired ``"active"`` value marks an unmigrated
  store (rejected with a migration hint).
- ``posterior`` (optional): ``{"value": float in [0, 1],
  "evidence_count": int >= 0, "updated_at": ISO 8601 date-time,
  "gaia_package_ref": optional string, "status": optional one of "current" |
  "provisional" | "stale"}``. Missing status is treated as ``current`` for
  older snapshots. The posterior is produced by the belief graph; this decision
  layer only reads it.
- ``literature_coverage`` (optional): ``{"status": one of "saturated" |
  "coverage_incomplete" | "metadata_only", "survey_ref": optional string,
  "close_prior_matrix_ref": optional string, "exploratory_allocation": optional
  bool}``. Missing means ``metadata_only``. ``coverage_incomplete`` participates
  in allocation only when ``exploratory_allocation`` is explicitly true.
- ``activation_condition`` (required when ``lifecycle_state`` is
  ``"waiting_activation"`` — the external condition to become actionable — or
  ``"admission_blocked"`` — the missing evidence admission needs):
  ``{"kind": one of tool_readiness | data_release | stage_reached |
  exploratory_computation | required_evidence | other, "description": non-empty
  string, "satisfied": bool, "last_checked_at": optional ISO 8601 date-time}``.

Unknown extra keys on a node or on ``posterior`` are tolerated (the campaign
store may grow fields); values of the pinned keys are validated strictly, and
a store that fails validation is rejected as a whole — the scripts refuse to
allocate on top of malformed belief data.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

LIFECYCLE_STATES = (
    "candidate",
    "admission_review",
    "admitted",
    "needs_refresh",
    "admission_blocked",
    "waiting_activation",
    "archived",
)

# The two states whose nodes carry an activation_condition (the engine clears
# the condition on every other state).
CONDITION_CARRYING_STATES = ("waiting_activation", "admission_blocked")

ACTIVATION_KINDS = (
    "tool_readiness",
    "data_release",
    "stage_reached",
    "exploratory_computation",
    "required_evidence",
    "other",
)

ALLOCATION_KINDS = ("deep_investment", "reconnaissance", "hold")
LITERATURE_COVERAGE_STATUSES = ("saturated", "coverage_incomplete", "metadata_only")
POSTERIOR_STATUSES = ("current", "provisional", "stale")

METHOD_NAME = "thompson_sampling"

# Engine short-id convention for handle ids (decision_id, campaign_id, node_id):
# 8 chars of lowercase Crockford base32 — digits + lowercase letters excluding
# i/l/o/u. This is the exact alphabet and length pinned by the engine contracts
# (allocation_decision_v1 / idea_node_v1 schemas) and
# packages/shared/src/short-id.ts; never widen or substitute it here alone.
SHORT_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
SHORT_ID_LENGTH = 8
SHORT_ID_RE = re.compile(r"^[%s]{%d}$" % (SHORT_ID_ALPHABET, SHORT_ID_LENGTH))

# Domain-separation prefix for decision-id derivation. Successor of the retired
# uuid5 namespace: it keeps decision ids from colliding with any other
# sha256-derived id family fed the same inputs.
_DECISION_ID_DOMAIN = "https://nullius.invalid/idea-allocation/allocation_decision_v1"

# Deterministic uuid5 namespace for the suggested lifecycle-transition
# idempotency_key (uuid5 is a pure function of namespace+name, so keys are
# reproducible across runs and machines). The engine RPC contract
# (idea_runtime_rpc_v1.openrpc.json) pins idempotency_key as a free-form
# non-empty string — NOT an engine short id — so the dashed-uuid key format
# is deliberate and stays.
ACTIVATION_KEY_NAMESPACE = uuid.uuid5(
    uuid.NAMESPACE_URL, "https://nullius.invalid/idea-allocation/activation-idempotency"
)


def derive_decision_id(
    campaign_id: str, seed: int, generated_at: str, nodes_digest: str
) -> str:
    """Deterministic engine-convention decision id.

    Successor of the retired uuid5 derivation, over the SAME semantic inputs
    (campaign id, seed, generated_at, store digest) plus the fixed domain
    prefix that replaces the uuid5 namespace: sha256 the canonical input
    string, then map the first ``SHORT_ID_LENGTH`` digest bytes into
    ``SHORT_ID_ALPHABET`` via ``byte % 32``. Because 256 % 32 == 0, every
    byte maps uniformly onto the 32-symbol alphabet — no bias. Same inputs
    always give the same id; no hidden randomness.
    """
    material = f"{_DECISION_ID_DOMAIN}|{campaign_id}|{seed}|{generated_at}|{nodes_digest}"
    digest = hashlib.sha256(material.encode("utf-8")).digest()
    alphabet_size = len(SHORT_ID_ALPHABET)
    return "".join(
        SHORT_ID_ALPHABET[byte % alphabet_size] for byte in digest[:SHORT_ID_LENGTH]
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


def is_short_id_text(value: Any) -> bool:
    """True iff ``value`` is an engine short id (SHORT_ID_RE).

    fullmatch: with re.match, the pattern's ``$`` would tolerate one trailing
    newline that the engine-side JS regex rejects; stay exactly as strict.
    """
    return isinstance(value, str) and bool(SHORT_ID_RE.fullmatch(value))


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
    status = posterior.get("status", "current")
    if status not in POSTERIOR_STATUSES:
        problems.append(f"{prefix}.status must be one of {list(POSTERIOR_STATUSES)} when present, got {status!r}")


def _validate_literature_coverage(
    node_id: str, node: Dict[str, Any], problems: List[str]
) -> None:
    prefix = f"node {node_id!r}: literature_coverage"
    coverage = node.get("literature_coverage")
    if coverage is None:
        node["literature_coverage"] = {
            "status": "metadata_only",
            "exploratory_allocation": False,
        }
        return
    if not isinstance(coverage, dict):
        problems.append(f"{prefix} must be an object when present, got {type(coverage).__name__}")
        return
    allowed_keys = {
        "status",
        "survey_ref",
        "close_prior_matrix_ref",
        "exploratory_allocation",
    }
    extra = sorted(key for key in coverage if key not in allowed_keys)
    if extra:
        problems.append(f"{prefix} unexpected keys: {extra}")

    status = coverage.get("status")
    if status not in LITERATURE_COVERAGE_STATUSES:
        problems.append(
            f"{prefix}.status must be one of {list(LITERATURE_COVERAGE_STATUSES)}, got {status!r}"
        )
        status = "metadata_only"
    exploratory = coverage.get("exploratory_allocation", False)
    if not isinstance(exploratory, bool):
        problems.append(f"{prefix}.exploratory_allocation must be a boolean when present, got {exploratory!r}")
        exploratory = False
    if exploratory and status != "coverage_incomplete":
        problems.append(
            f"{prefix}.exploratory_allocation is only allowed when status is 'coverage_incomplete'"
        )
    for field in ("survey_ref", "close_prior_matrix_ref"):
        ref = coverage.get(field)
        if ref is not None and (not isinstance(ref, str) or not ref.strip()):
            problems.append(f"{prefix}.{field} must be a non-empty string when present, got {ref!r}")

    normalized = {
        "status": status,
        "exploratory_allocation": exploratory,
    }
    for field in ("survey_ref", "close_prior_matrix_ref"):
        ref = coverage.get(field)
        if isinstance(ref, str) and ref.strip():
            normalized[field] = ref
    node["literature_coverage"] = normalized


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


def _infer_campaign_id_from_path(path: str) -> Optional[str]:
    node_path = Path(path)
    if node_path.name != "nodes_latest.json":
        return None
    candidate = node_path.parent.name
    if node_path.parent.parent.name != "campaigns":
        return None
    return candidate if is_short_id_text(candidate) else None


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

    wrapper_shape = "nodes" in payload
    raw_nodes = payload["nodes"] if wrapper_shape else payload
    file_campaign_id = payload.get("campaign_id") if wrapper_shape else None
    inferred_campaign_id = _infer_campaign_id_from_path(path)
    campaign_id: Optional[str] = None
    if file_campaign_id is not None and not is_short_id_text(file_campaign_id):
        problems.append(
            f"campaign_id in file is not an engine short id "
            f"({SHORT_ID_RE.pattern}), got {file_campaign_id!r}"
        )
        file_campaign_id = None
    if cli_campaign_id is not None and not is_short_id_text(cli_campaign_id):
        problems.append(
            f"--campaign-id is not an engine short id "
            f"({SHORT_ID_RE.pattern}), got {cli_campaign_id!r}"
        )
        cli_campaign_id = None
    if inferred_campaign_id is not None and cli_campaign_id is not None and inferred_campaign_id != cli_campaign_id:
        problems.append(
            f"campaign_id mismatch: path implies {inferred_campaign_id!r}, "
            f"--campaign-id gave {cli_campaign_id!r}"
        )
    if file_campaign_id is not None and inferred_campaign_id is not None and file_campaign_id != inferred_campaign_id:
        problems.append(
            f"campaign_id mismatch: file has {file_campaign_id!r}, "
            f"path implies {inferred_campaign_id!r}"
        )
    if file_campaign_id is not None and cli_campaign_id is not None:
        if file_campaign_id != cli_campaign_id:
            problems.append(
                f"campaign_id mismatch: file has {file_campaign_id!r}, "
                f"--campaign-id gave {cli_campaign_id!r}"
            )
        campaign_id = file_campaign_id
    else:
        campaign_id = file_campaign_id or cli_campaign_id or inferred_campaign_id
    if campaign_id is None:
        problems.append(
            "campaign_id missing: provide it in the file, via --campaign-id, "
            "or use .../campaigns/<campaign_id>/nodes_latest.json"
        )

    nodes = _normalize_nodes(raw_nodes, problems)

    seen_ids: set = set()
    for node in nodes:
        node_id = node.get("node_id")
        if not isinstance(node_id, str) or not node_id.strip():
            problems.append(f"node with missing or empty node_id: {node!r}")
            continue
        if not is_short_id_text(node_id):
            problems.append(
                f"node_id {node_id!r} is not an engine short id ({SHORT_ID_RE.pattern})"
            )
            continue
        if node_id in seen_ids:
            problems.append(f"duplicate node_id {node_id!r}")
            continue
        seen_ids.add(node_id)

        state = node.get("lifecycle_state")
        if state not in LIFECYCLE_STATES:
            hint = (
                " (missing or legacy value: the engine lifecycle state machine has no"
                " default; migrate the store — no posterior -> 'candidate',"
                " posterior.status=current with scoring-eligible coverage -> 'admitted',"
                " otherwise -> 'needs_refresh')"
                if state is None or state == "active"
                else ""
            )
            problems.append(
                f"node {node_id!r}: lifecycle_state must be one of {list(LIFECYCLE_STATES)}, "
                f"got {state!r}{hint}"
            )
            continue

        if node.get("posterior") is not None:
            _validate_posterior(node_id, node["posterior"], problems)
        _validate_literature_coverage(node_id, node, problems)

        condition = node.get("activation_condition")
        if state in CONDITION_CARRYING_STATES:
            if condition is None:
                problems.append(
                    f"node {node_id!r}: {state} requires an activation_condition"
                )
            else:
                _validate_activation_condition(node_id, condition, problems)
        elif condition is not None:
            _validate_activation_condition(node_id, condition, problems)

    if problems:
        raise StoreError(problems)
    return campaign_id, nodes


def literature_coverage(node: Dict[str, Any]) -> Dict[str, Any]:
    """The node's literature_coverage object; metadata_only when absent."""
    coverage = node.get("literature_coverage")
    if isinstance(coverage, dict):
        return coverage
    return {"status": "metadata_only", "exploratory_allocation": False}


def posterior_status(node: Dict[str, Any]) -> str:
    """Stored posterior status; missing status reads as current (older snapshots)."""
    posterior = node.get("posterior")
    if isinstance(posterior, dict) and posterior.get("status") in POSTERIOR_STATUSES:
        return str(posterior["status"])
    return "current"


def allocation_eligible_from_coverage(coverage: Dict[str, Any]) -> bool:
    """Close-prior gate as the decision layer reads it: saturated, or
    coverage_incomplete with the explicit exploratory waiver."""
    status = coverage.get("status")
    return status == "saturated" or (
        status == "coverage_incomplete" and coverage.get("exploratory_allocation") is True
    )


def waiting_return_state(node: Dict[str, Any]) -> str:
    """The engine-legal state a waiting_activation node returns to, derived
    from its stored data the same way the engine checks entry preconditions:
    no posterior -> candidate; current posterior with scoring-eligible
    coverage -> admitted; any other posterior -> needs_refresh."""
    if node.get("posterior") is None:
        return "candidate"
    if posterior_status(node) == "current" and allocation_eligible_from_coverage(
        literature_coverage(node)
    ):
        return "admitted"
    return "needs_refresh"


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
