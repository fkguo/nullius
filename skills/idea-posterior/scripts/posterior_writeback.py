#!/usr/bin/env python3
"""Write an extracted posterior back to the idea store via the thin RPC caller.

Contract (idea-engine ``bin/idea-rpc.mjs``): a single JSON object on stdin,

    {"method": "node.set_posterior",
     "params": {"campaign_id": ..., "node_id": ..., "idempotency_key": ...,
                "posterior": {"value": ..., "evidence_count": ...,
                              "gaia_package_ref": ...}},
     "store_root": ...}

and a JSON-RPC response on stdout; a non-null ``error`` member means the
write failed.

The idempotency key defaults to a deterministic digest of campaign, node,
package reference (which pins the compiled graph via its ir_hash), value, and
evidence count — re-running the same write is a no-op at the store, while any
change in the posterior produces a new key.

Standard library only; the RPC caller is invoked as a subprocess.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

REQUIRED_POSTERIOR_FIELDS = ("value", "evidence_count", "gaia_package_ref")

# The package reference must pin the compiled graph state via its IR hash.
REF_PIN_RE = re.compile(r"#sha256:[0-9a-fA-F]{16,}$")


def validate_posterior(posterior: dict) -> dict:
    """Keep exactly the contract fields; reject malformed values."""
    missing = [k for k in REQUIRED_POSTERIOR_FIELDS if k not in posterior]
    if missing:
        raise ValueError(f"posterior JSON missing fields: {missing}")
    value = posterior["value"]
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not 0.0 <= float(value) <= 1.0
    ):
        raise ValueError(f"posterior value must be in [0, 1], got {value!r}")
    evidence_count = posterior["evidence_count"]
    if (
        isinstance(evidence_count, bool)
        or not isinstance(evidence_count, int)
        or evidence_count < 0
    ):
        raise ValueError(
            f"evidence_count must be a non-negative integer, got "
            f"{evidence_count!r}"
        )
    ref = posterior["gaia_package_ref"]
    if not isinstance(ref, str) or not ref.strip():
        raise ValueError("gaia_package_ref must be a non-empty string")
    if not REF_PIN_RE.search(ref):
        raise ValueError(
            "gaia_package_ref must pin the compiled graph as "
            f"<package path>#sha256:<hex>, got {ref!r}; use the reference "
            "produced by run_infer_and_extract.py, which embeds the IR hash"
        )
    return {
        "value": float(value),
        "evidence_count": evidence_count,
        "gaia_package_ref": ref,
    }


def derive_idempotency_key(campaign_id: str, node_id: str, posterior: dict) -> str:
    """Deterministic key: same posterior write -> same key.

    The value enters via ``repr``, the shortest round-trip representation of
    a Python float: any two distinct float values produce distinct digests.
    """
    basis = "\n".join(
        [
            campaign_id,
            node_id,
            posterior["gaia_package_ref"],
            repr(posterior["value"]),
            str(posterior["evidence_count"]),
        ]
    )
    digest = hashlib.sha256(basis.encode("utf-8")).hexdigest()[:32]
    return f"idea-posterior-{digest}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--posterior-json",
        default="-",
        help="file with the extracted posterior JSON, or - for stdin "
        "(default: -; pipe run_infer_and_extract.py output straight in)",
    )
    parser.add_argument("--campaign-id", required=True)
    parser.add_argument("--node-id", required=True)
    parser.add_argument(
        "--store-root", required=True, help="idea store root directory"
    )
    parser.add_argument(
        "--idea-rpc",
        required=True,
        help="path to the idea-engine RPC caller "
        "(packages/idea-engine/bin/idea-rpc.mjs)",
    )
    parser.add_argument(
        "--runner",
        default="node",
        help="interpreter for the RPC caller (default: node)",
    )
    parser.add_argument(
        "--idempotency-key",
        default=None,
        help="override the deterministic idempotency key",
    )
    args = parser.parse_args(argv)

    if args.posterior_json == "-":
        raw = sys.stdin.read()
        source = "stdin"
    else:
        path = Path(args.posterior_json)
        if not path.is_file():
            sys.stderr.write(f"error: posterior JSON not found: {path}\n")
            return 2
        raw = path.read_text(encoding="utf-8")
        source = str(path)

    try:
        posterior = validate_posterior(json.loads(raw))
    except (json.JSONDecodeError, ValueError) as exc:
        sys.stderr.write(f"error: invalid posterior JSON from {source}: {exc}\n")
        return 2

    rpc_path = Path(args.idea_rpc)
    if not rpc_path.is_file():
        sys.stderr.write(
            f"error: RPC caller not found: {rpc_path}\n"
            "Point --idea-rpc at the idea-engine thin RPC caller "
            "(packages/idea-engine/bin/idea-rpc.mjs).\n"
        )
        return 2

    key = args.idempotency_key or derive_idempotency_key(
        args.campaign_id, args.node_id, posterior
    )
    request = {
        "method": "node.set_posterior",
        "params": {
            "campaign_id": args.campaign_id,
            "node_id": args.node_id,
            "idempotency_key": key,
            "posterior": posterior,
        },
        "store_root": args.store_root,
    }

    try:
        result = subprocess.run(
            [args.runner, str(rpc_path)],
            input=json.dumps(request),
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        sys.stderr.write(f"error: could not run the RPC caller: {exc}\n")
        return 2

    if result.returncode != 0:
        sys.stderr.write(
            f"error: RPC caller exited {result.returncode}.\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}\n"
        )
        return 2

    try:
        response = json.loads(result.stdout)
    except json.JSONDecodeError:
        sys.stderr.write(
            "error: RPC caller did not return JSON on stdout.\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}\n"
        )
        return 2

    if response.get("error") is not None:
        sys.stderr.write(
            "error: store rejected the write: "
            f"{json.dumps(response['error'])}\n"
        )
        return 1

    print(json.dumps(response, indent=2, sort_keys=True))
    sys.stderr.write(f"posterior written (idempotency key {key})\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
