#!/usr/bin/env python3
"""
AGENTS.md anchor gate.

Goal: reduce "workflow amnesia" after milestone switches / restarts.

This gate is intentionally simple and deterministic:
- Ensure an AGENTS.md exists at the project root (config dir if present).
- Optionally sanity-check it is non-empty.

Controlled by `features.agents_anchor_gate` in research_team_config.json.

Exit codes:
  0  ok, or gate disabled / not applicable
  1  fail-fast (missing/invalid AGENTS.md)
  2  input error
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

try:
    from team_config import load_team_config  # type: ignore
except Exception as exc:  # pragma: no cover - import-time failure
    print(f"ERROR: failed to import team_config: {exc}", file=sys.stderr)
    raise SystemExit(2)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (used to locate project root).")
    ap.add_argument("--min-chars", type=int, default=200, help="Minimum non-whitespace chars required in AGENTS.md (guardrail).")
    args = ap.parse_args()

    if not args.notes.exists():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    try:
        cfg = load_team_config(args.notes if args.notes.is_file() else Path.cwd())
    except Exception as exc:
        print(f"ERROR: failed to load research_team_config: {exc}")
        return 2
    if not cfg.feature_enabled("agents_anchor_gate", default=False):
        print("[skip] agents anchor gate disabled by research_team_config")
        return 0
    root = (cfg.path.parent if cfg.path is not None else (args.notes.parent if args.notes.is_file() else args.notes)).resolve()
    agents = root / "AGENTS.md"
    if not agents.is_file():
        print("[fail] agents anchor gate failed")
        print(f"[error] Missing `{agents}`")
        print("[fix] Re-run scaffold (no --force) or create AGENTS.md from the template, then re-run the team cycle.")
        print("      scaffold: bash ~/.codex/skills/research-team/scripts/bin/scaffold_research_workflow.sh --root <root> --project <name> --profile mixed")
        return 1

    txt = agents.read_text(encoding="utf-8", errors="replace")
    if len(txt.strip()) < args.min_chars:
        print("[fail] agents anchor gate failed")
        print(f"[error] `{agents}` is too short (min {args.min_chars} chars). Add the required workflow + trigger commands.")
        return 1

    # Minimal semantic anchor: file should mention the canonical notebook and at least one trigger command.
    required_all = ["research_contract.md"]
    required_any = ["run_team_cycle.sh", "run_autopilot.sh"]
    missing_all = [t for t in required_all if t not in txt]
    has_any = any(t in txt for t in required_any)
    if missing_all or not has_any:
        print("[fail] agents anchor gate failed")
        if missing_all:
            print(f"[error] `{agents}` is missing required token(s): {', '.join(missing_all)}")
        if not has_any:
            print(f"[error] `{agents}` must include at least one trigger command token: {', '.join(required_any)}")
        print("[fix] Add the resume checklist + team cycle trigger commands from the template.")
        return 1

    print("[ok] agents anchor gate passed")
    print(f"- root: {root}")
    print(f"- AGENTS.md: {agents}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
