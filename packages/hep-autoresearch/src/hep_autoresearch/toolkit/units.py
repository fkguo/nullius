from __future__ import annotations

import math
from typing import Any


def compute_hbarc_gev_fm() -> float:
    """Compute ħc in GeV·fm from exact SI definitions.

    Uses:
    - Planck constant h (J·s)
    - speed of light c (m/s)
    - elementary charge e (J/eV)
    and converts m→fm and eV→GeV.
    """
    h_j_s = 6.62607015e-34
    c_m_s = 299792458.0
    e_j_per_ev = 1.602176634e-19

    hbar_j_s = h_j_s / (2.0 * math.pi)
    hbarc_j_m = hbar_j_s * c_m_s
    return float(hbarc_j_m * 1.0e15 / (e_j_per_ev * 1.0e9))


def unit_system_si_derived() -> dict[str, Any]:
    hbarc_gev_fm = compute_hbarc_gev_fm()
    fm_to_gev_inv = float(1.0 / hbarc_gev_fm) if hbarc_gev_fm != 0.0 else None
    return {
        "hbarc_gev_fm": float(hbarc_gev_fm),
        "fm_to_gev_inv": fm_to_gev_inv,
        "gev_inv_to_fm": float(hbarc_gev_fm),
        "constants_si": {
            "h_j_s": 6.62607015e-34,
            "c_m_s": 299792458.0,
            "e_j_per_ev": 1.602176634e-19,
            "m_per_fm": 1.0e-15,
            "ev_per_gev": 1.0e9,
        },
    }

