#!/usr/bin/env python3
"""Submit a generation_pack_v1 to the idea engine (node.import_generated).

Sends {"method": "node.import_generated", "params": {campaign_id, pack,
idempotency_key}, "store_root": ..., "project_root": optional ...} on stdin to
the engine's thin RPC bridge (packages/idea-engine/bin/idea-rpc.mjs) and fails
loudly on an error response.

The idempotency key defaults to a deterministic digest of the campaign id and
the pack content: retrying the same submission is a no-op replay, while any
content change produces a new key (the engine additionally rejects key reuse
with a different payload). Python >= 3.9, standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

METHOD = "node.import_generated"


def deterministic_idempotency_key(campaign_id: str, pack: Dict[str, Any]) -> str:
    canonical = json.dumps(pack, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = hashlib.sha256(f"{campaign_id}|{canonical}".encode("utf-8")).hexdigest()
    return f"genpack-{digest}"


def build_request(
    campaign_id: str,
    pack: Dict[str, Any],
    store_root: str,
    idempotency_key: str,
    project_root: Optional[str] = None,
) -> Dict[str, Any]:
    request = {
        "method": METHOD,
        "params": {
            "campaign_id": campaign_id,
            "idempotency_key": idempotency_key,
            "pack": pack,
        },
        "store_root": store_root,
    }
    if project_root is not None:
        request["project_root"] = project_root
    return request


def run(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", required=True, help="Pack JSON from build_pack.py")
    parser.add_argument("--campaign-id", required=True, help="Must equal pack.campaign_id")
    parser.add_argument("--store-root", required=True, help="Campaign store root directory")
    parser.add_argument("--project-root", help="Project root for project:// refs (default: engine inference from --store-root)")
    parser.add_argument("--idea-rpc", required=True, help="Path to packages/idea-engine/bin/idea-rpc.mjs")
    parser.add_argument("--node-bin", default="node", help="Node.js executable (default: node)")
    parser.add_argument("--idempotency-key", help="Override the deterministic default key")
    parser.add_argument("--dry-run", action="store_true", help="Print the request without calling the engine")
    args = parser.parse_args(argv)

    try:
        pack = json.loads(Path(args.pack).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot load pack: {exc}", file=sys.stderr)
        return 2
    if not isinstance(pack, dict):
        print("error: pack is not a JSON object", file=sys.stderr)
        return 2
    if pack.get("campaign_id") != args.campaign_id:
        print(
            f"error: pack.campaign_id {pack.get('campaign_id')!r} does not match --campaign-id {args.campaign_id!r}",
            file=sys.stderr,
        )
        return 2

    key = args.idempotency_key or deterministic_idempotency_key(args.campaign_id, pack)
    request = build_request(args.campaign_id, pack, args.store_root, key, args.project_root)

    if args.dry_run:
        print(json.dumps(request, indent=2, sort_keys=True))
        return 0

    try:
        completed = subprocess.run(
            [args.node_bin, args.idea_rpc],
            capture_output=True,
            check=False,
            input=json.dumps(request).encode("utf-8"),
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"error: engine bridge failed to run: {exc}", file=sys.stderr)
        return 2

    stdout = completed.stdout.decode("utf-8", errors="replace").strip()
    if completed.returncode != 0 and not stdout:
        print(f"error: engine bridge exited {completed.returncode}: {completed.stderr.decode('utf-8', errors='replace')}", file=sys.stderr)
        return 2
    try:
        response = json.loads(stdout.splitlines()[-1])
    except (json.JSONDecodeError, IndexError) as exc:
        print(f"error: engine bridge returned non-JSON output: {exc}\n{stdout}", file=sys.stderr)
        return 2

    if "error" in response and response["error"]:
        print(json.dumps(response["error"], indent=2, sort_keys=True), file=sys.stderr)
        return 1

    result = response.get("result", {})
    print(json.dumps({
        "campaign_id": result.get("campaign_id"),
        "idempotency_key": key,
        "imported": result.get("imported"),
        "imported_count": result.get("imported_count"),
        "is_replay": (result.get("idempotency") or {}).get("is_replay"),
        "pack_artifact_ref": result.get("pack_artifact_ref"),
        "rejected_count": result.get("rejected_count"),
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(run())
