#!/usr/bin/env python3
"""Activation monitor for ideas waiting on an external condition.

Scans ``nodes_latest.json`` for nodes with ``lifecycle_state ==
"waiting_activation"``, groups them by ``activation_condition.kind``, and
prints a check report: what to verify for each kind, plus a ready-to-paste
lifecycle-transition command for every node whose condition is already
satisfied.

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
    StoreError,
    load_nodes_file,
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
    "other": (
        "No standard probe for this kind — follow the condition description verbatim."
    ),
}


def build_rpc_payload(campaign_id: str, node_id: str, store_root: str) -> Dict[str, Any]:
    """Pinned shape of the lifecycle-transition request (campaign-store contract).

    stdin JSON for ``idea-rpc.mjs``: ``method`` and ``params`` at the top
    level, with ``store_root`` as a SIBLING of ``method``/``params`` (not
    inside ``params``).
    """
    idempotency_key = str(
        uuid.uuid5(ACTIVATION_KEY_NAMESPACE, f"{campaign_id}|{node_id}|active")
    )
    return {
        "method": "node.set_lifecycle",
        "params": {
            "campaign_id": campaign_id,
            "node_id": node_id,
            "idempotency_key": idempotency_key,
            "lifecycle_state": "active",
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
    groups: Dict[str, List[Dict[str, Any]]] = {kind: [] for kind in ACTIVATION_KINDS}
    for node in nodes:
        if node["lifecycle_state"] != "waiting_activation":
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
    lines: List[str] = []
    lines.append(f"ACTIVATION MONITOR REPORT — campaign {campaign_id}")
    lines.append(f"waiting_activation nodes: {total}")

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
                f"- {node['node_id']} [satisfied={str(condition['satisfied']).lower()}, "
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
        f"== READY TO ACTIVATE — condition satisfied, lifecycle transition pending "
        f"({len(ready)}) =="
    )
    if not ready:
        lines.append("(none)")
    for node in ready:
        condition = node["activation_condition"]
        lines.append(f"- {node['node_id']} ({condition['kind']}): {condition['description']}")
        payload = build_rpc_payload(campaign_id, node["node_id"], store_root)
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
        description="Report on ideas waiting for an activation condition."
    )
    parser.add_argument("--nodes", required=True, help="path to nodes_latest.json")
    parser.add_argument(
        "--store-root", required=True,
        help="campaign store root passed through to the suggested rpc commands",
    )
    parser.add_argument(
        "--campaign-id", default=None,
        help="campaign UUID (required if nodes file has no campaign_id; must match if both)",
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
