#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore


def _find_project_root(seed: Path) -> Path:
    cur = seed.resolve()
    if cur.is_file():
        cur = cur.parent
    for _ in range(12):
        if (cur / "PROJECT_CHARTER.md").is_file() and (cur / "Draft_Derivation.md").is_file():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return seed.parent.resolve() if seed.is_file() else seed.resolve()


def _is_rel_path(p: str) -> bool:
    if not p or not isinstance(p, str):
        return False
    s = p.strip()
    if not s:
        return False
    if s.startswith("~"):
        return False
    path = Path(s)
    if path.is_absolute():
        return False
    # v1 strategy: keep everything within the project root (no ".." escape hatches).
    if any(part == ".." for part in path.parts):
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Gate: require .hep/workspace.json for hep-research-mcp workspace bootstrap (v1).")
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md (or any file under project root).")
    args = ap.parse_args()

    if not args.notes.exists():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("hep_workspace_gate", default=True):
        print("[skip] hep workspace gate disabled by research_team_config")
        return 0

    root = _find_project_root(args.notes)
    workspace = root / ".hep" / "workspace.json"
    if not workspace.is_file():
        print(f"ERROR: missing hep workspace file: {workspace}")
        print("Fix (recommended; idempotent, does not overwrite existing files):")
        print(f"  mkdir -p {root / '.hep'}")
        print(f"  cp ~/.codex/skills/research-team/assets/hep_workspace_template.json {workspace}")
        print(f"  cp ~/.codex/skills/research-team/assets/hep_mappings_template.json {root / '.hep' / 'mappings.json'}")
        print("")
        print("Then (when using hep-research-mcp), recommended env var:")
        print(f"  export HEP_DATA_DIR=\"{(root / '.hep-research-mcp')}\"")
        return 1

    try:
        data = json.loads(workspace.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:
        print(f"ERROR: failed to parse JSON: {workspace} ({exc})")
        return 2
    if not isinstance(data, dict):
        print(f"ERROR: expected a JSON object at top-level: {workspace}")
        return 2

    ver = data.get("schemaVersion")
    if ver not in ("1.0", 1.0, 1):
        print(f"ERROR: workspace schemaVersion must be 1.0 (got {ver!r})")
        return 1

    paths = data.get("paths")
    if not isinstance(paths, dict):
        print("ERROR: workspace missing required object field: paths")
        return 1

    required = ("hep_data_dir", "pdg_dir", "paper_dir")
    missing = [k for k in required if not isinstance(paths.get(k), str) or not str(paths.get(k, "")).strip()]
    if missing:
        print(f"ERROR: workspace missing required path field(s): {', '.join(missing)}")
        print("Fix: fill the missing keys under workspace.json -> paths (project-root-relative strings).")
        return 1

    bad = [k for k in required if not _is_rel_path(str(paths.get(k, "")).strip())]
    if bad:
        print(f"ERROR: workspace path(s) must be project-root-relative (no absolute paths, no '..'): {', '.join(bad)}")
        print("Fix: rewrite those fields under workspace.json -> paths to be relative to the project root.")
        return 1

    print("[ok] hep workspace gate passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

