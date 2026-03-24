from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


sys.path.insert(0, str(_src_root()))
for name in [key for key in sys.modules if key == "hep_autoresearch" or key.startswith("hep_autoresearch.")]:
    sys.modules.pop(name)

from hep_autoresearch.toolkit.mcp_config import McpServerConfig
from hep_autoresearch.toolkit.mcp_stdio_client import (
    McpInitializeError,
    McpProtocolError,
    McpRequestTimeout,
    McpStdioClient,
    McpTransportError,
)


class _FailingStdin:
    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def write(self, _: str) -> int:
        raise self._exc

    def flush(self) -> None:
        raise AssertionError("flush() should not be reached after write failure")


class _FakeProc:
    def __init__(self, stdin: object) -> None:
        self.stdin = stdin
        self.stdout = None
        self.stderr = None
        self.returncode = 0

    def poll(self) -> None:
        return None


class _RecordingStdin:
    def __init__(self) -> None:
        self.writes: list[str] = []

    def write(self, payload: str) -> int:
        self.writes.append(payload)
        return len(payload)

    def flush(self) -> None:
        return None


class _CallbackStdin:
    def __init__(self, callback) -> None:
        self._callback = callback

    def write(self, payload: str) -> int:
        self._callback(payload)
        return len(payload)

    def flush(self) -> None:
        return None


def _make_client() -> McpStdioClient:
    cfg = McpServerConfig(name="stub", command="python3", args=(), env={})
    return McpStdioClient(cfg=cfg, cwd=Path.cwd(), env={})


def _respond(client: McpStdioClient, msg: dict[str, object]) -> None:
    next(iter(client._pending.values())).put_nowait(msg)


def test_request_write_failure_raises_transport_error() -> None:
    client = _make_client()
    client._proc = _FakeProc(_FailingStdin(BrokenPipeError("pipe closed")))

    with pytest.raises(McpTransportError, match="failed to write MCP request: 'tools/list'"):
        client._request("tools/list", {}, timeout_seconds=0.1)

    assert client._pending == {}


def test_request_error_response_raises_protocol_error_with_upstream_code() -> None:
    client = _make_client()
    client._proc = _FakeProc(
        _CallbackStdin(
            lambda _: _respond(
                client,
                {"jsonrpc": "2.0", "id": 1, "error": {"code": -32603, "message": "boom"}},
            )
        )
    )

    with pytest.raises(McpProtocolError, match="MCP error response for 'tools/list'") as excinfo:
        client._request("tools/list", {}, timeout_seconds=0.1)

    assert excinfo.value.error_code == "-32603"
    assert client._pending == {}


def test_request_bad_result_shape_raises_protocol_error() -> None:
    client = _make_client()
    client._proc = _FakeProc(
        _CallbackStdin(lambda _: _respond(client, {"jsonrpc": "2.0", "id": 1, "result": "bad-shape"}))
    )

    with pytest.raises(McpProtocolError, match="bad MCP result shape for 'tools/list': str"):
        client._request("tools/list", {}, timeout_seconds=0.1)

    assert client._pending == {}


def test_request_serialization_failure_cleans_pending_without_writing() -> None:
    client = _make_client()
    stdin = _RecordingStdin()
    client._proc = _FakeProc(stdin)

    with pytest.raises(TypeError):
        client._request("tools/list", {"bad": object()}, timeout_seconds=0.1)

    assert stdin.writes == []
    assert client._pending == {}


def test_initialize_wraps_timeout_as_initialize_error() -> None:
    client = _make_client()

    with patch.object(client, "_request", side_effect=McpRequestTimeout("timeout")):
        with pytest.raises(McpInitializeError, match="timed out"):
            client.initialize(client_name="hepar", client_version="0.0.1", timeout_seconds=0.2)


def test_initialize_rejects_missing_protocol_version() -> None:
    client = _make_client()

    with patch.object(client, "_request", return_value={}), patch.object(client, "_notify", return_value=None):
        with pytest.raises(McpInitializeError, match="missing protocolVersion"):
            client.initialize(client_name="hepar", client_version="0.0.1")


def test_initialize_wraps_initialized_notification_transport_failure() -> None:
    client = _make_client()

    with patch.object(client, "_request", return_value={"protocolVersion": "2025-03-26"}), patch.object(
        client,
        "_notify",
        side_effect=McpTransportError("notification write failed"),
    ):
        with pytest.raises(McpInitializeError, match="acknowledgement failed"):
            client.initialize(client_name="hepar", client_version="0.0.1")


def test_call_tool_json_injects_trace_id_and_preserves_response_trace_id() -> None:
    client = _make_client()
    observed: dict[str, object] = {}

    def _callback(payload: str) -> None:
        message = json.loads(payload)
        observed["message"] = message
        sent_args = message["params"]["arguments"]
        trace_id = sent_args["_trace_id"]
        _respond(
            client,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "content": [{"type": "text", "text": json.dumps({"ok": True, "trace_id": trace_id})}],
                    "isError": False,
                },
            },
        )

    client._proc = _FakeProc(_CallbackStdin(_callback))

    result = client.call_tool_json(tool_name="stub_tool", arguments={"query": "alpha"}, timeout_seconds=0.1)

    sent_args = observed["message"]["params"]["arguments"]
    assert sent_args["query"] == "alpha"
    assert isinstance(sent_args["_trace_id"], str) and sent_args["_trace_id"]
    assert result.ok is True
    assert result.trace_id == sent_args["_trace_id"]
    assert result.json == {"ok": True, "trace_id": sent_args["_trace_id"]}
