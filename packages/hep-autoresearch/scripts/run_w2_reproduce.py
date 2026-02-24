#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT if SRC_ROOT.exists() else REPO_ROOT))

from hep_autoresearch.toolkit.w2_reproduce import ReproduceInputs, reproduce_one  # noqa: E402


def _parse_ns(text: str) -> tuple[int, ...]:
    items = []
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        items.append(int(part))
    return tuple(items)


def main() -> int:
    parser = argparse.ArgumentParser(description="W2 reproduce runner v0 (toy case first).")
    parser.add_argument("--tag", required=True, help="Run tag (artifacts/runs/<tag>/reproduce/...).")
    parser.add_argument("--case", default="toy", choices=["toy"], help="Reproduction case id (v0 supports only toy).")
    parser.add_argument(
        "--ns",
        default="0,1,2,5,10",
        help="Comma-separated n values for the toy gamma-integral case.",
    )
    parser.add_argument("--epsabs", type=float, default=1e-12, help="scipy.integrate.quad epsabs.")
    parser.add_argument("--epsrel", type=float, default=1e-12, help="scipy.integrate.quad epsrel.")
    parser.add_argument("--mpmath-dps", type=int, default=80, help="mpmath working precision (decimal digits).")
    args = parser.parse_args()

    repo_root = Path.cwd()
    ns = _parse_ns(args.ns)
    res = reproduce_one(
        ReproduceInputs(
            tag=args.tag,
            case=args.case,
            ns=ns,
            epsabs=float(args.epsabs),
            epsrel=float(args.epsrel),
            mpmath_dps=int(args.mpmath_dps),
        ),
        repo_root=repo_root,
    )
    artifact_paths = res.get("artifact_paths") or {}
    print("[ok] wrote artifacts:")
    for k in ["manifest", "summary", "analysis"]:
        v = artifact_paths.get(k)
        if v:
            print(f"- {k}: {v}")

    errors = res.get("errors") or []
    return 0 if not errors else 2


if __name__ == "__main__":
    raise SystemExit(main())
