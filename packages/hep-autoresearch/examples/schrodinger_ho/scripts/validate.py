#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now_iso_z() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("JSON must be an object")
    return payload


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate numeric HO wavefunction vs analytic psi(x)=exp(-omega x^2/2) with psi(0)=1.")
    ap.add_argument("--wavefunction", required=True, help="Path to wavefunction.json (from solve_numerics phase).")
    ap.add_argument("--params", required=True, help="Path to params.json (from derive_params phase).")
    ap.add_argument("--out", default="results/validation_report.json", help="Output JSON path")
    args = ap.parse_args()

    wf_path = Path(str(args.wavefunction)).expanduser().resolve()
    params_path = Path(str(args.params)).expanduser().resolve()
    wf = _read_json(wf_path)
    params = _read_json(params_path)

    xs = wf.get("grid", {}).get("x") if isinstance(wf.get("grid"), dict) else None
    psis = wf.get("psi")
    if not (isinstance(xs, list) and isinstance(psis, list) and len(xs) == len(psis) and len(xs) >= 5):
        raise ValueError("invalid wavefunction.json structure")

    omega = float(((params.get("results") or {}).get("omega")) if isinstance(params.get("results"), dict) else params.get("omega"))

    diffs2 = 0.0
    max_abs = 0.0
    for x, psi in zip(xs, psis):
        xa = float(x)
        pa = float(psi)
        p_ref = math.exp(-0.5 * omega * xa * xa)
        d = pa - p_ref
        diffs2 += d * d
        max_abs = max(max_abs, abs(d))

    rmse = math.sqrt(diffs2 / float(len(xs)))
    psi0_abs_err = abs(float(psis[0]) - 1.0)

    out_path = Path(str(args.out)).expanduser()
    if not out_path.is_absolute():
        out_path = (Path.cwd() / out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    rep = {
        "schema_version": 1,
        "created_at": _now_iso_z(),
        "inputs": {"omega": omega, "n_grid": len(xs), "x_max": float(xs[-1])},
        "rmse": float(rmse),
        "max_abs_diff": float(max_abs),
        "psi0_abs_err": float(psi0_abs_err),
        "psi_at_x_max": float(psis[-1])
    }
    out_path.write_text(json.dumps(rep, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

