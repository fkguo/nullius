from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.coordinator import RpcError
from idea_core.rpc import server as rpc_server


class _ExplodingService:
    def handle(self, method: str, params: dict[str, object]) -> dict[str, object]:
        if method == "explode":
            raise RuntimeError("boom")
        raise RpcError(code=-32601, message="method_not_found", data={"reason": "method_not_found"})


def test_handle_request_fail_closed_internal_error_boundary() -> None:
    response = rpc_server.handle_request(
        _ExplodingService(),
        {"jsonrpc": "2.0", "id": 7, "method": "explode", "params": {}},
    )

    assert response["error"]["code"] == -32603
    assert response["error"]["message"] == "internal_error"
    assert response["error"]["data"]["reason"] == "internal_error"


def test_main_returns_parse_error_for_invalid_json(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(rpc_server, "parse_args", lambda: SimpleNamespace(data_dir=tmp_path / "runs", contract_dir=DEFAULT_CONTRACT_DIR))
    monkeypatch.setattr(
        rpc_server,
        "IdeaCoreService",
        lambda data_dir, contract_dir, domain_pack_index=None: _ExplodingService(),
    )
    monkeypatch.setattr(sys, "stdin", io.StringIO("{invalid\n"))
    stdout = io.StringIO()
    monkeypatch.setattr(sys, "stdout", stdout)

    assert rpc_server.main() == 0

    response = json.loads(stdout.getvalue().strip())
    assert response["error"]["code"] == -32700
    assert response["error"]["message"] == "parse_error"


def test_main_returns_invalid_request_for_non_object_json(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(rpc_server, "parse_args", lambda: SimpleNamespace(data_dir=tmp_path / "runs", contract_dir=DEFAULT_CONTRACT_DIR))
    monkeypatch.setattr(
        rpc_server,
        "IdeaCoreService",
        lambda data_dir, contract_dir, domain_pack_index=None: _ExplodingService(),
    )
    monkeypatch.setattr(sys, "stdin", io.StringIO("[1, 2, 3]\n"))
    stdout = io.StringIO()
    monkeypatch.setattr(sys, "stdout", stdout)

    assert rpc_server.main() == 0

    response = json.loads(stdout.getvalue().strip())
    assert response["error"]["code"] == -32600
    assert response["error"]["message"] == "invalid_request"
