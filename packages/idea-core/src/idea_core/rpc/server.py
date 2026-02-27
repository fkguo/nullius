from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.coordinator import IdeaCoreService, RpcError


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DATA_DIR = ROOT / "runs"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="idea-core stdio JSON-RPC server")
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=DEFAULT_DATA_DIR,
        help="Directory for campaign state/artifacts",
    )
    parser.add_argument(
        "--contract-dir",
        type=Path,
        default=DEFAULT_CONTRACT_DIR,
        help="Directory containing vendored OpenRPC + schemas",
    )
    return parser.parse_args()


def _jsonrpc_error(id_value: Any, code: int, message: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": id_value,
        "error": {
            "code": code,
            "message": message,
            "data": data,
        },
    }


def _jsonrpc_result(id_value: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": id_value,
        "result": result,
    }


def handle_request(service: IdeaCoreService, request: dict[str, Any]) -> dict[str, Any]:
    req_id = request.get("id")
    method = request.get("method")
    params = request.get("params", {})

    if request.get("jsonrpc") != "2.0":
        return _jsonrpc_error(req_id, -32600, "invalid_request", {"reason": "invalid_request"})

    if not isinstance(method, str):
        return _jsonrpc_error(req_id, -32600, "invalid_request", {"reason": "invalid_request"})

    if not isinstance(params, dict):
        return _jsonrpc_error(
            req_id,
            -32602,
            "invalid_params",
            {"reason": "schema_invalid", "details": {"message": "params must be an object"}},
        )

    try:
        result = service.handle(method, params)
    except RpcError as exc:
        return _jsonrpc_error(req_id, exc.code, exc.message, exc.data)
    except Exception as exc:  # pragma: no cover - safety belt
        return _jsonrpc_error(
            req_id,
            -32603,
            "internal_error",
            {"reason": "internal_error", "details": {"message": str(exc)}},
        )

    return _jsonrpc_result(req_id, result)


def main() -> int:
    args = parse_args()
    service = IdeaCoreService(data_dir=args.data_dir, contract_dir=args.contract_dir)

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("request must be a JSON object")
        except Exception:
            resp = _jsonrpc_error(None, -32700, "parse_error", {"reason": "parse_error"})
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            continue

        resp = handle_request(service, req)
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
