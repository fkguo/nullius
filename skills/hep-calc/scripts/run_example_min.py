#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path


_MIN_JOB_YAML = """\
schema_version: 1
name: example-min-skeleton
description: "Minimal hep-calc example: compute-only skeleton (no Mathematica entry, no auto_qft, no TeX targets)."

latex:
  targets: []

numeric:
  enable: false
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="Run the lightest hep-calc example job and write SSOT artifacts into out_dir.")
    ap.add_argument("--out-dir", required=True, help="Output directory to write (will be created/overwritten).")
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    runner = repo_root / "scripts" / "run_hep_calc.sh"
    if not runner.is_file():
        print(f"ERROR: run_hep_calc.sh not found: {runner}", file=sys.stderr)
        return 2

    out_dir = Path(args.out_dir).expanduser().resolve()

    with tempfile.NamedTemporaryFile("w", suffix=".yml", delete=False, encoding="utf-8") as f:
        f.write(_MIN_JOB_YAML)
        job_path = Path(f.name)

    cmd = ["bash", str(runner), "--job", str(job_path), "--out", str(out_dir)]
    proc = subprocess.run(cmd, cwd=str(repo_root), check=False)
    if proc.returncode != 0:
        return proc.returncode

    for required in ("manifest.json", "summary.json", "analysis.json"):
        p = out_dir / required
        if not p.is_file():
            print(f"ERROR: missing artifact: {p}", file=sys.stderr)
            return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

