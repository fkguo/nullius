from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from .._git import try_get_git_metadata
from .._json import read_json, write_json
from .._paths import manifest_cwd
from .._time import utc_now_iso
from ..artifact_report import write_artifact_report


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_json(payload: Any) -> str:
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def _truncate_text(s: str, *, max_chars: int) -> str:
    s = str(s)
    if len(s) <= max_chars:
        return s
    return s[: max(0, max_chars - 3)].rstrip() + "..."


def _safe_rel(repo_root: Path, p: Path) -> str:
    try:
        return os.fspath(p.relative_to(repo_root))
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        return os.fspath(p)
def _list_files_rel(repo_root: Path, root: Path) -> list[str]:
    files: list[str] = []
    if not root.exists():
        return files
    for p in sorted(root.rglob("*")):
        if p.is_file():
            files.append(_safe_rel(repo_root, p))
    return files


def write_adapter_artifacts(
    *,
    repo_root: Path,
    artifact_dir: Path,
    command: str,
    params: dict[str, Any],
    run_card_path: Path,
    run_card_sha256: str,
    required_approvals: tuple[str, ...],
    backend_kind: str,
    provenance: dict[str, Any] | None,
    exec_result: dict[str, Any] | None,
    errors: list[str],
    status: str,
    approval_resolution_mode: str | None = None,
    approval_resolution_trace: list[dict[str, Any]] | None = None,
) -> dict[str, str]:
    """Write manifest/summary/analysis (+ report.md) for an adapter run.

    SSOT files are always written to:
      artifacts/runs/<tag>/<workflow_or_step>/{manifest,summary,analysis}.json
    """
    created_at = utc_now_iso().replace("+00:00", "Z")
    artifact_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = artifact_dir / "manifest.json"
    summary_path = artifact_dir / "summary.json"
    analysis_path = artifact_dir / "analysis.json"

    report_path = artifact_dir / "report.md"

    git_meta = try_get_git_metadata(repo_root)
    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": command,
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": params,
        "versions": {
            "python": os.sys.version.split()[0],
        },
        "inputs": {
            "run_card_path": _safe_rel(repo_root, run_card_path),
            "run_card_sha256": run_card_sha256,
        },
        "outputs": [],
    }
    if git_meta:
        manifest["git"] = git_meta

    if required_approvals:
        manifest["required_approvals"] = list(required_approvals)
    if isinstance(approval_resolution_mode, str) and approval_resolution_mode.strip():
        manifest["approval_resolution_mode"] = approval_resolution_mode.strip()
    if isinstance(approval_resolution_trace, list):
        manifest["approval_resolution_trace"] = [x for x in approval_resolution_trace if isinstance(x, dict)]
    manifest["backend_kind"] = str(backend_kind)
    if provenance is not None:
        manifest["provenance"] = provenance

    if exec_result is not None:
        manifest["execution"] = exec_result

    outs = [
        _safe_rel(repo_root, manifest_path),
        _safe_rel(repo_root, summary_path),
        _safe_rel(repo_root, analysis_path),
        _safe_rel(repo_root, report_path),
        _safe_rel(repo_root, run_card_path),
    ]
    logs_dir = artifact_dir / "logs"
    outs.extend(_list_files_rel(repo_root, logs_dir))
    manifest["outputs"] = outs

    exit_code = exec_result.get("exit_code") if isinstance(exec_result, dict) else None
    duration = exec_result.get("duration_seconds") if isinstance(exec_result, dict) else None
    timed_out = exec_result.get("timed_out") if isinstance(exec_result, dict) else False
    stdout_preview = exec_result.get("stdout_preview") if isinstance(exec_result, dict) else None
    stderr_preview = exec_result.get("stderr_preview") if isinstance(exec_result, dict) else None

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {
            "workflow": params.get("workflow_id") or params.get("workflow") or "(unknown)",
            "adapter_id": params.get("adapter_id") or "(unknown)",
            "backend_kind": backend_kind,
        },
        "stats": {
            "status": status,
            "errors": int(len(errors)),
            "exit_code": exit_code,
            "timed_out": int(bool(timed_out)),
            "duration_seconds": duration,
        },
        "outputs": {
            "artifact_dir": _safe_rel(repo_root, artifact_dir),
            "logs_dir": _safe_rel(repo_root, logs_dir),
            "run_card": _safe_rel(repo_root, run_card_path),
        },
    }
    if stdout_preview is not None:
        summary["stats"]["stdout_preview"] = _truncate_text(str(stdout_preview), max_chars=240)
    if stderr_preview is not None:
        summary["stats"]["stderr_preview"] = _truncate_text(str(stderr_preview), max_chars=240)

    ok = bool(exec_result.get("ok")) if isinstance(exec_result, dict) else False
    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {
            "run_card_sha256": run_card_sha256,
            "backend_kind": backend_kind,
            "required_approvals": list(required_approvals),
        },
        "results": {
            "status": status,
            "ok": bool(ok) and not errors and status == "completed",
            "errors": list(errors),
            "exit_code": exit_code,
            "timed_out": bool(timed_out),
            "headlines": {
                "exit_code": exit_code,
                "duration_seconds": duration,
            },
        },
    }

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)
    _ = write_artifact_report(repo_root=repo_root, artifact_dir=artifact_dir, manifest=manifest, summary=summary, analysis=analysis)

    return {
        "manifest": _safe_rel(repo_root, manifest_path),
        "summary": _safe_rel(repo_root, summary_path),
        "analysis": _safe_rel(repo_root, analysis_path),
        "report": _safe_rel(repo_root, report_path),
        "run_card": _safe_rel(repo_root, run_card_path),
    }


def validate_adapter_artifacts(*, repo_root: Path, artifact_dir: Path) -> list[str]:
    """Minimal deterministic checks for adapter outputs (offline)."""
    errors: list[str] = []
    for name in ["manifest.json", "summary.json", "analysis.json", "report.md", "run_card.json"]:
        p = artifact_dir / name
        if not p.exists():
            errors.append(f"missing {name}")
    # Ensure SSOT JSONs are readable and have required top-level keys.
    for name, required in [
        ("manifest.json", ["schema_version", "created_at", "command", "cwd", "params", "versions", "outputs"]),
        ("summary.json", ["schema_version", "created_at", "definitions", "stats", "outputs"]),
        ("analysis.json", ["schema_version", "created_at", "inputs", "results"]),
    ]:
        p = artifact_dir / name
        if not p.exists():
            continue
        try:
            payload = read_json(p)
        except Exception as e:
            errors.append(f"failed to read {name}: {e}")
            continue
        for k in required:
            if k not in payload:
                errors.append(f"{name}: missing key {k!r}")
    return errors
