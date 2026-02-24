from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from idea_core.engine.utils import payload_hash
from idea_core.hepar.control_plane import HeparControlPlaneStore
from idea_core.hepar.skill_bridge import HeparSkillBridge


class FakeRpcTransport:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def call(self, method: str, params: dict) -> dict:
        self.calls.append({"method": method, "params": params})
        return {
            "method": method,
            "echo": params,
            "ok": True,
        }


class FlakyRpcTransport(FakeRpcTransport):
    def __init__(self, *, fail_times: int) -> None:
        super().__init__()
        self.fail_times = fail_times

    def call(self, method: str, params: dict) -> dict:
        self.calls.append({"method": method, "params": params})
        if len(self.calls) <= self.fail_times:
            raise ConnectionError("transient rpc failure")
        return {
            "method": method,
            "echo": params,
            "ok": True,
        }


class SlowRpcTransport(FakeRpcTransport):
    def __init__(self, *, delay_s: float) -> None:
        super().__init__()
        self.delay_s = delay_s

    def call(self, method: str, params: dict) -> dict:
        time.sleep(self.delay_s)
        return super().call(method, params)


def _load_json(uri: str) -> dict:
    assert uri.startswith("file://")
    path = Path(uri[7:])
    return json.loads(path.read_text(encoding="utf-8"))


def test_hepar_command_translates_to_rpc_and_persists_artifacts(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    transport = FakeRpcTransport()
    bridge = HeparSkillBridge(control_plane_store=store, rpc_transport=transport)

    result = bridge.execute(
        {
            "command_id": "cmd-1",
            "command": "hepar.idea.rank_compute",
            "params": {
                "campaign_id": "campaign-1",
                "method": "pareto",
                "idempotency_key": "rank-1",
            },
        }
    )

    assert result["replayed"] is False
    assert transport.calls == [
        {
            "method": "rank.compute",
            "params": {
                "campaign_id": "campaign-1",
                "method": "pareto",
                "idempotency_key": "rank-1",
            },
        }
    ]

    req_payload = _load_json(result["request_artifact_ref"])
    resp_payload = _load_json(result["response_artifact_ref"])
    assert req_payload["method"] == "rank.compute"
    assert req_payload["params"]["campaign_id"] == "campaign-1"
    assert resp_payload["rpc_result"]["ok"] is True

    event_types = [event["event_type"] for event in store.read_ledger_events()]
    assert "skill_bridge.request_marshaled" in event_types
    assert "skill_bridge.rpc_called" in event_types
    assert "skill_bridge.response_persisted" in event_types


def test_unknown_command_is_rejected_without_rpc_call(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    transport = FakeRpcTransport()
    bridge = HeparSkillBridge(control_plane_store=store, rpc_transport=transport)

    try:
        bridge.execute(
            {
                "command_id": "cmd-bad",
                "command": "hepar.idea.unknown_command",
                "params": {},
            }
        )
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "unsupported hepar command" in str(exc)

    assert transport.calls == []


def test_replay_returns_cached_response_without_second_rpc_call(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    transport = FakeRpcTransport()
    bridge = HeparSkillBridge(control_plane_store=store, rpc_transport=transport)

    command = {
        "command_id": "cmd-replay",
        "command": "hepar.idea.node_get",
        "params": {
            "campaign_id": "campaign-1",
            "node_id": "node-1",
        },
    }

    first = bridge.execute(command)
    second = bridge.execute(command)

    assert first["replayed"] is False
    assert second["replayed"] is True
    assert len(transport.calls) == 1
    assert first["rpc_result"] == second["rpc_result"]


def test_replay_with_space_in_artifact_path_round_trips_uri(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "with space" / "hepar")
    transport = FakeRpcTransport()
    bridge = HeparSkillBridge(control_plane_store=store, rpc_transport=transport)

    command = {
        "command_id": "cmd-space-uri",
        "command": "hepar.idea.node_list",
        "params": {
            "campaign_id": "campaign-space",
            "cursor": None,
        },
    }

    first = bridge.execute(command)
    second = bridge.execute(command)

    assert first["replayed"] is False
    assert second["replayed"] is True
    assert len(transport.calls) == 1
    assert first["rpc_result"] == second["rpc_result"]


def test_bridge_passes_params_without_business_logic_mutation(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    transport = FakeRpcTransport()
    bridge = HeparSkillBridge(control_plane_store=store, rpc_transport=transport)

    params = {
        "campaign_id": "campaign-2",
        "node_ids": ["node-a", "node-b"],
        "evaluator_config": {"dimensions": ["novelty", "grounding"], "n_reviewers": 2},
        "idempotency_key": "eval-1",
    }
    bridge.execute(
        {
            "command_id": "cmd-passthrough",
            "command": "hepar.idea.eval_run",
            "params": params,
        }
    )

    assert transport.calls[0]["method"] == "eval.run"
    assert transport.calls[0]["params"] == params


def test_command_id_path_escape_is_rejected(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    bridge = HeparSkillBridge(control_plane_store=store, rpc_transport=FakeRpcTransport())

    with pytest.raises(ValueError, match="path"):
        bridge.execute(
            {
                "command_id": "../escape",
                "command": "hepar.idea.node_get",
                "params": {"campaign_id": "campaign-1", "node_id": "node-1"},
            }
        )


def test_replay_ref_rejects_file_uri_netloc_bypass(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    bridge = HeparSkillBridge(control_plane_store=store, rpc_transport=FakeRpcTransport())
    params = {"campaign_id": "campaign-1", "node_id": "node-1"}
    request_hash = payload_hash({"method": "node.get", "params": params})
    bridge._save_replay_index(  # type: ignore[attr-defined] - test-only setup
        {
            "cmd-netloc": {
                "request_hash": request_hash,
                "request_ref": "file:///tmp/request.json",
                "response_ref": "file://evilhost/tmp/response.json",
            }
        }
    )

    with pytest.raises(ValueError, match="netloc"):
        bridge.execute(
            {
                "command_id": "cmd-netloc",
                "command": "hepar.idea.node_get",
                "params": params,
            }
        )


def test_rpc_call_retries_on_transient_failure(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    transport = FlakyRpcTransport(fail_times=2)
    bridge = HeparSkillBridge(
        control_plane_store=store,
        rpc_transport=transport,
        rpc_max_attempts=3,
        rpc_timeout_s=0.2,
        rpc_backoff_initial_s=0.001,
        rpc_backoff_max_s=0.002,
    )

    result = bridge.execute(
        {
            "command_id": "cmd-retry",
            "command": "hepar.idea.node_get",
            "params": {"campaign_id": "campaign-1", "node_id": "node-1"},
        }
    )

    assert result["replayed"] is False
    assert len(transport.calls) == 3


def test_rpc_call_timeout_has_bounded_retries(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    bridge = HeparSkillBridge(
        control_plane_store=store,
        rpc_transport=SlowRpcTransport(delay_s=0.05),
        rpc_max_attempts=2,
        rpc_timeout_s=0.005,
        rpc_backoff_initial_s=0.001,
        rpc_backoff_max_s=0.002,
    )

    with pytest.raises(TimeoutError):
        bridge.execute(
            {
                "command_id": "cmd-timeout",
                "command": "hepar.idea.node_get",
                "params": {"campaign_id": "campaign-1", "node_id": "node-1"},
            }
        )


def test_parallel_replay_for_same_command_id_only_calls_rpc_once(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")

    class SlowCountingTransport(FakeRpcTransport):
        def __init__(self) -> None:
            super().__init__()
            self.lock = threading.Lock()

        def call(self, method: str, params: dict) -> dict:
            with self.lock:
                self.calls.append({"method": method, "params": params})
            time.sleep(0.01)
            return {"method": method, "echo": params, "ok": True}

    transport = SlowCountingTransport()
    bridge = HeparSkillBridge(control_plane_store=store, rpc_transport=transport)
    command = {
        "command_id": "cmd-parallel",
        "command": "hepar.idea.node_get",
        "params": {"campaign_id": "campaign-1", "node_id": "node-1"},
    }

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = [future.result() for future in [pool.submit(bridge.execute, command) for _ in range(8)]]

    assert len(transport.calls) == 1
    assert sum(1 for row in results if row["replayed"] is False) == 1
    assert sum(1 for row in results if row["replayed"] is True) == 7


def test_parallel_replay_index_updates_keep_all_entries(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    bridge = HeparSkillBridge(control_plane_store=store, rpc_transport=FakeRpcTransport())

    commands = [
        {
            "command_id": f"cmd-{idx}",
            "command": "hepar.idea.node_get",
            "params": {"campaign_id": "campaign-1", "node_id": f"node-{idx}"},
        }
        for idx in range(20)
    ]
    with ThreadPoolExecutor(max_workers=10) as pool:
        _ = [future.result() for future in [pool.submit(bridge.execute, command) for command in commands]]

    replay_index = json.loads(bridge.replay_index_path.read_text(encoding="utf-8"))
    assert len(replay_index) == 20
