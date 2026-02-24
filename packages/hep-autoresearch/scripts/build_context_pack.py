#!/usr/bin/env python3

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT if SRC_ROOT.exists() else REPO_ROOT))

from hep_autoresearch.toolkit.context_pack import ContextPackInputs, build_context_pack  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a run context pack (human-readable MD + machine JSON).")
    parser.add_argument("--run-id", required=True, help="Run id/tag (artifacts/runs/<run-id>/context/...).")
    parser.add_argument("--workflow-id", help="Workflow id (optional, improves intent section).")
    parser.add_argument("--refkey", help="Optional RefKey for paper workflows.")
    parser.add_argument("--note", default="", help="Optional run note (free text).")
    args = parser.parse_args()

    repo_root = Path.cwd()
    res = build_context_pack(
        ContextPackInputs(
            run_id=str(args.run_id),
            workflow_id=str(args.workflow_id) if args.workflow_id else None,
            refkey=str(args.refkey) if args.refkey else None,
            note=str(args.note) if args.note else None,
        ),
        repo_root=repo_root,
    )
    print("[ok] wrote context pack:")
    print(f"- md: {res.get('context_md')}")
    print(f"- json: {res.get('context_json')}")
    missing = res.get("missing_required_files") or []
    if missing:
        print("[warn] missing required context files:")
        for p in missing:
            print(f"- {p}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

