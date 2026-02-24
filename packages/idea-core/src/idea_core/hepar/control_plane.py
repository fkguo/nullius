from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import uuid4

from idea_core.engine.utils import payload_hash, utc_now_iso

from .fs_ops import atomic_write_json, atomic_write_text

_ALLOWED_WORK_STATUS = {
    "ok",
    "failed",
    "canceled",
    "budget_exhausted",
    "permission_denied",
}

_ALLOWED_COORDINATION_POLICY = {
    "parallel",
    "sequential",
    "stage_gated",
}


@dataclass(frozen=True)
class WorkOrder:
    work_id: str
    campaign_id: str
    idea_id: str
    island_id: str
    role_id: str
    input_artifacts: list[str]
    output_schema_ref: str
    tool_policy: dict[str, Any]
    budget: dict[str, Any]
    idempotency_key: str
    deadline: str
    priority: str

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        if not payload["work_id"].strip():
            raise ValueError("work_id must be non-empty")
        if not payload["idempotency_key"].strip():
            raise ValueError("idempotency_key must be non-empty")
        return payload


@dataclass(frozen=True)
class WorkResult:
    work_id: str
    status: str
    outputs: list[str]
    summary: str
    provenance: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        if payload["status"] not in _ALLOWED_WORK_STATUS:
            allowed = ", ".join(sorted(_ALLOWED_WORK_STATUS))
            raise ValueError(f"unsupported work result status: {payload['status']} (allowed: {allowed})")
        return payload


@dataclass(frozen=True)
class TeamPlan:
    team_id: str
    coordination_policy: str
    roles: list[dict[str, Any]]
    merge_policy: dict[str, Any]
    clean_room: bool

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        if payload["coordination_policy"] not in _ALLOWED_COORDINATION_POLICY:
            allowed = ", ".join(sorted(_ALLOWED_COORDINATION_POLICY))
            raise ValueError(
                "unsupported coordination policy: "
                f"{payload['coordination_policy']} (allowed: {allowed})"
            )
        if not payload["roles"]:
            raise ValueError("roles must not be empty")
        return payload


class HeparControlPlaneStore:
    """Local artifact + ledger store for M4 control-plane workflows."""

    def __init__(self, root_dir: Path) -> None:
        self.root_dir = root_dir
        self.artifacts_root = root_dir / "artifacts"
        self.ledger_root = root_dir / "ledger"
        self.ledger_path = self.ledger_root / "events.jsonl"
        self.artifacts_root.mkdir(parents=True, exist_ok=True)
        self.ledger_root.mkdir(parents=True, exist_ok=True)
        self._io_lock = RLock()
        self._session_event_keys: dict[str, set[str]] = {}
        self._session_event_keys_loaded = False

    def _write_json(self, path: Path, payload: dict[str, Any]) -> None:
        with self._io_lock:
            atomic_write_json(path, payload)

    def _append_jsonl(self, path: Path, payload: dict[str, Any]) -> None:
        with self._io_lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            prior = path.read_text(encoding="utf-8") if path.exists() else ""
            line = json.dumps(payload, ensure_ascii=False) + "\n"
            atomic_write_text(path, prior + line)
            self._index_ledger_event(payload)

    def _artifact_path(self, category: str, object_id: str) -> Path:
        return self.artifacts_root / category / f"{object_id}.json"

    def _index_ledger_event(self, event: dict[str, Any]) -> None:
        session_id = event.get("session_id")
        event_key = event.get("event_key")
        if not isinstance(session_id, str) or not session_id:
            return
        if not isinstance(event_key, str) or not event_key:
            return
        self._session_event_keys.setdefault(session_id, set()).add(event_key)

    def _ensure_session_event_key_index(self) -> None:
        if self._session_event_keys_loaded:
            return
        with self._io_lock:
            if self._session_event_keys_loaded:
                return
            if self.ledger_path.exists():
                for line in self.ledger_path.read_text(encoding="utf-8").splitlines():
                    if not line.strip():
                        continue
                    self._index_ledger_event(json.loads(line))
            self._session_event_keys_loaded = True

    def _write_artifact(self, *, category: str, object_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        path = self._artifact_path(category, object_id)
        self._write_json(path, payload)
        return {
            "artifact_ref": path.resolve().as_uri(),
            "artifact_hash": payload_hash(payload),
        }

    def append_ledger_event(self, event_type: str, **fields: Any) -> dict[str, Any]:
        event = {
            "event_id": str(uuid4()),
            "timestamp": utc_now_iso(),
            "event_type": event_type,
        }
        event.update(fields)
        self._append_jsonl(self.ledger_path, event)
        return event

    def read_ledger_events(self) -> list[dict[str, Any]]:
        if not self.ledger_path.exists():
            return []
        events: list[dict[str, Any]] = []
        for line in self.ledger_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            events.append(json.loads(line))
        return events

    def has_ledger_event(self, *, session_id: str, event_key: str) -> bool:
        self._ensure_session_event_key_index()
        return event_key in self._session_event_keys.get(session_id, set())

    def session_event_keys(self, *, session_id: str) -> set[str]:
        self._ensure_session_event_key_index()
        return set(self._session_event_keys.get(session_id, set()))

    def record_work_order(self, work_order: WorkOrder) -> dict[str, Any]:
        payload = work_order.to_dict()
        record = self._write_artifact(
            category="work_orders",
            object_id=work_order.work_id,
            payload=payload,
        )
        self.append_ledger_event(
            "work_order.created",
            work_id=work_order.work_id,
            idempotency_key=work_order.idempotency_key,
            artifact_ref=record["artifact_ref"],
            artifact_hash=record["artifact_hash"],
        )
        return record

    def record_work_result(self, work_result: WorkResult) -> dict[str, Any]:
        payload = work_result.to_dict()
        record = self._write_artifact(
            category="work_results",
            object_id=work_result.work_id,
            payload=payload,
        )
        self.append_ledger_event(
            "work_result.recorded",
            work_id=work_result.work_id,
            status=work_result.status,
            artifact_ref=record["artifact_ref"],
            artifact_hash=record["artifact_hash"],
        )
        return record

    def register_team_plan(self, team_plan: TeamPlan) -> dict[str, Any]:
        payload = team_plan.to_dict()
        record = self._write_artifact(
            category="team_plans",
            object_id=team_plan.team_id,
            payload=payload,
        )
        self.append_ledger_event(
            "team_plan.registered",
            team_id=team_plan.team_id,
            coordination_policy=team_plan.coordination_policy,
            artifact_ref=record["artifact_ref"],
            artifact_hash=record["artifact_hash"],
        )
        return record
