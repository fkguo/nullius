#!/usr/bin/env python3
"""Mock engine bridge for submit_pack tests.

Invoked as [node_bin, idea_rpc] = [python3, mock_rpc.py]: reads the JSON
request from stdin, dumps it to the file named by MOCK_RPC_CAPTURE (so the
test can pin the exact request shape), and prints a canned JSON-RPC response.
Set MOCK_RPC_ERROR=1 to answer with an error instead.
"""

from __future__ import annotations

import json
import os
import sys


def main() -> int:
    request = json.loads(sys.stdin.read())
    capture = os.environ.get("MOCK_RPC_CAPTURE")
    if capture:
        with open(capture, "w", encoding="utf-8") as handle:
            json.dump(request, handle, indent=2, sort_keys=True)
    if os.environ.get("MOCK_RPC_ERROR") == "1":
        print(json.dumps({
            "error": {
                "code": -32002,
                "data": {"reason": "schema_invalid"},
                "message": "schema_validation_failed",
            },
            "id": None,
            "jsonrpc": "2.0",
        }))
        return 0
    params = request.get("params", {})
    pack = params.get("pack", {})
    print(json.dumps({
        "id": None,
        "jsonrpc": "2.0",
        "result": {
            "campaign_id": params.get("campaign_id"),
            "idempotency": {
                "idempotency_key": params.get("idempotency_key"),
                "is_replay": False,
                "payload_hash": "sha256:" + "0" * 64,
            },
            "imported": [
                {
                    "idea_id": "mockidea",
                    "node_id": "mocknode",
                    "operator_family": "LiteratureMining",
                    "operator_id": "litmine.tension_resolution.v1",
                },
            ],
            "imported_count": len(pack.get("candidates", [])),
            "pack_artifact_ref": "file:///mock/artifacts/generation/pack-mock.json",
            "pack_hash": "sha256:" + "1" * 64,
            "rejected_count": len(pack.get("rejected_candidates", [])),
        },
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
