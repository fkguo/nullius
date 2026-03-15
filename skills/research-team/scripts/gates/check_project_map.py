#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore


def _find_project_root(seed: Path) -> Path:
    cur = seed.resolve()
    if cur.is_file():
        cur = cur.parent
    for _ in range(10):
        if (cur / "project_charter.md").is_file() and (cur / "research_contract.md").is_file():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return seed.parent.resolve() if seed.is_file() else seed.resolve()


def main() -> int:
    ap = argparse.ArgumentParser(description="Gate: require a canonical project_index.md navigation entrypoint.")
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (or any file under project root).")
    args = ap.parse_args()

    if not args.notes.exists():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("project_map_gate", default=True):
        print("[skip] project map gate disabled by research_team_config")
        return 0

    root = _find_project_root(args.notes)
    path = root / "project_index.md"
    if not path.is_file():
        print(f"ERROR: missing project_index.md at project root: {path}")
        print("Fix: run the scaffold or generate one deterministically:")
        print(f"  python3 ~/.codex/skills/research-team/scripts/bin/update_project_map.py --notes {args.notes} --team-dir team")
        return 1

    text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")

    required_links = [
        (r"\[project_charter\.md\]\(project_charter\.md\)", "project_charter.md link"),
        (r"\[research_plan\.md\]\(research_plan\.md\)", "research_plan.md link"),
        (r"\[research_preflight\.md\]\(research_preflight\.md\)", "research_preflight.md link"),
        (r"\[research_contract\.md\]\(research_contract\.md\)", "research_contract.md link"),
        (r"\[team/LATEST\.md\]\(team/LATEST\.md\)", "team/LATEST.md pointer link"),
        (r"\[artifacts/LATEST\.md\]\(artifacts/LATEST\.md\)", "artifacts/LATEST.md pointer link"),
    ]

    missing: list[str] = []
    for pat, label in required_links:
        if not re.search(pat, text):
            missing.append(label)

    if missing:
        print(f"ERROR: project_index.md missing required link(s): {', '.join(missing)}")
        return 1

    print("[ok] project map gate passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
