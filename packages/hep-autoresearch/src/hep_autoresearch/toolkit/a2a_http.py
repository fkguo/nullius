from __future__ import annotations

import json
import uuid
from http.server import BaseHTTPRequestHandler
from typing import Any

from .agent_contracts import build_error_envelope


def validated_trace_id(candidate: Any) -> str | None:
    if not isinstance(candidate, str) or not candidate.strip():
        return None
    try:
        parsed = uuid.UUID(candidate.strip())
    except ValueError:
        return None
    return str(parsed) if parsed.version == 4 else None


def build_rpc_ok(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def build_rpc_error(
    *,
    request_id: Any,
    rpc_code: int,
    rpc_message: str,
    trace_id: str | None,
    run_id: str | None,
    data: dict[str, Any],
) -> dict[str, Any]:
    envelope_code = _error_code_for_rpc(int(rpc_code))
    envelope_trace_id = trace_id or str(uuid.uuid4())
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {
            "code": rpc_code,
            "message": rpc_message,
            "data": build_error_envelope(
                domain="hepar",
                code=envelope_code,
                message=rpc_message,
                run_id=run_id,
                trace_id=envelope_trace_id,
                data=data,
            ),
        },
    }


def write_json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(int(status))
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _error_code_for_rpc(code: int) -> str:
    if code in {-32700, -32600, -32602, -32000}:
        return "INVALID_PARAMS"
    if code in {-32601, -32004}:
        return "NOT_FOUND"
    return "UPSTREAM_ERROR"
