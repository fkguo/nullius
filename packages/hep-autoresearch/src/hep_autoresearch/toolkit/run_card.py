from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import sys
from pathlib import Path
from typing import Any

from ._git import try_get_git_metadata
from ._paths import manifest_cwd
from ._time import utc_now_iso


_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_APPROVAL_RUN_CARD_FIELD_ALIASES: tuple[tuple[str, str], ...] = (
    ("required_approvals", "required_gates"),
    ("approval_resolution_mode", "gate_resolution_mode"),
    ("approval_resolution_trace", "gate_resolution_trace"),
)


def normalize_approval_run_card_fields(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise TypeError("run-card payload must be a JSON object")
    normalized = dict(payload)
    for canonical_key, legacy_key in _APPROVAL_RUN_CARD_FIELD_ALIASES:
        has_canonical = canonical_key in normalized
        has_legacy = legacy_key in normalized
        if has_canonical and has_legacy and normalized[canonical_key] != normalized[legacy_key]:
            raise ValueError(
                f"run-card defines both {canonical_key} and legacy {legacy_key} with different values"
            )
        if not has_canonical and has_legacy:
            normalized[canonical_key] = normalized[legacy_key]
        normalized.pop(legacy_key, None)
    return normalized


def run_card_path(*, repo_root: Path, run_id: str) -> Path:
    rid = str(run_id).strip()
    if not rid:
        raise ValueError("run_id is required for run_card_path()")
    if not _RUN_ID_RE.match(rid):
        raise ValueError(
            "run_id must be 1-128 chars, start with [A-Za-z0-9], and contain only [A-Za-z0-9._-]: "
            f"{rid!r}"
        )
    return repo_root / "artifacts" / "runs" / rid / "run_card.json"


def sha256_json(payload: Any) -> str:
    """Return deterministic SHA256 for a JSON-serializable payload.

    NOTE: This hashes the canonical compact JSON encoding (sorted keys, UTF-8,
    separators=(",", ":")), not the on-disk pretty-printed bytes. Consumers
    must use this function (not `sha256sum run_card.json`) to verify.
    """
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def validate_run_card(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        raise TypeError("run-card payload must be a JSON object")
    payload = normalize_approval_run_card_fields(payload)
    v = payload.get("schema_version")
    if not isinstance(v, int) or isinstance(v, bool) or v < 1:
        raise ValueError("run-card.schema_version must be an integer >= 1")
    run_id = payload.get("run_id")
    if not isinstance(run_id, str) or not run_id.strip() or not _RUN_ID_RE.match(run_id.strip()):
        raise ValueError("run-card.run_id must be a non-empty safe id string")
    workflow_id = payload.get("workflow_id")
    if not isinstance(workflow_id, str) or not workflow_id.strip():
        raise ValueError("run-card.workflow_id must be a non-empty string")
    backend = payload.get("backend")
    if not isinstance(backend, dict):
        raise ValueError("run-card.backend must be an object")
    kind = backend.get("kind")
    if not isinstance(kind, str) or not kind.strip():
        raise ValueError("run-card.backend.kind must be a non-empty string")


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def build_run_card(
    *,
    repo_root: Path,
    run_id: str,
    workflow_id: str,
    params: dict[str, Any] | None = None,
    orchestrator_command: list[str] | None = None,
    backend: dict[str, Any] | None = None,
    tools: list[str] | None = None,
    prompt: dict[str, Any] | None = None,
    budgets: dict[str, Any] | None = None,
    evidence_bundle: dict[str, Any] | None = None,
    notes: str | None = None,
    required_approvals: list[str] | None = None,
    approval_resolution_mode: str | None = None,
    approval_resolution_trace: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    created_at = utc_now_iso().replace("+00:00", "Z")
    payload: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "run_id": str(run_id),
        "workflow_id": str(workflow_id),
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": params or {},
        "tools": list(tools or []),
        "prompt": prompt or {"system": "", "user": ""},
        "budgets": budgets or {},
        "evidence_bundle": evidence_bundle or {},
        "backend": backend or {"kind": "python", "argv": ["python3"], "cwd": ".", "env": {}},
        "versions": {
            "python": sys.version.split()[0],
            "os": platform.platform(),
        },
    }
    if orchestrator_command:
        payload["orchestrator_command"] = [str(x) for x in orchestrator_command if str(x).strip()]
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        payload["git"] = git_meta
    if notes:
        payload["notes"] = str(notes)
    if required_approvals:
        payload["required_approvals"] = [str(x) for x in required_approvals if str(x).strip()]
    if isinstance(approval_resolution_mode, str) and approval_resolution_mode.strip():
        payload["approval_resolution_mode"] = approval_resolution_mode.strip()
    if isinstance(approval_resolution_trace, list):
        payload["approval_resolution_trace"] = [x for x in approval_resolution_trace if isinstance(x, dict)]
    return normalize_approval_run_card_fields(payload)


def ensure_run_card(
    *,
    repo_root: Path,
    run_id: str,
    workflow_id: str,
    params: dict[str, Any] | None = None,
    orchestrator_command: list[str] | None = None,
    backend: dict[str, Any] | None = None,
    tools: list[str] | None = None,
    prompt: dict[str, Any] | None = None,
    budgets: dict[str, Any] | None = None,
    evidence_bundle: dict[str, Any] | None = None,
    notes: str | None = None,
    overwrite: bool = False,
) -> tuple[str, str]:
    """Ensure a per-run run_card.json exists and return (rel_path, sha256).

    v0 semantics: write only if missing, unless overwrite=True. This keeps the run-card stable across pause/resume.
    """
    p = run_card_path(repo_root=repo_root, run_id=run_id)
    if p.exists() and not overwrite:
        payload = json.loads(p.read_text(encoding="utf-8"))
        payload = normalize_approval_run_card_fields(payload)
        validate_run_card(payload)
        sha = sha256_json(payload)
    else:
        payload = build_run_card(
            repo_root=repo_root,
            run_id=run_id,
            workflow_id=workflow_id,
            params=params,
            orchestrator_command=orchestrator_command,
            backend=backend,
            tools=tools,
            prompt=prompt,
            budgets=budgets,
            evidence_bundle=evidence_bundle,
            notes=notes,
        )
        validate_run_card(payload)
        _write_json_atomic(p, payload)
        sha = sha256_json(payload)

    try:
        rel = os.fspath(p.relative_to(repo_root))
    except ValueError:
        rel = os.fspath(p)
    return rel, sha
