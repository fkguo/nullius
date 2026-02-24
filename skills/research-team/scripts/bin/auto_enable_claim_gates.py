#!/usr/bin/env python3
"""
Auto-enable Claim DAG gates once conditions are met.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import find_config_path, load_team_config  # type: ignore


def _count_jsonl(path: Path) -> int:
    if not path.is_file():
        return 0
    count = 0
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.strip():
            count += 1
    return count


def _load_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return None


def _write_json(path: Path, data: dict) -> bool:
    try:
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        return True
    except Exception:
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Notebook path (used to locate config and project root).")
    ap.add_argument("--status", default="", help="Status (e.g., converged).")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    cfg_path = find_config_path(args.notes)
    if cfg_path is None or not cfg_path.is_file():
        print("[skip] no research_team_config.json found")
        return 0

    if cfg_path.suffix.lower() not in (".json",):
        print("[skip] auto-enable only supports JSON configs")
        return 0

    auto_cfg = cfg.data.get("claim_gate_auto_enable", {})
    if not isinstance(auto_cfg, dict) or not bool(auto_cfg.get("enabled", False)):
        print("[skip] claim_gate_auto_enable disabled")
        return 0

    if bool(auto_cfg.get("require_converged", True)):
        if str(args.status).strip().lower() != "converged":
            print("[skip] not converged")
            return 0

    kg_dir = cfg.data.get("claim_graph", {}).get("base_dir", "knowledge_graph")
    project_root = cfg_path.parent.resolve()
    kg_path = project_root / str(kg_dir)
    claims = _count_jsonl(kg_path / "claims.jsonl")
    edges = _count_jsonl(kg_path / "edges.jsonl")
    evid = _count_jsonl(kg_path / "evidence_manifest.jsonl")

    min_claims = int(auto_cfg.get("min_claims", 1))
    min_edges = int(auto_cfg.get("min_edges", 0))
    min_evid = int(auto_cfg.get("min_evidence", 1))

    if claims < min_claims or edges < min_edges or evid < min_evid:
        print("[skip] claim graph below thresholds")
        return 0

    data = _load_json(cfg_path)
    if data is None:
        print("[skip] cannot load config JSON")
        return 0

    feats = data.get("features")
    if not isinstance(feats, dict):
        feats = {}
    already = all(
        bool(feats.get(k, False))
        for k in ("claim_graph_gate", "evidence_manifest_gate")
    )
    if already:
        print("[skip] claim DAG gates already enabled")
        return 0

    if bool(auto_cfg.get("dry_run", False)):
        print("[dry-run] would enable claim_graph_gate + evidence_manifest_gate")
        return 0

    feats["claim_graph_gate"] = True
    feats["evidence_manifest_gate"] = True

    enable_traj = bool(auto_cfg.get("enable_trajectory_gate", False))
    if enable_traj and (project_root / "team/trajectory_index.json").is_file():
        feats["claim_trajectory_link_gate"] = True

    data["features"] = feats
    if not _write_json(cfg_path, data):
        print("[warn] failed to update config")
        return 0

    print("[ok] enabled claim DAG gates in config")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
