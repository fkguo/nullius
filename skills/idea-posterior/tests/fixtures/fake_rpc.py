#!/usr/bin/env python3
"""Stand-in for the idea-engine thin RPC caller, used by writeback tests.

Reads one JSON request from stdin. With FAKE_RPC_FAIL=1 it returns an error
response and exits 1, mirroring the real caller's behavior on error
envelopes. With FAKE_RPC_CRASH=1 it prints non-JSON and exits 3 (an
infrastructure failure, as opposed to a store rejection). With
FAKE_RPC_REPLAY=1 the result carries idempotency metadata marking the
response as a duplicate hit (``is_replay: true``), mirroring the engine's
idempotency_meta_v1. Otherwise it validates the request shape against the
node.set_posterior contract and echoes the request back inside the result.
"""

import json
import os
import sys


def respond(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def main() -> int:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        respond({"jsonrpc": "2.0", "id": 1,
                 "error": {"code": -32700, "message": f"parse error: {exc}"}})
        return 0

    if os.environ.get("FAKE_RPC_CRASH") == "1":
        sys.stdout.write("not json at all")
        sys.stdout.flush()
        return 3

    if os.environ.get("FAKE_RPC_FAIL") == "1":
        respond({"jsonrpc": "2.0", "id": 1,
                 "error": {"code": -32000, "message": "store rejected write"}})
        # The real caller (bin/idea-rpc.mjs) exits 1 when the response has
        # an error member; mirror that so tests exercise the real shape.
        return 1

    problems = []
    if request.get("method") != "node.set_posterior":
        problems.append("method != node.set_posterior")
    if not request.get("store_root"):
        problems.append("missing store_root")
    params = request.get("params") or {}
    for key in ("campaign_id", "node_id", "idempotency_key", "posterior"):
        if not params.get(key):
            problems.append(f"missing params.{key}")
    posterior = params.get("posterior") or {}
    for key in ("value", "evidence_count", "gaia_package_ref"):
        if key not in posterior:
            problems.append(f"missing posterior.{key}")

    if problems:
        respond({"jsonrpc": "2.0", "id": 1,
                 "error": {"code": -32602, "message": "; ".join(problems)}})
        return 0

    result = {"ok": True, "echo": request}
    if os.environ.get("FAKE_RPC_REPLAY") == "1":
        result["idempotency"] = {
            "idempotency_key": params["idempotency_key"],
            "is_replay": True,
            "payload_hash": "sha256:" + "0" * 64,
        }
    respond({"jsonrpc": "2.0", "id": 1, "result": result})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
