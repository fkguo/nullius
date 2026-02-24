#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="Export hep-calc SSOT artifacts (manifest/summary/analysis) for an existing out_dir.")
    ap.add_argument("--out", required=True, help="out_dir produced by hep-calc (contains job.resolved.json).")
    ap.add_argument("--job", default=None, help="Path to job.resolved.json (default: <out_dir>/job.resolved.json).")
    args = ap.parse_args()

    out_dir = Path(args.out).expanduser().resolve()
    job_path = Path(args.job).expanduser().resolve() if args.job else (out_dir / "job.resolved.json")

    if not out_dir.is_dir():
        print(f"ERROR: out_dir not found: {out_dir}", file=sys.stderr)
        return 2
    if not job_path.is_file():
        print(f"ERROR: job.resolved.json not found: {job_path}", file=sys.stderr)
        return 2

    script_dir = Path(__file__).resolve().parent
    generate_report = script_dir / "generate_report.py"
    if not generate_report.is_file():
        print(f"ERROR: generate_report.py not found: {generate_report}", file=sys.stderr)
        return 2

    cmd = [sys.executable, str(generate_report), "--job", str(job_path), "--out", str(out_dir)]
    proc = subprocess.run(cmd, check=False)
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())

