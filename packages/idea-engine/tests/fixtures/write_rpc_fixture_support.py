from __future__ import annotations

import json
import shutil
import sys
import tempfile
from contextlib import ExitStack
from copy import deepcopy
from pathlib import Path
from uuid import UUID
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[4]
IDEA_CORE_SRC = REPO_ROOT / "packages/idea-core/src"
if str(IDEA_CORE_SRC) not in sys.path:
    sys.path.insert(0, str(IDEA_CORE_SRC))

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR  # noqa: E402
from idea_core.engine.coordinator import IdeaCoreService  # noqa: E402
from idea_core.rpc.server import handle_request  # noqa: E402
import idea_core.engine.coordinator as coordinator  # noqa: E402


def snapshot_store(root_dir: Path) -> dict[str, object]:
    snapshot: dict[str, object] = {}
    for path in sorted(root_dir.rglob("*")):
        if path.is_dir():
            continue
        rel = path.relative_to(root_dir).as_posix()
        if rel.endswith(".jsonl"):
            lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
            snapshot[rel] = lines
        elif rel.endswith(".json"):
            snapshot[rel] = json.loads(path.read_text(encoding="utf-8"))
    return snapshot


def materialize_snapshot(root_dir: Path, snapshot: dict[str, object]) -> None:
    for rel, payload in snapshot.items():
        path = root_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if rel.endswith(".jsonl"):
            lines = "\n".join(json.dumps(item, ensure_ascii=False) for item in payload)  # type: ignore[arg-type]
            path.write_text(lines + ("\n" if lines else ""), encoding="utf-8")
            continue
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def run_case(
    *,
    name: str,
    requests: list[dict[str, object]],
    now: str,
    uuid_sequence: list[str],
    initial_store: dict[str, object] | None = None,
) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="idea-engine-write-fixture-") as tmp_dir:
        store_root = Path(tmp_dir) / "store"
        store_root.mkdir(parents=True, exist_ok=True)
        materialize_snapshot(store_root, initial_store or {})
        service = IdeaCoreService(data_dir=store_root, contract_dir=DEFAULT_CONTRACT_DIR)
        steps: list[dict[str, object]] = []
        with ExitStack() as stack:
            stack.enter_context(patch.object(coordinator, "utc_now_iso", return_value=now))
            stack.enter_context(patch.object(coordinator, "uuid4", side_effect=[UUID(value) for value in uuid_sequence]))
            for request in requests:
                response = handle_request(service, deepcopy(request))
                steps.append({"request": deepcopy(request), "response": response})
        return {
            "name": name,
            "now": now,
            "uuid_sequence": uuid_sequence,
            "initial_store": initial_store or {},
            "steps": steps,
            "expected_store": snapshot_store(store_root),
        }


def prepared_recovery_initial_store(request: dict[str, object], now: str, uuid_sequence: list[str]) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="idea-engine-write-recovery-") as tmp_dir:
        store_root = Path(tmp_dir) / "store"
        service = IdeaCoreService(data_dir=store_root, contract_dir=DEFAULT_CONTRACT_DIR)
        with ExitStack() as stack:
            stack.enter_context(patch.object(coordinator, "utc_now_iso", return_value=now))
            stack.enter_context(patch.object(coordinator, "uuid4", side_effect=[UUID(value) for value in uuid_sequence]))
            response = handle_request(service, deepcopy(request))
        global_store_path = store_root / "global/idempotency_store.json"
        global_store = json.loads(global_store_path.read_text(encoding="utf-8"))
        global_store["campaign.init:write-init-recovery"]["state"] = "prepared"
        global_store_path.write_text(json.dumps(global_store, ensure_ascii=False, indent=2), encoding="utf-8")
        campaign_id = response["result"]["campaign_id"]
        shutil.rmtree(store_root / "campaigns" / campaign_id)
        return snapshot_store(store_root)
