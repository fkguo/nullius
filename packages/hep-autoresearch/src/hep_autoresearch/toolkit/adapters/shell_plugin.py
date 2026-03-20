from __future__ import annotations

from typing import Any

from .adapter_plugin import AdapterPlugin
from .shell import ShellAdapter


def _default_shell_run_card(workflow_id: str, run_id: str, state: dict[str, Any]) -> dict[str, Any]:
    wid = str(workflow_id)
    rid = str(run_id)
    artifacts = state.get("artifacts") if isinstance(state.get("artifacts"), dict) else {}
    return {
        "schema_version": 1,
        "run_id": rid,
        "workflow_id": wid,
        "adapter_id": "shell",
        "artifact_step": "shell_adapter_smoke",
        "required_approvals": [],
        "approval_resolution_mode": "union",
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


def shell_adapter_plugin() -> AdapterPlugin:
    return AdapterPlugin(
        plugin_id="shell_builtin",
        workflow_ids=("shell_adapter_smoke",),
        adapter_factory=ShellAdapter,
        default_run_card_factory=_default_shell_run_card,
    )
