#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def assessor_capacity_flags(data: dict) -> list[str]:
    """Forward configured whole-request budgets; never infer provider capacity."""
    from request_capacity import request_budgets
    block = data.get("independent_reproduction", {})
    if not isinstance(block, dict):
        raise ValueError("independent_reproduction must be an object")
    tokens = block.get("assessor_context_tokens", 200000)
    byte_budget = block.get("assessor_context_bytes", None)
    request_budgets(tokens, byte_budget)
    timeout = block.get("assessor_timeout_secs", 0)
    if type(timeout) is not int or timeout < 0:
        raise ValueError("assessor_timeout_secs must be a nonnegative integer (0 means no hard deadline)")
    flags = ["--assessor-context-tokens", str(tokens), "--assessor-timeout-secs", str(timeout)]
    if byte_budget is not None:
        flags.extend(["--assessor-context-bytes", str(byte_budget)])
    return flags


def main() -> int:
    ap = argparse.ArgumentParser(description="Print effective review_access_mode, isolation_strategy, and workflow_mode from config.")
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (or equivalent).")
    ap.add_argument("--assessor-capacity", action="store_true", help="Print exact assessor capacity argv, one argument per line; invalid configuration exits 2.")
    args = ap.parse_args()

    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
        from team_config import load_strict_team_config  # type: ignore
        cfg = load_strict_team_config(args.notes)
        if args.assessor_capacity:
            print("\n".join(assessor_capacity_flags(cfg.data)))
            return 0
        mode = str(cfg.data.get("review_access_mode", "packet_only")).strip().lower()
        if mode not in ("full_access", "packet_only"):
            mode = "packet_only"
        strat = str(cfg.data.get("isolation_strategy", "separate_worktrees")).strip().lower()
        if strat not in ("separate_worktrees", "sequential_with_acl"):
            strat = "separate_worktrees"
        wf = str(cfg.data.get("workflow_mode", "")).strip().lower()
        if wf not in ("peer", "leader", "asymmetric"):
            wf = ""  # empty = not set in config, shell script uses its own default
        print(f"{mode} {strat} {wf}")
        return 0
    except Exception as error:
        label = "assessor capacity configuration" if args.assessor_capacity else "review configuration"
        print(f"unavailable {label}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
