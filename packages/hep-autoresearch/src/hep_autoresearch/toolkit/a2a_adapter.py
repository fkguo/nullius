from __future__ import annotations

import hmac
import ipaddress
import json
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .a2a_dispatch import dispatch_agent_message
from .a2a_http import build_rpc_error, build_rpc_ok, validated_trace_id, write_json_response
from .agent_bindings import AgentDispatchContext, dispatchable_agent_ids
from .agent_contracts import validate_agent_message
from .agent_registry import load_agent_registry

_MAX_REQUEST_BYTES = 10 * 1024 * 1024


@dataclass(frozen=True)
class A2AAdapterConfig:
    enabled: bool = False
    bind_host: str = "127.0.0.1"
    bind_port: int = 0
    auth_token: str | None = None
    non_loopback_allowlist: tuple[str, ...] = ()

    def validate(self) -> None:
        if not self.enabled:
            return
        if not isinstance(self.auth_token, str) or not self.auth_token.strip():
            raise ValueError("a2a adapter requires a non-empty auth token when enabled")
        host = str(self.bind_host).strip()
        if not host:
            raise ValueError("a2a adapter bind_host must be non-empty")
        if _is_loopback_host(host):
            return
        allowlist = {str(value).strip() for value in self.non_loopback_allowlist if str(value).strip()}
        if host not in allowlist:
            raise ValueError(f"a2a adapter non-loopback bind_host requires explicit allowlist: {host}")


def _is_loopback_host(host: str) -> bool:
    if host in {"localhost", "ip6-localhost"}:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class A2AAdapterServer:
    def __init__(self, *, config: A2AAdapterConfig, dispatch_context: AgentDispatchContext) -> None:
        config.validate()
        if not config.enabled:
            raise ValueError("a2a adapter is disabled")
        self._config = config
        self._dispatch_context = dispatch_context
        self._registry = load_agent_registry(dispatchable_agent_ids=dispatchable_agent_ids())

        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                outer._handle_http(self)

            def log_message(self, format: str, *args: object) -> None:  # noqa: A003
                return

        self._httpd = ThreadingHTTPServer((config.bind_host, int(config.bind_port)), Handler)

    @property
    def base_url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}/a2a"

    def serve_forever(self) -> None:
        self._httpd.serve_forever()

    def shutdown(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()

    def _handle_http(self, handler: BaseHTTPRequestHandler) -> None:
        trace_id = str(uuid.uuid4())
        if handler.path != "/a2a":
            write_json_response(
                handler,
                404,
                build_rpc_error(
                    request_id=None,
                    rpc_code=-32601,
                    rpc_message="method_not_found",
                    trace_id=trace_id,
                    run_id=None,
                    data={"reason": "path_not_found"},
                ),
            )
            return
        auth_header = handler.headers.get("Authorization") or ""
        if not hmac.compare_digest(auth_header, f"Bearer {self._config.auth_token}"):
            write_json_response(
                handler,
                401,
                build_rpc_error(
                    request_id=None,
                    rpc_code=-32000,
                    rpc_message="unauthorized",
                    trace_id=trace_id,
                    run_id=None,
                    data={"reason": "auth_required"},
                ),
            )
            return
        try:
            body_length = int(handler.headers.get("Content-Length", "0") or "0")
            if body_length < 0:
                raise ValueError("negative content length")
            if body_length > _MAX_REQUEST_BYTES:
                write_json_response(
                    handler,
                    413,
                    build_rpc_error(
                        request_id=None,
                        rpc_code=-32602,
                        rpc_message="invalid_params",
                        trace_id=trace_id,
                        run_id=None,
                        data={"reason": "payload_too_large", "max_bytes": _MAX_REQUEST_BYTES},
                    ),
                )
                return
            raw = handler.rfile.read(body_length)
            request = json.loads(raw.decode("utf-8"))
        except Exception:
            write_json_response(
                handler,
                400,
                build_rpc_error(
                    request_id=None,
                    rpc_code=-32700,
                    rpc_message="parse_error",
                    trace_id=trace_id,
                    run_id=None,
                    data={"reason": "parse_error"},
                ),
            )
            return
        if not isinstance(request, dict) or request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
            write_json_response(
                handler,
                400,
                build_rpc_error(
                    request_id=request.get("id") if isinstance(request, dict) else None,
                    rpc_code=-32600,
                    rpc_message="invalid_request",
                    trace_id=trace_id,
                    run_id=None,
                    data={"reason": "invalid_request"},
                ),
            )
            return
        params = request.get("params", {})
        if not isinstance(params, dict):
            write_json_response(
                handler,
                400,
                build_rpc_error(
                    request_id=request.get("id"),
                    rpc_code=-32602,
                    rpc_message="invalid_params",
                    trace_id=trace_id,
                    run_id=None,
                    data={"reason": "schema_invalid"},
                ),
            )
            return
        status, response = self._dispatch(request_id=request.get("id"), method=str(request["method"]), params=params)
        write_json_response(handler, status, response)

    def _dispatch(self, *, request_id: Any, method: str, params: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        trace_id = str(uuid.uuid4())
        if method == "agent.discover":
            capability = params.get("capability")
            if capability is not None and (not isinstance(capability, str) or not capability.strip()):
                return 400, build_rpc_error(request_id=request_id, rpc_code=-32602, rpc_message="invalid_params", trace_id=trace_id, run_id=None, data={"reason": "schema_invalid"})
            return 200, build_rpc_ok(request_id, {"agents": self._registry.list_agents(capability=capability if isinstance(capability, str) else None)})
        if method == "agent.get_card":
            agent_id = params.get("agent_id")
            if not isinstance(agent_id, str) or not agent_id.strip():
                return 400, build_rpc_error(request_id=request_id, rpc_code=-32602, rpc_message="invalid_params", trace_id=trace_id, run_id=None, data={"reason": "schema_invalid"})
            try:
                card = self._registry.get_card(agent_id.strip())
            except KeyError:
                return 404, build_rpc_error(request_id=request_id, rpc_code=-32004, rpc_message="not_found", trace_id=trace_id, run_id=None, data={"reason": "agent_not_found", "agent_id": agent_id.strip()})
            return 200, build_rpc_ok(
                request_id,
                {"card": card, "available_for_dispatch": card["agent_id"] in self._registry.dispatchable_agent_ids},
            )
        if method != "agent.message":
            return 404, build_rpc_error(request_id=request_id, rpc_code=-32601, rpc_message="method_not_found", trace_id=trace_id, run_id=None, data={"reason": "method_not_found", "method": method})
        message = params.get("message")
        try:
            request_message = validate_agent_message(message)
        except ValueError as exc:
            trace_id = validated_trace_id(message.get("trace_id")) if isinstance(message, dict) else None
            return 400, build_rpc_error(request_id=request_id, rpc_code=-32602, rpc_message="invalid_params", trace_id=trace_id, run_id=None, data={"reason": "schema_invalid", "details": {"message": str(exc)}})
        response_message = dispatch_agent_message(
            registry=self._registry,
            dispatch_context=self._dispatch_context,
            request_message=request_message,
        )
        return 200, build_rpc_ok(request_id, {"message": response_message})
