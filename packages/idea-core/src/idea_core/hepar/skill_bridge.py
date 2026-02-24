from __future__ import annotations

import json
from pathlib import Path
from threading import Lock, RLock
from typing import Any, Protocol
from uuid import uuid4

from idea_core.engine.utils import payload_hash, utc_now_iso

from .control_plane import HeparControlPlaneStore
from .fs_ops import atomic_write_json, safe_resolve_file_uri_under, safe_resolve_under
from .retry_ops import RetryPolicy, call_with_retry


_COMMAND_TO_RPC = {
    "hepar.idea.campaign_init": "campaign.init",
    "hepar.idea.campaign_status": "campaign.status",
    "hepar.idea.search_step": "search.step",
    "hepar.idea.eval_run": "eval.run",
    "hepar.idea.rank_compute": "rank.compute",
    "hepar.idea.node_promote": "node.promote",
    "hepar.idea.node_get": "node.get",
    "hepar.idea.node_list": "node.list",
}


class RpcTransport(Protocol):
    def call(self, method: str, params: dict[str, Any]) -> dict[str, Any]: ...


class HeparSkillBridge:
    """Thin hepar command -> idea-core RPC translation layer with replay artifacts."""

    def __init__(
        self,
        *,
        control_plane_store: HeparControlPlaneStore,
        rpc_transport: RpcTransport,
        rpc_timeout_s: float = 15.0,
        rpc_max_attempts: int = 3,
        rpc_backoff_initial_s: float = 0.05,
        rpc_backoff_max_s: float = 0.5,
    ) -> None:
        self.control_plane_store = control_plane_store
        self.rpc_transport = rpc_transport
        self.bridge_root = self.control_plane_store.artifacts_root / "skill_bridge"
        self.requests_root = self.bridge_root / "requests"
        self.responses_root = self.bridge_root / "responses"
        self.replay_index_path = self.bridge_root / "replay_index.json"
        self.bridge_root.mkdir(parents=True, exist_ok=True)
        self.requests_root.mkdir(parents=True, exist_ok=True)
        self.responses_root.mkdir(parents=True, exist_ok=True)
        self._replay_index_lock = RLock()
        self._command_locks_guard = Lock()
        self._command_locks: dict[str, Lock] = {}
        self._rpc_retry_policy = RetryPolicy(
            timeout_s=rpc_timeout_s,
            max_attempts=rpc_max_attempts,
            backoff_initial_s=rpc_backoff_initial_s,
            backoff_max_s=rpc_backoff_max_s,
        )

    def _write_json(self, path: Path, payload: dict[str, Any]) -> None:
        atomic_write_json(path, payload)

    def _read_json(self, path: Path, default: dict[str, Any]) -> dict[str, Any]:
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))

    def _artifact_ref(self, path: Path) -> str:
        return path.resolve().as_uri()

    def _artifact_ref_to_path(self, artifact_ref: str) -> Path:
        return safe_resolve_file_uri_under(self.bridge_root, artifact_ref)

    def _artifact_path(self, root: Path, command_id: str) -> Path:
        return safe_resolve_under(root, f"{command_id}.json")

    def _command_lock(self, command_id: str) -> Lock:
        with self._command_locks_guard:
            lock = self._command_locks.get(command_id)
            if lock is None:
                lock = Lock()
                self._command_locks[command_id] = lock
            return lock

    def _load_replay_index(self) -> dict[str, dict[str, Any]]:
        return self._read_json(self.replay_index_path, default={})

    def _save_replay_index(self, payload: dict[str, dict[str, Any]]) -> None:
        self._write_json(self.replay_index_path, payload)

    def _translate_command(self, command: str) -> str:
        rpc_method = _COMMAND_TO_RPC.get(command)
        if rpc_method is None:
            raise ValueError(f"unsupported hepar command: {command}")
        return rpc_method

    def execute(self, command_request: dict[str, Any]) -> dict[str, Any]:
        command_id = str(command_request.get("command_id") or uuid4())
        command_name = str(command_request.get("command", "")).strip()
        params = dict(command_request.get("params") or {})
        rpc_method = self._translate_command(command_name)
        lock = self._command_lock(command_id)

        with lock:
            marshaled_request = {
                "command_id": command_id,
                "hepar_command": command_name,
                "method": rpc_method,
                "params": params,
                "translated_at": utc_now_iso(),
            }
            request_hash = payload_hash({"method": rpc_method, "params": params})

            with self._replay_index_lock:
                replay_index = self._load_replay_index()
                replay_record = replay_index.get(command_id)
            if replay_record is not None:
                if replay_record["request_hash"] != request_hash:
                    raise ValueError(f"command_id_conflict: {command_id}")
                response_path = self._artifact_ref_to_path(replay_record["response_ref"])
                response_payload = self._read_json(response_path, default={})
                self.control_plane_store.append_ledger_event(
                    "skill_bridge.replay_hit",
                    command_id=command_id,
                    method=rpc_method,
                    request_hash=request_hash,
                    response_ref=replay_record["response_ref"],
                )
                return {
                    "command_id": command_id,
                    "method": rpc_method,
                    "replayed": True,
                    "request_artifact_ref": replay_record["request_ref"],
                    "response_artifact_ref": replay_record["response_ref"],
                    "rpc_result": response_payload["rpc_result"],
                }

            request_path = self._artifact_path(self.requests_root, command_id)
            self._write_json(request_path, marshaled_request)
            request_ref = self._artifact_ref(request_path)
            self.control_plane_store.append_ledger_event(
                "skill_bridge.request_marshaled",
                command_id=command_id,
                method=rpc_method,
                request_hash=request_hash,
                request_ref=request_ref,
            )

            rpc_result = call_with_retry(
                lambda: self.rpc_transport.call(rpc_method, params),
                op_name=f"skill_bridge.{rpc_method}",
                policy=self._rpc_retry_policy,
            )
            self.control_plane_store.append_ledger_event(
                "skill_bridge.rpc_called",
                command_id=command_id,
                method=rpc_method,
                request_hash=request_hash,
                rpc_result_hash=payload_hash(rpc_result),
            )

            response_payload = {
                "command_id": command_id,
                "method": rpc_method,
                "request_hash": request_hash,
                "rpc_result": rpc_result,
                "persisted_at": utc_now_iso(),
            }
            response_path = self._artifact_path(self.responses_root, command_id)
            self._write_json(response_path, response_payload)
            response_ref = self._artifact_ref(response_path)

            with self._replay_index_lock:
                replay_index = self._load_replay_index()
                existing = replay_index.get(command_id)
                if existing is not None and existing.get("request_hash") != request_hash:
                    raise ValueError(f"command_id_conflict: {command_id}")
                replay_index[command_id] = {
                    "request_hash": request_hash,
                    "request_ref": request_ref,
                    "response_ref": response_ref,
                }
                self._save_replay_index(replay_index)

            self.control_plane_store.append_ledger_event(
                "skill_bridge.response_persisted",
                command_id=command_id,
                method=rpc_method,
                request_hash=request_hash,
                response_ref=response_ref,
                response_hash=payload_hash(response_payload),
            )

            return {
                "command_id": command_id,
                "method": rpc_method,
                "replayed": False,
                "request_artifact_ref": request_ref,
                "response_artifact_ref": response_ref,
                "rpc_result": rpc_result,
            }
