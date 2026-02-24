#!/usr/bin/env python3
"""
Independent reproduction gate for full_access team-cycle runs.

Requirement (per member):
  - evidence.outputs_produced must contain at least one file under:
      artifacts/<tag>/<member_id>/independent/
    (excluding script files like .py/.jl/.sh)
  - that file must exist on disk

Exit codes:
  0  PASS (or SKIP)
  1  FAIL (missing independent reproduction artifact)
  2  Input / execution error
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore


@dataclass(frozen=True)
class Issue:
    member: str
    message: str


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--notes", type=Path, required=True, help="Notebook path (used to locate config and project root).")
    p.add_argument("--tag", required=True, help="Resolved tag (e.g. M2-r3).")
    p.add_argument("--member-a", type=Path, required=True, help="Member A evidence JSON path.")
    p.add_argument("--member-b", type=Path, required=True, help="Member B evidence JSON path.")
    p.add_argument("--project-root", type=Path, default=None, help="Override project root (default: config dir or notes dir).")
    return p.parse_args()


def _safe_tag(tag: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", tag.strip())


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8", errors="replace"))


def _project_root(notes: Path) -> Path:
    cfg = load_team_config(notes)
    cfg_path = getattr(cfg, "path", None)
    if isinstance(cfg_path, Path) and cfg_path.is_file():
        return cfg_path.parent.resolve()
    return notes.parent.resolve()


def _find_independent_outputs(ev: dict, prefix: str) -> list[str]:
    outs = ev.get("outputs_produced", [])
    if not isinstance(outs, list):
        return []
    found: list[str] = []
    for it in outs:
        if not isinstance(it, dict):
            continue
        p = str(it.get("path", "")).strip().replace("\\", "/")
        if not p.startswith(prefix):
            continue
        if p.lower().endswith((".py", ".jl", ".sh")):
            continue
        found.append(p)
    return found


def main() -> int:
    args = _parse_args()
    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}", file=sys.stderr)
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("independent_reproduction_gate", default=False):
        print(f"- Notes: `{args.notes}`")
        print("- Gate: SKIP (independent_reproduction_gate disabled by config)")
        return 0

    mode = str(getattr(cfg, "data", {}).get("review_access_mode", "packet_only")).strip().lower()
    if mode != "full_access":
        print(f"- Notes: `{args.notes}`")
        print(f"- Review access mode: {mode or 'packet_only'}")
        print("- Gate: SKIP (review_access_mode != full_access)")
        return 0

    if not args.member_a.is_file() or not args.member_b.is_file():
        print("ERROR: missing member evidence file(s)", file=sys.stderr)
        return 2

    project_root = args.project_root.resolve() if args.project_root is not None else _project_root(args.notes)
    tag = args.tag.strip()
    st = _safe_tag(tag)

    ev_a = _load(args.member_a)
    ev_b = _load(args.member_b)

    issues: list[Issue] = []
    for member, ev in (("member_a", ev_a), ("member_b", ev_b)):
        prefix = f"artifacts/{st}/{member}/independent/"
        outputs = _find_independent_outputs(ev, prefix)
        if not outputs:
            issues.append(Issue(member, f"no outputs_produced under {prefix!r} (excluding scripts)"))
            continue
        missing = []
        for p in outputs[:10]:
            abs_p = (project_root / p).resolve() if not Path(p).is_absolute() else Path(p).resolve()
            if not abs_p.exists():
                missing.append(p)
        if missing:
            issues.append(Issue(member, f"independent outputs missing on disk: {missing[:5]!r}"))

    print(f"- Notes: `{args.notes}`")
    print(f"- Project root: `{project_root}`")
    print(f"- Tag: {tag} (safe={st})")
    print(f"- Member A evidence: `{args.member_a}`")
    print(f"- Member B evidence: `{args.member_b}`")
    print(f"- Issues: {len(issues)}")
    if issues:
        for it in issues:
            print(f"ERROR: {it.member}: {it.message}")
        print("- Gate: FAIL")
        return 1
    print("- Gate: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

