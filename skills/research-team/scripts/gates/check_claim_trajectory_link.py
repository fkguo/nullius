#!/usr/bin/env python3
"""
Check that Claim DAG records link to known trajectory tags.

Spec:
- claims.jsonl may include: linked_trajectories: ["M2-r1", ...]
- team/trajectory_index.json contains run records with tag fields

This is a deterministic, fixable gate:
- If a claim links to a tag not present in trajectory_index.json, the gate fails.

Exit codes:
  0  PASS (or skipped by config)
  1  FAIL (missing links)
  2  Input / execution error
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import find_config_path, load_team_config  # type: ignore


@dataclass(frozen=True)
class Issue:
    path: Path
    line: int
    message: str


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--notes", type=Path, default=None, help="Notebook path (used to locate config and defaults).")
    p.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Project root (optional). If --notes is omitted, uses <root>/Draft_Derivation.md when present.",
    )
    p.add_argument("--claims", type=Path, default=None, help="Override claims.jsonl path.")
    p.add_argument("--team-dir", type=Path, default=None, help="Override team output dir (default: <notes_dir>/team).")
    p.add_argument(
        "--current-tag",
        type=str,
        default="",
        help="Optional. The current run tag is always allowed even if not present in trajectory_index.json yet.",
    )
    p.add_argument("--max-issues", type=int, default=80, help="Max issues to print.")
    return p.parse_args()


def _iter_jsonl(path: Path) -> list[tuple[int, dict]]:
    if not path.is_file():
        raise FileNotFoundError(str(path))
    out: list[tuple[int, dict]] = []
    for lineno, raw in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        obj = json.loads(line)
        if not isinstance(obj, dict):
            raise ValueError(f"{path}:{lineno}: expected JSON object")
        out.append((lineno, obj))
    return out


def _project_root(notes: Path) -> Path:
    cfg_path = None
    try:
        cfg_path = find_config_path(notes)
    except Exception:
        cfg_path = None
    if cfg_path is not None and cfg_path.is_file():
        return cfg_path.parent.resolve()
    return notes.parent.resolve()


def main() -> int:
    args = _parse_args()
    notes: Path | None = args.notes
    if notes is None:
        root = args.root or Path.cwd()
        candidate = root / "Draft_Derivation.md"
        if candidate.is_file():
            notes = candidate
            print(f"[info] --notes not provided; using {notes}", file=sys.stderr)
        else:
            print("ERROR: --notes is required unless <root>/Draft_Derivation.md exists.", file=sys.stderr)
            print("Fix: pass --notes <path> or --root <project_root>.", file=sys.stderr)
            return 2
    if not notes.is_file():
        print(f"ERROR: notes not found: {notes}", file=sys.stderr)
        return 2

    cfg = load_team_config(notes)
    if not cfg.feature_enabled("claim_trajectory_link_gate", default=False):
        print(f"- Notes: `{notes}`")
        print("- Gate: SKIP (claim_trajectory_link_gate disabled by research_team_config)")
        return 0

    project_root = _project_root(notes)
    base_dir = str(cfg.data.get("claim_graph", {}).get("base_dir", "knowledge_graph")).strip() or "knowledge_graph"
    claims_path = args.claims or (project_root / base_dir / "claims.jsonl")
    team_dir = args.team_dir or (project_root / "team")
    traj_path = team_dir / "trajectory_index.json"

    try:
        claims = _iter_jsonl(claims_path)
    except FileNotFoundError:
        print(f"ERROR: claims file not found: {claims_path}", file=sys.stderr)
        print("Fix: create it (e.g. run scaffold_claim_dag.sh) or disable claim_trajectory_link_gate.", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"ERROR: failed to read/parse claims file: {claims_path}", file=sys.stderr)
        print(f"  {e}", file=sys.stderr)
        return 2

    current_tag = (args.current_tag or "").strip()
    if not traj_path.is_file():
        # Only fail if there are any linked trajectories; otherwise allow an empty trajectory index.
        any_links = False
        for _, obj in claims:
            links = obj.get("linked_trajectories", [])
            if isinstance(links, list) and any(isinstance(x, str) and x.strip() for x in links):
                any_links = True
                break
        if any_links:
            # If all links are to the current run tag, allow it (preflight chicken-and-egg).
            if current_tag:
                only_current = True
                for _, obj in claims:
                    links = obj.get("linked_trajectories", [])
                    if not isinstance(links, list):
                        continue
                    for t in [x.strip() for x in links if isinstance(x, str) and x.strip()]:
                        if t != current_tag:
                            only_current = False
                            break
                    if not only_current:
                        break
                if only_current:
                    print(f"- Notes: `{notes}`")
                    print(f"- Claims: `{claims_path}` ({len(claims)} records)")
                    print(f"- Project root: `{project_root}`")
                    print(f"- Trajectory index: `{traj_path}` (missing; allowed because current-tag={current_tag!r})")
                    print("- Gate: PASS")
                    return 0
            print(f"ERROR: trajectory index not found: {traj_path}", file=sys.stderr)
            print(
                "Fix: run at least one team cycle to generate team/trajectory_index.json, or remove/adjust linked_trajectories.",
                file=sys.stderr,
            )
            return 2
        print(f"- Notes: `{notes}`")
        print(f"- Claims: `{claims_path}` ({len(claims)} records)")
        print(f"- Project root: `{project_root}`")
        print(f"- Trajectory index: `{traj_path}` (missing; not applicable)")
        print("- Gate: PASS (no linked_trajectories found)")
        return 0

    try:
        traj_obj = json.loads(traj_path.read_text(encoding="utf-8", errors="replace"))
    except Exception as e:
        print(f"ERROR: failed to parse trajectory index: {traj_path}", file=sys.stderr)
        print(f"  {e}", file=sys.stderr)
        return 2

    runs = traj_obj.get("runs", [])
    tags: set[str] = set()
    if isinstance(runs, list):
        for r in runs:
            if isinstance(r, dict):
                t = r.get("tag")
                if isinstance(t, str) and t.strip():
                    tags.add(t.strip())
    if current_tag:
        tags.add(current_tag)

    issues: list[Issue] = []
    for lineno, obj in claims:
        claim_id = obj.get("id", "<unknown>")
        links = obj.get("linked_trajectories", [])
        if links is None:
            continue
        if not isinstance(links, list) or not all(isinstance(x, str) for x in links):
            issues.append(Issue(claims_path, lineno, f"claim {claim_id!r}: linked_trajectories must be a list of strings"))
            continue
        for t in [x.strip() for x in links if x.strip()]:
            if t not in tags:
                issues.append(
                    Issue(
                        claims_path,
                        lineno,
                        f"claim {claim_id!r}: unknown linked trajectory tag {t!r} (not found in {traj_path.name})",
                    )
                )

    print(f"- Notes: `{notes}`")
    print(f"- Claims: `{claims_path}` ({len(claims)} records)")
    print(f"- Project root: `{project_root}`")
    print(f"- Trajectory index: `{traj_path}` (tags={len(tags)})")
    print(f"- Missing links: {len(issues)}")

    gate = "PASS" if not issues else "FAIL"
    print(f"- Gate: {gate}")

    shown = 0
    for it in issues:
        if shown >= args.max_issues:
            break
        print(f"ERROR: {it.path}:{it.line}: {it.message}")
        shown += 1
    if len(issues) > shown:
        print(f"... ({len(issues) - shown} more)")

    if issues:
        print("")
        print("Fix: update claims.jsonl linked_trajectories to existing tags, or run team cycles to generate missing tags.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
