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

The deterministic default has one sharp corner: a posterior identical to an
EARLIER write (say, restoring a node to a previous state after intervening
revisions) collides with that write's key, and the store replays the archived
response — no new revision is created. The script surfaces this through the
response's ``idempotency.is_replay`` flag instead of letting it pass as a
fresh write; when a fresh revision is the intent, ``--new-write`` mints a
unique key for the invocation.

Standard library only; the RPC caller is invoked as a subprocess.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path

REQUIRED_POSTERIOR_FIELDS = ("value", "evidence_count", "gaia_package_ref")

# The package reference must name the package as a file:// URI AND pin the
# compiled graph state via its IR hash: file://<abs path>#sha256:<hex>.
# Full-string match so a bare hash with no path is rejected.
# A bare absolute path is NOT accepted either: the
# idea-engine contract types gaia_package_ref as format "uri"
# (node.set_posterior / idea_node_v1), and the engine refuses bare paths —
# failing here gives the author a usable message instead of a remote
# schema_validation_failed.
REF_PIN_RE = re.compile(r"file:///\S+#sha256:[0-9a-fA-F]{16,}$")


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
    if ref.startswith("exploration-only:"):
        raise ValueError(
            "exploration-only posteriors (extracted over allowed "
            "discipline violations) are not writable to the idea store; "
            "fix the graph and re-extract"
        )
    if not REF_PIN_RE.fullmatch(ref):
        raise ValueError(
            "gaia_package_ref must pin the compiled graph as "
            f"file://<abs package path>#sha256:<hex>, got {ref!r}; a bare "
            "path is refused because the idea-engine contract types this "
            "field as a URI — re-extract with the current "
            "run_infer_and_extract.py, which emits the file:// form"
        )
    return {
        "value": float(value),
        "evidence_count": evidence_count,
        "gaia_package_ref": ref,
    }


def derive_idempotency_key(campaign_id: str, node_id: str, posterior: dict) -> str:
    """Deterministic key: same posterior write -> same key.

    The basis is a JSON array, an unambiguous encoding: no choice of
    delimiter characters inside the fields (newlines included) can make two
    different (campaign, node, posterior) triples collide. The value enters
    via ``repr``, the shortest round-trip representation of a Python float,
    so any two distinct float values produce distinct digests.
    """
    basis = json.dumps(
        [
            campaign_id,
            node_id,
            posterior["gaia_package_ref"],
            repr(posterior["value"]),
            posterior["evidence_count"],
        ],
        ensure_ascii=True,
        separators=(",", ":"),
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
    key_group = parser.add_mutually_exclusive_group()
    key_group.add_argument(
        "--idempotency-key",
        default=None,
        help="override the deterministic idempotency key",
    )
    key_group.add_argument(
        "--new-write",
        action="store_true",
        help="mint a unique idempotency key for this invocation, so the "
        "store records a fresh write even when an identical posterior was "
        "written before (the deterministic default would replay that "
        "earlier write instead). To retry THIS write after a failure, "
        "reuse the key printed on stderr via --idempotency-key rather "
        "than passing --new-write again",
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
    if args.new_write:
        # Keep the deterministic digest as prefix (auditable content family),
        # salt per invocation so the store treats it as a distinct write.
        key = f"{key}-fresh-{uuid.uuid4().hex[:12]}"
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

    # Emit the key BEFORE the write attempt: if the caller dies after the
    # store committed but before the response was read, this line is the
    # only record that allows retrying THAT write via --idempotency-key —
    # a --new-write salt is minted in-process and cannot be re-derived.
    sys.stderr.write(f"using idempotency key {key}\n")

    try:
        proc = subprocess.run(
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

    # Parse the envelope before judging the exit code: the real RPC caller
    # (bin/idea-rpc.mjs) prints the JSON-RPC error envelope on stdout AND
    # exits 1, so a store rejection must be reported as such (exit 1), not
    # as an infrastructure failure of the caller (exit 2).
    try:
        response = json.loads(proc.stdout)
    except json.JSONDecodeError:
        response = None
    if not isinstance(response, dict):
        response = None

    if response is not None and response.get("error") is not None:
        sys.stderr.write(
            "error: store rejected the write: "
            f"{json.dumps(response['error'])}\n"
        )
        return 1

    if proc.returncode != 0:
        sys.stderr.write(
            f"error: RPC caller exited {proc.returncode}.\n"
            f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}\n"
        )
        return 2

    if response is None:
        sys.stderr.write(
            "error: RPC caller did not return JSON on stdout.\n"
            f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}\n"
        )
        return 2

    print(json.dumps(response, indent=2, sort_keys=True))
    rpc_result = response.get("result") or {}
    idempotency = rpc_result.get("idempotency") or {}
    if idempotency.get("is_replay"):
        # Replay is correct for a retry of the same write, but silent replay
        # is a trap when the intent was a fresh write of content identical
        # to an earlier one (live-project regression, 2026-07): the store
        # returns the archived response and no new revision appears.
        sys.stderr.write(
            "WARNING: the store REPLAYED an earlier identical write "
            f"(idempotency key {key}); no new revision was created, and "
            "the node summary above shows the store state as of that "
            "earlier write. If you meant to re-assert this posterior as a "
            "fresh write on the current node, re-run with --new-write.\n"
        )
    else:
        sys.stderr.write(f"posterior written (idempotency key {key})\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
