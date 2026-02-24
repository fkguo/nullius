from __future__ import annotations

import json
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from filelock import FileLock


class EngineStore:
    def __init__(self, root_dir: Path) -> None:
        self.root_dir = root_dir
        self.campaigns_root = root_dir / "campaigns"
        self.global_root = root_dir / "global"
        self.campaigns_root.mkdir(parents=True, exist_ok=True)
        self.global_root.mkdir(parents=True, exist_ok=True)

    def _read_json(self, path: Path, default: Any) -> Any:
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))

    def _write_json(self, path: Path, payload: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False, indent=2))
            fh.flush()
            os.fsync(fh.fileno())
        tmp.replace(path)

    def _append_jsonl(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False))
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())

    def campaign_dir(self, campaign_id: str) -> Path:
        return self.campaigns_root / campaign_id

    def campaign_manifest_path(self, campaign_id: str) -> Path:
        return self.campaign_dir(campaign_id) / "campaign.json"

    def load_campaign(self, campaign_id: str) -> dict[str, Any] | None:
        manifest_path = self.campaign_manifest_path(campaign_id)
        if not manifest_path.exists():
            return None
        return self._read_json(manifest_path, default={})

    def save_campaign(self, campaign: dict[str, Any]) -> None:
        campaign_id = campaign["campaign_id"]
        self._write_json(self.campaign_manifest_path(campaign_id), campaign)

    def nodes_latest_path(self, campaign_id: str) -> Path:
        return self.campaign_dir(campaign_id) / "nodes_latest.json"

    def nodes_log_path(self, campaign_id: str) -> Path:
        return self.campaign_dir(campaign_id) / "nodes_log.jsonl"

    def load_nodes(self, campaign_id: str) -> dict[str, dict[str, Any]]:
        return self._read_json(self.nodes_latest_path(campaign_id), default={})

    def save_nodes(self, campaign_id: str, nodes: dict[str, dict[str, Any]]) -> None:
        self._write_json(self.nodes_latest_path(campaign_id), nodes)

    def append_node_log(self, campaign_id: str, node: dict[str, Any], mutation: str) -> None:
        self._append_jsonl(
            self.nodes_log_path(campaign_id),
            {
                "mutation": mutation,
                "node_id": node["node_id"],
                "revision": node["revision"],
                "node": node,
            },
        )

    def artifact_path(self, campaign_id: str, artifact_type: str, artifact_name: str) -> Path:
        return self.campaign_dir(campaign_id) / "artifacts" / artifact_type / artifact_name

    def write_artifact(
        self,
        campaign_id: str,
        artifact_type: str,
        artifact_name: str,
        payload: dict[str, Any],
    ) -> str:
        path = self.artifact_path(campaign_id, artifact_type, artifact_name)
        self._write_json(path, payload)
        return path.resolve().as_uri()

    def load_artifact_from_ref(self, artifact_ref: str) -> dict[str, Any]:
        parsed = urlparse(artifact_ref)
        if parsed.scheme != "file":
            raise FileNotFoundError(f"unsupported artifact ref: {artifact_ref}")
        path = Path(unquote(parsed.path)).resolve()
        root = self.root_dir.resolve()
        if not str(path).startswith(str(root) + os.sep):
            raise FileNotFoundError(f"artifact ref outside store root: {artifact_ref}")
        if not path.exists():
            raise FileNotFoundError(path)
        return self._read_json(path, default={})

    def global_idempotency_path(self) -> Path:
        return self.global_root / "idempotency_store.json"

    def campaign_idempotency_path(self, campaign_id: str) -> Path:
        return self.campaign_dir(campaign_id) / "idempotency_store.json"

    def load_idempotency(self, campaign_id: str | None) -> dict[str, dict[str, Any]]:
        path = (
            self.campaign_idempotency_path(campaign_id)
            if campaign_id is not None
            else self.global_idempotency_path()
        )
        return self._read_json(path, default={})

    def save_idempotency(self, campaign_id: str | None, payload: dict[str, dict[str, Any]]) -> None:
        path = (
            self.campaign_idempotency_path(campaign_id)
            if campaign_id is not None
            else self.global_idempotency_path()
        )
        self._write_json(path, payload)

    def _lock_path(self, campaign_id: str | None) -> Path:
        if campaign_id is None:
            return self.global_root / ".lock"
        return self.campaign_dir(campaign_id) / ".lock"

    @contextmanager
    def mutation_lock(self, campaign_id: str | None):
        lock_path = self._lock_path(campaign_id)
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        file_lock = FileLock(str(lock_path) + ".lck")
        with file_lock:
            yield
