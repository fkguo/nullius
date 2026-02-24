#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def _now_iso_z() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> int:
    ap = argparse.ArgumentParser(description="Derive ground-state energy E=omega/2 (natural units) for HO.")
    ap.add_argument("--omega", required=True, type=float, help="HO frequency (natural units)")
    ap.add_argument("--out", default="results/params.json", help="Output JSON path (relative to CWD unless absolute).")
    args = ap.parse_args()

    omega = float(args.omega)
    E0 = 0.5 * omega

    out_path = Path(str(args.out)).expanduser()
    if not out_path.is_absolute():
        out_path = (Path.cwd() / out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "schema_version": 1,
        "created_at": _now_iso_z(),
        "inputs": {"omega": omega},
        "results": {"omega": omega, "E0": E0},
    }
    out_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

