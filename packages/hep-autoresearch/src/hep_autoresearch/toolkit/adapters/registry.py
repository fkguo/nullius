from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .base import Adapter
from .shell import ShellAdapter


def adapter_workflow_ids() -> set[str]:
    return {"ADAPTER_shell_smoke"}


def adapter_for_workflow(workflow_id: str) -> Adapter:
    wid = str(workflow_id)
    if wid == "ADAPTER_shell_smoke":
        return ShellAdapter()
    raise KeyError(f"unknown adapter workflow_id: {workflow_id}")


def default_run_card_for_workflow(*, workflow_id: str, run_id: str, state: dict[str, Any]) -> dict[str, Any]:
    wid = str(workflow_id)
    rid = str(run_id)
    if wid == "ADAPTER_shell_smoke":
        artifacts = state.get("artifacts") if isinstance(state.get("artifacts"), dict) else {}
        return {
            "schema_version": 1,
            "run_id": rid,
            "workflow_id": wid,
            "adapter_id": "shell",
            "artifact_step": "adapter_shell_smoke",
            # Gate floor is enforced by Orchestrator approval_policy.json; run-card may add more gates.
            "required_gates": [],
            "gate_resolution_mode": "union",
            "budgets": {"timeout_seconds": 30},
            "prompt": {
                "system": "",
                "user": "Adapter smoke (shell): run a deterministic local command and capture provenance.",
            },
            "tools": [],
            "evidence_bundle": {
                "context_md": artifacts.get("context_md"),
                "context_json": artifacts.get("context_json"),
            },
            "backend": {
                "kind": "shell",
                "argv": ["python3", "-c", "print('ok')"],
                "cwd": ".",
                "env": {},
            },
        }
    raise KeyError(f"no default run-card for workflow_id: {workflow_id}")


def load_run_card(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("run-card JSON must be an object")
    return payload


def validate_adapter_registry() -> None:
    missing: list[str] = []
    for wid in sorted(adapter_workflow_ids()):
        try:
            adapter_for_workflow(wid)
        except Exception:
            missing.append(wid)
    if missing:
        raise RuntimeError(f"adapter registry inconsistency (workflow_id missing implementation): {', '.join(missing)}")
