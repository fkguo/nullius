#!/usr/bin/env python3
"""
Check the Evidence manifest (knowledge_graph/evidence_manifest.jsonl).

This is a deterministic, fixable gate:
- Validates JSONL structure and required fields
- Optionally checks that referenced local paths exist

Exit codes:
  0  PASS (or skipped by config)
  1  FAIL (schema/consistency violations)
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

from team_config import find_config_path, load_team_config  # type: ignore


_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


@dataclass(frozen=True)
class Issue:
    level: str  # ERROR/WARN
    path: Path
    line: int
    message: str


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--notes", type=Path, required=True, help="Notebook path (used to locate config and project root).")
    p.add_argument("--manifest", type=Path, default=None, help="Override evidence_manifest.jsonl path.")
    p.add_argument(
        "--require-paths-exist",
        action="store_true",
        help="If set: missing local evidence paths are treated as errors (otherwise warnings).",
    )
    p.add_argument("--max-issues", type=int, default=50, help="Max issues to print.")
    return p.parse_args()


def _is_remote_ref(path_s: str) -> bool:
    lower = path_s.strip().lower()
    return (
        "://" in lower
        or lower.startswith("doi:")
        or lower.startswith("arxiv:")
        or lower.startswith("isbn:")
        or lower.startswith("pmid:")
        or lower.startswith("urn:")
    )


def _iter_jsonl(path: Path) -> list[tuple[int, dict]]:
    if not path.is_file():
        raise FileNotFoundError(str(path))
    records: list[tuple[int, dict]] = []
    for lineno, raw in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception as e:
            raise ValueError(f"{path}:{lineno}: invalid JSON ({e})") from e
        if not isinstance(obj, dict):
            raise ValueError(f"{path}:{lineno}: expected JSON object, got {type(obj).__name__}")
        records.append((lineno, obj))
    return records


def _resolve_path(project_root: Path, notes: Path, path_s: str) -> Path:
    p = Path(path_s)
    if p.is_absolute():
        return p
    cand = notes.parent / p
    if cand.exists():
        return cand
    return project_root / p


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
    notes: Path = args.notes
    if not notes.is_file():
        print(f"ERROR: notes not found: {notes}", file=sys.stderr)
        return 2

    cfg = load_team_config(notes)
    if not cfg.feature_enabled("evidence_manifest_gate", default=False):
        print(f"- Notes: `{notes}`")
        print("- Gate: SKIP (evidence_manifest_gate disabled by research_team_config)")
        return 0

    project_root = _project_root(notes)
    base_dir = str(cfg.data.get("claim_graph", {}).get("base_dir", "knowledge_graph")).strip() or "knowledge_graph"
    manifest_path = args.manifest or (project_root / base_dir / "evidence_manifest.jsonl")

    try:
        records = _iter_jsonl(manifest_path)
    except FileNotFoundError:
        print(f"ERROR: evidence manifest not found: {manifest_path}", file=sys.stderr)
        print("Fix: create it (e.g. run scaffold_claim_dag.sh) or disable evidence_manifest_gate.", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"ERROR: failed to read/parse: {manifest_path}", file=sys.stderr)
        print(f"  {e}", file=sys.stderr)
        return 2

    issues: list[Issue] = []
    seen_ids: dict[str, int] = {}

    # Project root is used only for optional path existence checks.

    for lineno, obj in records:
        ev_id = obj.get("id")
        if not isinstance(ev_id, str) or not ev_id.strip():
            issues.append(Issue("ERROR", manifest_path, lineno, "missing required string field: id"))
            continue
        if not _ID_RE.match(ev_id.strip()):
            issues.append(Issue("ERROR", manifest_path, lineno, f"invalid id: {ev_id!r} (use [A-Za-z0-9._-])"))
        if ev_id in seen_ids:
            issues.append(
                Issue("ERROR", manifest_path, lineno, f"duplicate id: {ev_id!r} (first at line {seen_ids[ev_id]})")
            )
        else:
            seen_ids[ev_id] = lineno

        ev_type = obj.get("type")
        if not isinstance(ev_type, str) or not ev_type.strip():
            issues.append(Issue("ERROR", manifest_path, lineno, "missing required string field: type"))

        paths_val = obj.get("path", obj.get("paths"))
        paths: list[str] = []
        if isinstance(paths_val, str) and paths_val.strip():
            paths = [paths_val.strip()]
        elif isinstance(paths_val, list) and all(isinstance(x, str) and x.strip() for x in paths_val):
            paths = [str(x).strip() for x in paths_val]
        else:
            issues.append(Issue("ERROR", manifest_path, lineno, "missing required evidence path(s): use 'path' or 'paths'"))
            continue

        if args.require_paths_exist:
            for p in paths:
                if _is_remote_ref(p):
                    continue
                resolved = _resolve_path(project_root, notes, p)
                if not resolved.exists():
                    issues.append(Issue("ERROR", manifest_path, lineno, f"evidence path not found: {p!r} (resolved: {resolved})"))
        else:
            for p in paths:
                if _is_remote_ref(p):
                    continue
                resolved = _resolve_path(project_root, notes, p)
                if not resolved.exists():
                    issues.append(Issue("WARN", manifest_path, lineno, f"evidence path not found (warn-only): {p!r} (resolved: {resolved})"))

        created_at = obj.get("created_at")
        if created_at is not None and not isinstance(created_at, str):
            issues.append(Issue("ERROR", manifest_path, lineno, "created_at must be a string (ISO-8601 recommended)"))

    errors = [x for x in issues if x.level == "ERROR"]
    warns = [x for x in issues if x.level == "WARN"]

    print(f"- Notes: `{notes}`")
    print(f"- Project root: `{project_root}`")
    print(f"- Evidence manifest: `{manifest_path}`")
    print(f"- Records: {len(records)}")
    print(f"- Issues: errors={len(errors)}, warnings={len(warns)}")

    gate = "PASS" if not errors else "FAIL"
    print(f"- Gate: {gate}")

    shown = 0
    for it in issues:
        if shown >= args.max_issues:
            break
        print(f"{it.level}: {it.path}:{it.line}: {it.message}")
        shown += 1
    if len(issues) > shown:
        print(f"... ({len(issues) - shown} more)")

    if errors:
        print("")
        print("Fix: edit the offending JSONL line(s) and rerun. Each line must be one JSON object.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
