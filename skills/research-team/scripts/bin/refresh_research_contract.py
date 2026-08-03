#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def main() -> int:
    project_contracts_src = _repo_root() / "packages" / "project-contracts" / "src"
    if project_contracts_src.is_dir():
        sys.path.insert(0, str(project_contracts_src))
    from project_contracts.research_contract import propose_research_contract_block

    ap = argparse.ArgumentParser(
        description=(
            "Derive the notebook-sync block from research_notebook.md into a proposal "
            "file. research_contract.md is never modified."
        )
    )
    ap.add_argument("--root", type=Path, default=Path.cwd(), help="Project root.")
    ap.add_argument("--notebook", type=Path, default=None, help="Optional notebook path override.")
    ap.add_argument("--contract", type=Path, default=None, help="Optional contract path override.")
    ap.add_argument(
        "--project-policy",
        choices=("real_project", "maintainer_fixture"),
        default="real_project",
        help="Project root policy (`maintainer_fixture` is internal maintainer-only; public use should stay on `real_project`).",
    )
    ap.add_argument(
        "--proposal",
        type=Path,
        default=None,
        help="Where to write the derived block (default: artifacts/research_contract_block.proposed.md).",
    )
    args = ap.parse_args()

    result = propose_research_contract_block(
        repo_root=args.root.expanduser().resolve(),
        notebook_path=args.notebook.expanduser().resolve() if args.notebook else None,
        contract_path=args.contract.expanduser().resolve() if args.contract else None,
        proposal_path=args.proposal.expanduser().resolve() if args.proposal else None,
        project_policy=args.project_policy,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[error] {exc}", file=sys.stderr)
        raise SystemExit(1)
