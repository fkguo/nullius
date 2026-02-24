#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _run_capture(cmd: list[str], cwd: Path | None = None, timeout: int | None = None) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd is not None else None,
        timeout=timeout,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def detect_git_commit(project_root: Path) -> str:
    try:
        proc = _run_capture(["git", "rev-parse", "HEAD"], cwd=project_root, timeout=10)
        if proc.returncode == 0:
            out = proc.stdout.decode("utf-8", errors="replace").strip()
            if out:
                return out
    except Exception:
        pass
    return ""


def detect_python_version() -> str:
    try:
        proc = _run_capture(["python3", "-V"], timeout=5)
        if proc.returncode == 0:
            return proc.stdout.decode("utf-8", errors="replace").strip()
    except Exception:
        pass
    return ""


def detect_julia_version() -> str:
    try:
        proc = _run_capture(["julia", "--version"], timeout=5)
        if proc.returncode == 0:
            return proc.stdout.decode("utf-8", errors="replace").strip()
    except Exception:
        pass
    return ""


def default_environment(project_root: Path) -> dict[str, Any]:
    return {
        "os": platform.platform(),
        "python_version": detect_python_version(),
        "julia_version": detect_julia_version(),
        "git_commit": detect_git_commit(project_root),
        "cwd": str(Path.cwd()),
    }


def new_member_evidence(member_id: str, mode: str, project_root: Path) -> dict[str, Any]:
    return {
        "version": 1,
        "member_id": member_id,
        "mode": mode,
        "timestamps": {"start_utc": now_utc(), "end_utc": ""},
        "files_read": [],
        "commands_run": [],
        "network_queries": [],
        "fetched_sources": [],
        "outputs_produced": [],
        "environment": default_environment(project_root),
        "convention_mappings": [],
    }


def finalize_member_evidence(evidence: dict[str, Any]) -> None:
    ts = evidence.get("timestamps")
    if isinstance(ts, dict):
        ts["end_utc"] = now_utc()


def _append_list(evidence: dict[str, Any], key: str, item: dict[str, Any]) -> None:
    arr = evidence.get(key)
    if not isinstance(arr, list):
        arr = []
        evidence[key] = arr
    arr.append(item)


def log_file_read(evidence: dict[str, Any], path: str, anchor_or_line: str, purpose: str) -> None:
    _append_list(
        evidence,
        "files_read",
        {
            "path": path,
            "anchor_or_line": anchor_or_line,
            "purpose": purpose,
        },
    )


def log_command_run(
    evidence: dict[str, Any],
    command: str,
    cwd: str,
    exit_code: int,
    output_sha256: str,
    output_path: str,
) -> None:
    _append_list(
        evidence,
        "commands_run",
        {
            "command": command,
            "cwd": cwd,
            "timestamp_utc": now_utc(),
            "exit_code": int(exit_code),
            "output_sha256": output_sha256,
            "output_path": output_path,
        },
    )


def log_network_query(
    evidence: dict[str, Any],
    query_or_url: str,
    justification: str,
    downloaded_to: str,
) -> None:
    _append_list(
        evidence,
        "network_queries",
        {
            "query_or_url": query_or_url,
            "timestamp_utc": now_utc(),
            "justification": justification,
            "downloaded_to": downloaded_to,
        },
    )


def log_fetched_source(
    evidence: dict[str, Any],
    original_url: str,
    local_path_under_references: str,
    sha256: str,
    size_bytes: int,
) -> None:
    _append_list(
        evidence,
        "fetched_sources",
        {
            "original_url": original_url,
            "local_path_under_references": local_path_under_references,
            "sha256": sha256,
            "size_bytes": int(size_bytes),
        },
    )


def log_output_produced(evidence: dict[str, Any], path: str, sha256: str, description: str) -> None:
    _append_list(
        evidence,
        "outputs_produced",
        {
            "path": path,
            "sha256": sha256,
            "description": description,
        },
    )


def log_convention_mapping(evidence: dict[str, Any], mapping: dict[str, Any]) -> None:
    _append_list(evidence, "convention_mappings", mapping)


def load_evidence(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8", errors="replace"))


def save_evidence(path: Path, evidence: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


@dataclass(frozen=True)
class EvidenceIssue:
    level: str  # ERROR/WARN
    message: str


def validate_member_evidence_schema(evidence: dict[str, Any]) -> list[EvidenceIssue]:
    issues: list[EvidenceIssue] = []

    def err(msg: str) -> None:
        issues.append(EvidenceIssue("ERROR", msg))

    def warn(msg: str) -> None:
        issues.append(EvidenceIssue("WARN", msg))

    if not isinstance(evidence, dict):
        return [EvidenceIssue("ERROR", f"expected JSON object, got {type(evidence).__name__}")]

    ver = evidence.get("version")
    if not isinstance(ver, int) or ver < 1:
        err("missing/invalid required field: version (int >= 1)")

    member_id = evidence.get("member_id")
    if not isinstance(member_id, str) or not member_id.strip():
        err("missing/invalid required field: member_id (non-empty string)")

    mode = evidence.get("mode")
    if not isinstance(mode, str) or mode not in ("full_access", "packet_only"):
        err("missing/invalid required field: mode (full_access|packet_only)")

    ts = evidence.get("timestamps")
    if not isinstance(ts, dict):
        err("missing/invalid required field: timestamps (object)")
    else:
        if not isinstance(ts.get("start_utc"), str) or not str(ts.get("start_utc")).strip():
            err("timestamps.start_utc must be a non-empty string")
        if "end_utc" in ts and ts.get("end_utc") is not None and not isinstance(ts.get("end_utc"), str):
            err("timestamps.end_utc must be a string (or empty)")

    for k in ("files_read", "commands_run", "network_queries", "fetched_sources", "outputs_produced", "convention_mappings"):
        if k not in evidence:
            err(f"missing required field: {k} (array)")
            continue
        if not isinstance(evidence.get(k), list):
            err(f"{k} must be an array")

    env = evidence.get("environment")
    if not isinstance(env, dict):
        err("missing/invalid required field: environment (object)")
    else:
        if not isinstance(env.get("os", ""), str):
            err("environment.os must be a string")
        if not isinstance(env.get("git_commit", ""), str):
            err("environment.git_commit must be a string")

    # Mode-specific constraints.
    if isinstance(mode, str) and mode == "packet_only":
        for k in ("files_read", "commands_run", "network_queries"):
            if isinstance(evidence.get(k), list) and len(evidence.get(k)) != 0:
                err(f"packet_only mode requires {k} to be an empty array")
    if isinstance(mode, str) and mode == "full_access":
        fr = evidence.get("files_read") if isinstance(evidence.get("files_read"), list) else []
        cr = evidence.get("commands_run") if isinstance(evidence.get("commands_run"), list) else []
        op = evidence.get("outputs_produced") if isinstance(evidence.get("outputs_produced"), list) else []
        if len(fr) == 0 and len(cr) == 0 and len(op) == 0:
            err("full_access mode requires at least one of files_read / commands_run / outputs_produced to be non-empty")

    # Lightweight sanity checks for item shapes (warn-only to keep backward compatibility as schema evolves).
    if isinstance(evidence.get("commands_run"), list):
        for i, it in enumerate(evidence["commands_run"]):
            if not isinstance(it, dict):
                warn(f"commands_run[{i}] is not an object")
                continue
            if not isinstance(it.get("command"), str) or not it.get("command", "").strip():
                warn(f"commands_run[{i}].command missing/invalid")
            if not isinstance(it.get("exit_code"), int):
                warn(f"commands_run[{i}].exit_code missing/invalid")
    if isinstance(evidence.get("outputs_produced"), list):
        for i, it in enumerate(evidence["outputs_produced"]):
            if not isinstance(it, dict):
                warn(f"outputs_produced[{i}] is not an object")
                continue
            if not isinstance(it.get("path"), str) or not it.get("path", "").strip():
                warn(f"outputs_produced[{i}].path missing/invalid")
            if not isinstance(it.get("sha256"), str) or not it.get("sha256", "").strip():
                warn(f"outputs_produced[{i}].sha256 missing/invalid")

    return issues

