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
        raise ValueError("params JSON must be an object")
    return payload


def _rhs(*, x: float, y: tuple[float, float], omega: float, E: float) -> tuple[float, float]:
    psi, phi = y  # phi = dpsi/dx
    dpsi = phi
    dphi = (omega * omega * x * x - 2.0 * E) * psi
    return dpsi, dphi


def _rk4_step(*, x: float, y: tuple[float, float], h: float, omega: float, E: float) -> tuple[float, float]:
    k1 = _rhs(x=x, y=y, omega=omega, E=E)
    k2 = _rhs(x=x + 0.5 * h, y=(y[0] + 0.5 * h * k1[0], y[1] + 0.5 * h * k1[1]), omega=omega, E=E)
    k3 = _rhs(x=x + 0.5 * h, y=(y[0] + 0.5 * h * k2[0], y[1] + 0.5 * h * k2[1]), omega=omega, E=E)
    k4 = _rhs(x=x + h, y=(y[0] + h * k3[0], y[1] + h * k3[1]), omega=omega, E=E)
    psi = y[0] + (h / 6.0) * (k1[0] + 2.0 * k2[0] + 2.0 * k3[0] + k4[0])
    phi = y[1] + (h / 6.0) * (k1[1] + 2.0 * k2[1] + 2.0 * k3[1] + k4[1])
    return psi, phi


def main() -> int:
    ap = argparse.ArgumentParser(description="Deterministic RK4 integrator for the HO Schrodinger ODE on x in [0, x_max].")
    ap.add_argument("--params", required=True, help="Path to params.json (from derive_params phase).")
    ap.add_argument("--x-max", required=True, type=float, help="Max x for integration")
    ap.add_argument("--n-grid", required=True, type=int, help="Grid points on [0, x_max]")
    ap.add_argument("--out-wavefunction", default="results/wavefunction.json", help="Output wavefunction JSON path")
    ap.add_argument("--out-report", default="results/numerics_report.json", help="Output numerics report JSON path")
    args = ap.parse_args()

    params_path = Path(str(args.params)).expanduser().resolve()
    params = _read_json(params_path)
    omega = float(((params.get("results") or {}).get("omega")) if isinstance(params.get("results"), dict) else params.get("omega"))
    E0 = float(((params.get("results") or {}).get("E0")) if isinstance(params.get("results"), dict) else params.get("E0"))

    x_max = float(args.x_max)
    n = int(args.n_grid)
    if n < 5:
        raise ValueError("--n-grid must be >= 5")
    if x_max <= 0:
        raise ValueError("--x-max must be > 0")

    h = x_max / float(n - 1)
    xs = [i * h for i in range(n)]

    psi = 1.0
    phi = 0.0
    psis = [psi]
    phis = [phi]
    for i in range(1, n):
        x = xs[i - 1]
        psi, phi = _rk4_step(x=x, y=(psi, phi), h=h, omega=omega, E=E0)
        psis.append(float(psi))
        phis.append(float(phi))

    out_wave = Path(str(args.out_wavefunction)).expanduser()
    if not out_wave.is_absolute():
        out_wave = (Path.cwd() / out_wave).resolve()
    out_wave.parent.mkdir(parents=True, exist_ok=True)

    out_rep = Path(str(args.out_report)).expanduser()
    if not out_rep.is_absolute():
        out_rep = (Path.cwd() / out_rep).resolve()
    out_rep.parent.mkdir(parents=True, exist_ok=True)

    wf = {
        "schema_version": 1,
        "created_at": _now_iso_z(),
        "inputs": {"x_max": x_max, "n_grid": n, "h": h},
        "grid": {"x": xs},
        "psi": psis,
        "phi": phis
    }
    out_wave.write_text(json.dumps(wf, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    rep = {
        "schema_version": 1,
        "created_at": _now_iso_z(),
        "inputs": {"omega": omega, "E0": E0, "x_max": x_max, "n_grid": n, "h": h},
        "results": {
            "psi0": float(psis[0]),
            "psi_at_x_max": float(psis[-1]),
            "psi_max_abs": float(max(abs(v) for v in psis)),
            "phi_max_abs": float(max(abs(v) for v in phis)),
            "stable": int(math.isfinite(psis[-1]) and math.isfinite(phis[-1]))
        }
    }
    out_rep.write_text(json.dumps(rep, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

