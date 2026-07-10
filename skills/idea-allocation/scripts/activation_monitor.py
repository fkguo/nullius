#!/usr/bin/env python3
"""Activation monitor for ideas parked on a recorded condition.

Scans ``nodes_latest.json`` for the two condition-carrying lifecycle states —
``waiting_activation`` (an external condition to become actionable) and
``admission_blocked`` (missing evidence that admission review needs) — groups
them by ``activation_condition.kind``, and prints a check report: what to
verify for each kind, plus a ready-to-paste lifecycle-transition command for
every node whose condition is already satisfied.

The suggested transition target respects the engine's lifecycle machine:

- a satisfied ``waiting_activation`` node returns to the state its stored
  data supports (no posterior -> ``candidate``; current posterior with
  scoring-eligible coverage -> ``admitted``; otherwise ``needs_refresh``);
- a satisfied ``admission_blocked`` node re-enters ``admission_review``.

This script never mutates the store. The actual transition is performed by
the caller through the campaign store's thin RPC helper
(``packages/idea-engine/bin/idea-rpc.mjs``); the report only prints the
suggested command. The suggested ``idempotency_key`` is a deterministic uuid5
of (campaign_id, node_id, target state), so pasting the same suggestion twice
is safe if the store honours idempotency keys.

``last_checked_at`` semantics: this monitor only READS the field. Whoever
actually performs a check (or the transition) is responsible for updating
``last_checked_at`` in the campaign store at that moment.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from nodes_store import (  # noqa: E402
    ACTIVATION_KEY_NAMESPACE,
    ACTIVATION_KINDS,
    CONDITION_CARRYING_STATES,
    StoreError,
    load_nodes_file,
    waiting_return_state,
)

DEFAULT_RPC_PATH = "packages/idea-engine/bin/idea-rpc.mjs"

CHECK_GUIDANCE: Dict[str, str] = {
    "tool_readiness": (
        "Run the concrete command or check the concrete flag that proves the tool or "
        "environment is ready (for example a version probe or a seeded smoke run)."
    ),
    "data_release": (
        "Check the publication status of the awaited data source or release channel."
    ),
    "stage_reached": (
        "Check whether the project stage or milestone named in the condition has been reached."
    ),
    "exploratory_computation": (
        "Check whether the exploratory computation artifact has been produced AND has passed "
        "the numerical reliability checks."
    ),
    "required_evidence": (
        "Check whether the named missing evidence now exists as a recorded artifact "
        "(and, for computed evidence, has passed its reliability checks)."
    ),
    "other": (
        "No standard probe for this kind — follow the condition description verbatim."
    ),
}


def transition_target(node: Dict[str, Any]) -> str:
    """The engine-legal target state for a satisfied condition.

    ``admission_blocked`` re-enters ``admission_review``; ``waiting_activation``
    returns to the state its stored data supports (the same derivation the
    engine's entry preconditions check).
    """
    if node["lifecycle_state"] == "admission_blocked":
        return "admission_review"
    return waiting_return_state(node)


def build_rpc_payload(
    campaign_id: str, node: Dict[str, Any], store_root: str
) -> Dict[str, Any]:
    """Pinned shape of the lifecycle-transition request (campaign-store contract).

    stdin JSON for ``idea-rpc.mjs``: ``method`` and ``params`` at the top
    level, with ``store_root`` as a SIBLING of ``method``/``params`` (not
    inside ``params``).

    ``campaign_id`` and ``node_id`` are engine short ids (validated at store
    load). ``idempotency_key`` is pinned by the engine RPC contract
    (idea_runtime_rpc_v1.openrpc.json) as a free-form non-empty string — not
    a short id — so its deterministic uuid5 derivation stays as is.
    """
    node_id = node["node_id"]
    target = transition_target(node)
    idempotency_key = str(
        uuid.uuid5(ACTIVATION_KEY_NAMESPACE, f"{campaign_id}|{node_id}|{target}")
    )
    return {
        "method": "node.set_lifecycle",
        "params": {
            "campaign_id": campaign_id,
            "node_id": node_id,
            "idempotency_key": idempotency_key,
            "lifecycle_state": target,
        },
        "store_root": store_root,
    }


def suggest_activation_command(
    payload: Dict[str, Any], rpc_path: str
) -> Optional[str]:
    """Render the paste-ready shell command, or None if it cannot be quoted safely."""
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    if "'" in text or "'" in rpc_path:
        return None  # cannot embed in single quotes; report will say so
    return f"echo '{text}' | node {rpc_path}"


def group_waiting_nodes(
    nodes: List[Dict[str, Any]]
) -> Dict[str, List[Dict[str, Any]]]:
    """Group the condition-carrying nodes (waiting_activation + admission_blocked)."""
    groups: Dict[str, List[Dict[str, Any]]] = {kind: [] for kind in ACTIVATION_KINDS}
    for node in nodes:
        if node["lifecycle_state"] not in CONDITION_CARRYING_STATES:
            continue
        groups[node["activation_condition"]["kind"]].append(node)
    for kind in groups:
        groups[kind].sort(key=lambda n: n["node_id"])
    return groups


def _last_checked_text(node: Dict[str, Any]) -> str:
    condition = node["activation_condition"]
    checked = condition.get("last_checked_at") or node.get("last_checked_at")
    return checked if isinstance(checked, str) else "never"


def render_report(
    campaign_id: str,
    nodes: List[Dict[str, Any]],
    store_root: str,
    rpc_path: str,
) -> str:
    groups = group_waiting_nodes(nodes)
    total = sum(len(entries) for entries in groups.values())
    waiting_count = sum(
        1 for entries in groups.values() for node in entries
        if node["lifecycle_state"] == "waiting_activation"
    )
    lines: List[str] = []
    lines.append(f"ACTIVATION MONITOR REPORT — campaign {campaign_id}")
    lines.append(
        f"condition-carrying nodes: {total} "
        f"(waiting_activation: {waiting_count}, admission_blocked: {total - waiting_count})"
    )

    for kind in ACTIVATION_KINDS:
        entries = groups[kind]
        if not entries:
            continue
        lines.append("")
        lines.append(f"== {kind} ({len(entries)}) ==")
        lines.append(f"check guidance: {CHECK_GUIDANCE[kind]}")
        for node in entries:
            condition = node["activation_condition"]
            lines.append(
                f"- {node['node_id']} [{node['lifecycle_state']}, "
                f"satisfied={str(condition['satisfied']).lower()}, "
                f"last_checked_at={_last_checked_text(node)}]"
            )
            lines.append(f"    condition: {condition['description']}")

    ready = [
        node
        for kind in ACTIVATION_KINDS
        for node in groups[kind]
        if node["activation_condition"]["satisfied"]
    ]
    ready.sort(key=lambda n: n["node_id"])
    lines.append("")
    lines.append(
        f"== READY TO MOVE — condition satisfied, lifecycle transition pending "
        f"({len(ready)}) =="
    )
    if not ready:
        lines.append("(none)")
    for node in ready:
        condition = node["activation_condition"]
        lines.append(
            f"- {node['node_id']} ({node['lifecycle_state']}, {condition['kind']} -> "
            f"{transition_target(node)}): {condition['description']}"
        )
        payload = build_rpc_payload(campaign_id, node, store_root)
        command = suggest_activation_command(payload, rpc_path)
        if command is None:
            lines.append(
                "  suggested request (quote it yourself — payload contains a single quote):"
            )
            lines.append(f"    {json.dumps(payload, sort_keys=True)}")
        else:
            lines.append(
                "  suggested command (run from the repository root that contains the "
                "rpc helper; the transition is the caller's action, not this monitor's):"
            )
            lines.append(f"    {command}")

    lines.append("")
    lines.append(
        "NOTE on last_checked_at: this monitor only reads it. Whoever performs a check "
        "or executes a suggested transition updates last_checked_at in the campaign "
        "store at that moment."
    )
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Report on ideas parked on a recorded condition "
            "(waiting_activation and admission_blocked)."
        )
    )
    parser.add_argument("--nodes", required=True, help="path to nodes_latest.json")
    parser.add_argument(
        "--store-root", required=True,
        help="campaign store root passed through to the suggested rpc commands",
    )
    parser.add_argument(
        "--campaign-id", default=None,
        help=(
            "campaign short id (8-char engine convention; required if nodes file "
            "has no campaign_id; must match if both)"
        ),
    )
    parser.add_argument(
        "--rpc-path", default=DEFAULT_RPC_PATH,
        help=f"path to the lifecycle rpc helper (default: {DEFAULT_RPC_PATH})",
    )
    args = parser.parse_args(argv)

    try:
        campaign_id, nodes = load_nodes_file(args.nodes, args.campaign_id)
    except StoreError as exc:
        print("error: nodes file failed validation:", file=sys.stderr)
        for problem in exc.problems:
            print(f"  - {problem}", file=sys.stderr)
        return 2

    print(render_report(campaign_id, nodes, args.store_root, args.rpc_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
