#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


VALID_EFFORTS = {"low", "medium", "high", "xhigh"}


def _runner_kind(value: object, default: str, allowed: set[str]) -> str:
    kind = str(value or default).strip().lower() or default
    if kind == "subagent":
        kind = "host_native"
    if kind not in allowed:
        kind = default
    return kind


def _auto_reasoning_effort(cfg: dict) -> str:
    project_stage = str(cfg.get("project_stage", "")).strip().lower()
    workflow_mode = str(cfg.get("workflow_mode", "")).strip().lower()
    profile = str(cfg.get("profile", "")).strip().lower()
    mode = str(cfg.get("mode", "")).strip().lower()

    if project_stage == "exploration" or profile == "literature_review" or mode == "literature_review":
        return "medium"
    if project_stage == "publication" or workflow_mode in {"leader", "asymmetric"}:
        return "high"
    if profile in {"mixed", "numerics_only", "methodology_dev", "toolkit_extraction"}:
        return "high"
    return "medium"


def _reasoning_effort(member_cfg: dict, cfg: dict) -> str:
    raw = str(member_cfg.get("reasoning_effort", "auto")).strip().lower() or "auto"
    if raw in VALID_EFFORTS:
        return raw
    return _auto_reasoning_effort(cfg)


def main() -> int:
    ap = argparse.ArgumentParser(description="Print effective Member A/B runner settings from research_team_config.json.")
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (or equivalent).")
    args = ap.parse_args()

    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
        from team_config import load_team_config  # type: ignore

        cfg = load_team_config(args.notes)
        data = cfg.data if isinstance(cfg.data, dict) else {}
        ma = data.get("member_a", {})
        mb = data.get("member_b", {})
        if not isinstance(ma, dict):
            ma = {}
        if not isinstance(mb, dict):
            mb = {}
        member_a_kind = _runner_kind(ma.get("runner_kind"), "host_native", {"host_native", "codex", "claude", "auto"})
        member_b_kind = _runner_kind(mb.get("runner_kind"), "host_native", {"host_native", "codex", "gemini", "claude", "auto"})
        claude_system = str(mb.get("claude_system_prompt", "")).strip()
        member_a_effort = _reasoning_effort(ma, data)
        member_b_effort = _reasoning_effort(mb, data)
        # Tab-separated so downstream can safely parse empty values.
        print(f"{member_a_kind}\t{member_b_kind}\t{claude_system}\t{member_a_effort}\t{member_b_effort}")
        return 0
    except Exception:
        print("host_native\thost_native\t\thigh\thigh")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
