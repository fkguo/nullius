from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
from typing import Any

from ._time import utc_now_iso


def _safe_rel(repo_root: Path, p: Path) -> str:
    try:
        return os.fspath(p.relative_to(repo_root))
    except Exception:
        return os.fspath(p)


def _parse_ts(ts: str) -> dt.datetime | None:
    try:
        return dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except Exception:
        return None


def _to_z(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def read_ledger_events(ledger_path: Path) -> list[dict[str, Any]]:
    """Read `.autopilot/ledger.jsonl` (best-effort).

    Invalid JSON lines are skipped; this is for metrics/observability, not SSOT.
    """
    if not ledger_path.exists():
        return []
    events: list[dict[str, Any]] = []
    for ln in ledger_path.read_text(encoding="utf-8", errors="replace").splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            obj = json.loads(ln)
        except Exception:
            continue
        if isinstance(obj, dict):
            events.append(obj)
    return events


def _dir_metrics(root: Path) -> dict[str, Any]:
    by_ext: dict[str, int] = {}
    total_files = 0
    total_bytes = 0
    if not root.exists():
        return {"run_dir_exists": False, "total_files": 0, "total_bytes": 0, "by_ext": {}}
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        total_files += 1
        try:
            size = int(p.stat().st_size)
        except Exception:
            size = 0
        total_bytes += size
        ext = p.suffix.lower() if p.suffix else "(none)"
        by_ext[ext] = int(by_ext.get(ext, 0)) + 1
    return {
        "run_dir_exists": True,
        "total_files": int(total_files),
        "total_bytes": int(total_bytes),
        "by_ext": {k: by_ext[k] for k in sorted(by_ext)},
    }


def _ledger_summary(events: list[dict[str, Any]], *, run_id: str) -> dict[str, Any]:
    counts: dict[str, int] = {}
    ts_list: list[dt.datetime] = []

    approvals: dict[str, Any] = {
        "requested_total": 0,
        "approved_total": 0,
        "rejected_total": 0,
        "requested_by_category": {},
        "approved_by_category": {},
        "rejected_by_category": {},
    }
    errors: dict[str, Any] = {"failed_total": 0, "last_error": None}

    for ev in events:
        if ev.get("run_id") != run_id:
            continue
        event_type = str(ev.get("event_type") or "").strip()
        if event_type:
            counts[event_type] = int(counts.get(event_type, 0)) + 1

        ts = _parse_ts(str(ev.get("ts") or ""))
        if ts is not None:
            ts_list.append(ts)

        details = ev.get("details") if isinstance(ev.get("details"), dict) else {}
        category = details.get("category")
        if event_type == "approval_requested":
            approvals["requested_total"] = int(approvals["requested_total"]) + 1
            if isinstance(category, str) and category.strip():
                d = approvals["requested_by_category"]
                d[category] = int(d.get(category, 0)) + 1
        elif event_type == "approval_approved":
            approvals["approved_total"] = int(approvals["approved_total"]) + 1
            if isinstance(category, str) and category.strip():
                d = approvals["approved_by_category"]
                d[category] = int(d.get(category, 0)) + 1
        elif event_type == "approval_rejected":
            approvals["rejected_total"] = int(approvals["rejected_total"]) + 1
            if isinstance(category, str) and category.strip():
                d = approvals["rejected_by_category"]
                d[category] = int(d.get(category, 0)) + 1
        elif event_type == "failed":
            errors["failed_total"] = int(errors["failed_total"]) + 1
            err = details.get("error")
            if isinstance(err, str) and err.strip():
                errors["last_error"] = err.strip()

    first_ts = min(ts_list) if ts_list else None
    last_ts = max(ts_list) if ts_list else None
    duration_seconds = None
    if first_ts is not None and last_ts is not None:
        duration_seconds = float((last_ts - first_ts).total_seconds())

    return {
        "total_events": int(sum(counts.values())),
        "event_counts": {k: counts[k] for k in sorted(counts)},
        "first_ts": _to_z(first_ts) if first_ts is not None else None,
        "last_ts": _to_z(last_ts) if last_ts is not None else None,
        "duration_seconds": duration_seconds,
        "approvals": approvals,
        "errors": errors,
    }


def validate_run_quality_metrics(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        raise TypeError("run_quality_metrics payload must be a JSON object")
    v = payload.get("schema_version")
    if not isinstance(v, int) or isinstance(v, bool) or v < 1:
        raise ValueError("run_quality_metrics.schema_version must be an integer >= 1")
    run_id = payload.get("run_id")
    if not isinstance(run_id, str) or not run_id.strip():
        raise ValueError("run_quality_metrics.run_id must be a non-empty string")
    ledger = payload.get("ledger")
    if not isinstance(ledger, dict):
        raise ValueError("run_quality_metrics.ledger must be an object")
    total_events = ledger.get("total_events")
    if not isinstance(total_events, int) or isinstance(total_events, bool) or total_events < 0:
        raise ValueError("run_quality_metrics.ledger.total_events must be an integer >= 0")
    if not isinstance(ledger.get("event_counts"), dict):
        raise ValueError("run_quality_metrics.ledger.event_counts must be an object")
    artifacts = payload.get("artifacts")
    if not isinstance(artifacts, dict) or not isinstance(artifacts.get("run_dir"), str):
        raise ValueError("run_quality_metrics.artifacts.run_dir is required")
    llm = payload.get("llm")
    if not isinstance(llm, dict):
        raise ValueError("run_quality_metrics.llm must be an object")
    for k in ["tool_calls", "tokens_in", "tokens_out"]:
        val = llm.get(k)
        if val is None:
            continue
        if not isinstance(val, int) or isinstance(val, bool) or val < 0:
            raise ValueError(f"run_quality_metrics.llm.{k} must be null or integer >= 0")
    cost = llm.get("cost_usd")
    if cost is not None and (isinstance(cost, bool) or not isinstance(cost, (int, float)) or float(cost) < 0):
        raise ValueError("run_quality_metrics.llm.cost_usd must be null or number >= 0")


def build_run_quality_metrics(
    *,
    repo_root: Path,
    run_id: str,
    workflow_id: str | None,
    ledger_path: Path,
    run_dir: Path,
) -> dict[str, Any]:
    events = read_ledger_events(ledger_path)
    payload: dict[str, Any] = {
        "schema_version": 1,
        "generated_at": utc_now_iso().replace("+00:00", "Z"),
        "run_id": str(run_id),
        "ledger": {
            "ledger_path": _safe_rel(repo_root, ledger_path),
            **_ledger_summary(events, run_id=str(run_id)),
        },
        "artifacts": {
            "run_dir": _safe_rel(repo_root, run_dir),
            **_dir_metrics(run_dir),
        },
        "llm": {"tool_calls": None, "tokens_in": None, "tokens_out": None, "cost_usd": None},
    }
    if workflow_id:
        payload["workflow_id"] = str(workflow_id)
    validate_run_quality_metrics(payload)
    return payload
