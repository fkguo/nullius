#!/usr/bin/env python3
"""
Check Claim DAG files under knowledge_graph/:
  - claims.jsonl
  - edges.jsonl

This gate is deterministic and fixable:
- validates JSONL structure (one JSON object per line)
- validates required fields and basic schema
- validates references (dependencies, evidence ids)
- checks acyclicity for dependency-like edges (requires/supersedes)

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


ALLOWED_PROFILES = {
    "theory_only",
    "numerics_only",
    "mixed",
    "exploratory",
    "literature_review",
    "methodology_dev",
    "toolkit_extraction",
    "custom",
}

ALLOWED_STATUSES = {
    "draft",
    "active",
    "verified",
    "verified_with_dissent",
    "refuted",
    "under_review",
    "superseded",
    "paused",
    "archived",
    "stalled",
    "disputed",
}

ALLOWED_EDGE_TYPES = {
    "requires",
    "supports",
    "contradicts",
    "competitor",
    "fork",
    "supersedes",
}

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
    p.add_argument("--claims", type=Path, default=None, help="Override claims.jsonl path.")
    p.add_argument("--edges", type=Path, default=None, help="Override edges.jsonl path.")
    p.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="Optional evidence_manifest.jsonl path. If omitted and file exists under knowledge_graph/, it is loaded.",
    )
    p.add_argument("--require-manifest", action="store_true", help="If set: missing evidence_manifest.jsonl is an error.")
    p.add_argument("--max-issues", type=int, default=80, help="Max issues to print.")
    return p.parse_args()


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


def _project_root(notes: Path) -> Path:
    cfg_path = None
    try:
        cfg_path = find_config_path(notes)
    except Exception:
        cfg_path = None
    if cfg_path is not None and cfg_path.is_file():
        return cfg_path.parent.resolve()
    return notes.parent.resolve()


def _load_evidence_ids(manifest_path: Path) -> tuple[set[str], list[Issue]]:
    issues: list[Issue] = []
    ids: set[str] = set()
    try:
        for lineno, obj in _iter_jsonl(manifest_path):
            ev_id = obj.get("id")
            if not isinstance(ev_id, str) or not ev_id.strip():
                issues.append(Issue("ERROR", manifest_path, lineno, "missing required string field: id"))
                continue
            if ev_id in ids:
                issues.append(Issue("ERROR", manifest_path, lineno, f"duplicate evidence id: {ev_id!r}"))
            ids.add(ev_id)
    except FileNotFoundError:
        raise
    except Exception as e:
        raise ValueError(f"failed to parse evidence manifest: {e}") from e
    return ids, issues


def _find_cycles(nodes: list[str], edges: list[tuple[str, str]]) -> list[list[str]]:
    """
    Return a list of cycles, each represented as a node path.
    Only suitable for small graphs (MVP gate).
    """
    adj: dict[str, list[str]] = {n: [] for n in nodes}
    for a, b in edges:
        adj.setdefault(a, []).append(b)

    cycles: list[list[str]] = []
    visiting: set[str] = set()
    visited: set[str] = set()
    stack: list[str] = []

    def dfs(n: str) -> None:
        if n in visited:
            return
        if n in visiting:
            if n in stack:
                i = stack.index(n)
                cycles.append(stack[i:] + [n])
            return
        visiting.add(n)
        stack.append(n)
        for nxt in adj.get(n, []):
            dfs(nxt)
        stack.pop()
        visiting.remove(n)
        visited.add(n)

    for n in nodes:
        dfs(n)
    return cycles


def main() -> int:
    args = _parse_args()
    notes: Path = args.notes
    if not notes.is_file():
        print(f"ERROR: notes not found: {notes}", file=sys.stderr)
        return 2

    cfg = load_team_config(notes)
    if not cfg.feature_enabled("claim_graph_gate", default=False):
        print(f"- Notes: `{notes}`")
        print("- Gate: SKIP (claim_graph_gate disabled by research_team_config)")
        return 0
    project_profile = str(cfg.data.get("profile", "")).strip().lower()
    strict_dep_consistency = project_profile == "toolkit_extraction"

    project_root = _project_root(notes)
    base_dir = str(cfg.data.get("claim_graph", {}).get("base_dir", "knowledge_graph")).strip() or "knowledge_graph"
    claims_path = args.claims or (project_root / base_dir / "claims.jsonl")
    edges_path = args.edges or (project_root / base_dir / "edges.jsonl")

    manifest_path: Path | None = args.manifest
    if manifest_path is None:
        cand = project_root / base_dir / "evidence_manifest.jsonl"
        manifest_path = cand if cand.exists() else None

    issues: list[Issue] = []

    # Load claims and edges.
    try:
        claim_recs = _iter_jsonl(claims_path)
    except FileNotFoundError:
        print(f"ERROR: claims file not found: {claims_path}", file=sys.stderr)
        print("Fix: create it (e.g. run scaffold_claim_dag.sh) or disable claim_graph_gate.", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"ERROR: failed to read/parse: {claims_path}", file=sys.stderr)
        print(f"  {e}", file=sys.stderr)
        return 2

    try:
        edge_recs = _iter_jsonl(edges_path)
    except FileNotFoundError:
        print(f"ERROR: edges file not found: {edges_path}", file=sys.stderr)
        print("Fix: create it (e.g. run scaffold_claim_dag.sh) or disable claim_graph_gate.", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"ERROR: failed to read/parse: {edges_path}", file=sys.stderr)
        print(f"  {e}", file=sys.stderr)
        return 2

    evidence_ids: set[str] = set()
    if manifest_path is not None:
        try:
            evidence_ids, ev_issues = _load_evidence_ids(manifest_path)
            issues.extend(ev_issues)
        except FileNotFoundError:
            if args.require_manifest:
                issues.append(Issue("ERROR", manifest_path, 0, "evidence_manifest.jsonl is required but not found"))
        except Exception as e:
            issues.append(Issue("ERROR", manifest_path, 0, str(e)))
    elif args.require_manifest:
        issues.append(Issue("ERROR", claims_path, 0, "evidence_manifest.jsonl is required but not found"))

    claim_ids: dict[str, int] = {}
    # Validate claims.
    for lineno, obj in claim_recs:
        cid = obj.get("id")
        if not isinstance(cid, str) or not cid.strip():
            issues.append(Issue("ERROR", claims_path, lineno, "missing required string field: id"))
            continue
        cid = cid.strip()
        if not _ID_RE.match(cid):
            issues.append(Issue("ERROR", claims_path, lineno, f"invalid id: {cid!r} (use [A-Za-z0-9._-])"))
        if cid in claim_ids:
            issues.append(Issue("ERROR", claims_path, lineno, f"duplicate claim id: {cid!r} (first at line {claim_ids[cid]})"))
        else:
            claim_ids[cid] = lineno

        stmt = obj.get("statement")
        if not isinstance(stmt, str) or not stmt.strip():
            issues.append(Issue("ERROR", claims_path, lineno, "missing required string field: statement"))

        profile = obj.get("profile")
        if not isinstance(profile, str) or not profile.strip():
            issues.append(Issue("ERROR", claims_path, lineno, "missing required string field: profile"))
        else:
            p = profile.strip()
            if p not in ALLOWED_PROFILES:
                issues.append(
                    Issue("ERROR", claims_path, lineno, f"invalid profile: {p!r} (allowed: {sorted(ALLOWED_PROFILES)})")
                )

        status = obj.get("status")
        if not isinstance(status, str) or not status.strip():
            issues.append(Issue("ERROR", claims_path, lineno, "missing required string field: status"))
            status_s = ""
        else:
            status_s = status.strip()
            if status_s not in ALLOWED_STATUSES:
                issues.append(
                    Issue("ERROR", claims_path, lineno, f"invalid status: {status_s!r} (allowed: {sorted(ALLOWED_STATUSES)})")
                )

        conf = obj.get("confidence")
        if not isinstance(conf, (int, float)):
            issues.append(Issue("ERROR", claims_path, lineno, "missing required numeric field: confidence (0..1)"))
            conf_val = None
        else:
            conf_val = float(conf)
            if not (0.0 <= conf_val <= 1.0):
                issues.append(Issue("ERROR", claims_path, lineno, f"confidence out of range: {conf_val} (must be 0..1)"))

        deps = obj.get("dependencies", [])
        if deps is None:
            deps = []
        if not isinstance(deps, list) or not all(isinstance(x, str) for x in deps):
            issues.append(Issue("ERROR", claims_path, lineno, "dependencies must be a list of claim id strings"))
            deps_list: list[str] = []
        else:
            deps_list = [x.strip() for x in deps if x.strip()]

        for d in deps_list:
            # Existence check after full parse (second pass) handled below.
            if not _ID_RE.match(d):
                issues.append(Issue("WARN", claims_path, lineno, f"dependency id has unusual characters: {d!r}"))

        kill = obj.get("kill_criteria", [])
        if kill is None:
            kill = []
        if not isinstance(kill, list):
            issues.append(Issue("ERROR", claims_path, lineno, "kill_criteria must be a list (possibly empty for draft)"))
            kill_list: list[dict] = []
        else:
            kill_list = [x for x in kill if isinstance(x, dict)]
            if len(kill_list) != len(kill):
                issues.append(Issue("ERROR", claims_path, lineno, "kill_criteria entries must be JSON objects"))

        if status_s in ("active", "verified", "verified_with_dissent", "disputed"):
            if not kill_list:
                # Allow exploratory to be warn-only (profile-aware relaxation).
                if isinstance(profile, str) and profile.strip() == "exploratory":
                    issues.append(Issue("WARN", claims_path, lineno, "active claim missing kill_criteria (exploratory: warn-only)"))
                else:
                    issues.append(Issue("ERROR", claims_path, lineno, f"status={status_s} requires non-empty kill_criteria"))

        supp = obj.get("supports_evidence", [])
        contra = obj.get("contradicts_evidence", [])
        for field, val in (("supports_evidence", supp), ("contradicts_evidence", contra)):
            if val is None:
                continue
            if not isinstance(val, list) or not all(isinstance(x, str) for x in val):
                issues.append(Issue("ERROR", claims_path, lineno, f"{field} must be a list of evidence id strings"))
        if conf_val is not None and conf_val >= 0.7:
            if isinstance(supp, list) and all(isinstance(x, str) for x in supp) and len([x for x in supp if x.strip()]) == 0:
                issues.append(Issue("WARN", claims_path, lineno, "confidence>=0.7 but supports_evidence is empty (consider adding evidence or lowering confidence)"))

    # Second pass: dependency and evidence existence checks.
    all_claim_ids = set(claim_ids.keys())
    for lineno, obj in claim_recs:
        cid = obj.get("id")
        if not isinstance(cid, str) or not cid.strip():
            continue
        deps = obj.get("dependencies", [])
        if isinstance(deps, list):
            for d in deps:
                if isinstance(d, str) and d.strip() and d.strip() not in all_claim_ids:
                    issues.append(
                        Issue("ERROR", claims_path, lineno, f"unknown dependency claim id: {d!r} (add it to claims.jsonl or fix the id)")
                    )
        for ev_field in ("supports_evidence", "contradicts_evidence"):
            evs = obj.get(ev_field, [])
            if isinstance(evs, list) and evidence_ids:
                for ev in evs:
                    if isinstance(ev, str) and ev.strip() and ev.strip() not in evidence_ids:
                        issues.append(
                            Issue(
                                "ERROR",
                                claims_path,
                                lineno,
                                f"unknown evidence id in {ev_field}: {ev!r} (add to evidence_manifest.jsonl or fix the id)",
                            )
                        )

    # Validate edges.
    dep_edges: list[tuple[str, str]] = []
    requires_edges: set[tuple[str, str]] = set()
    for lineno, obj in edge_recs:
        eid = obj.get("id")
        if not isinstance(eid, str) or not eid.strip():
            issues.append(Issue("ERROR", edges_path, lineno, "missing required string field: id"))
        et = obj.get("type")
        if not isinstance(et, str) or not et.strip():
            issues.append(Issue("ERROR", edges_path, lineno, "missing required string field: type"))
            continue
        et_s = et.strip()
        if et_s not in ALLOWED_EDGE_TYPES:
            issues.append(Issue("ERROR", edges_path, lineno, f"invalid edge type: {et_s!r} (allowed: {sorted(ALLOWED_EDGE_TYPES)})"))
            continue

        src = obj.get("source")
        tgt = obj.get("target")
        if not isinstance(src, str) or not src.strip():
            issues.append(Issue("ERROR", edges_path, lineno, "missing required string field: source"))
            continue
        if not isinstance(tgt, str) or not tgt.strip():
            issues.append(Issue("ERROR", edges_path, lineno, "missing required string field: target"))
            continue
        src_id = src.strip()
        tgt_id = tgt.strip()
        if src_id not in all_claim_ids:
            issues.append(Issue("ERROR", edges_path, lineno, f"unknown source claim id: {src_id!r}"))
        if tgt_id not in all_claim_ids:
            issues.append(Issue("ERROR", edges_path, lineno, f"unknown target claim id: {tgt_id!r}"))

        if et_s in ("requires", "supersedes"):
            dep_edges.append((src_id, tgt_id))
        if et_s == "requires":
            requires_edges.add((src_id, tgt_id))

    # Acyclic check for dependency-like edges.
    if dep_edges:
        cycles = _find_cycles(sorted(all_claim_ids), dep_edges)
        if cycles:
            # De-duplicate: only show first few.
            shown = 0
            for cyc in cycles[:5]:
                issues.append(Issue("ERROR", edges_path, 0, f"dependency cycle detected: {' -> '.join(cyc)}"))
                shown += 1

    # Consistency check: claim.dependencies should match requires edges.
    #
    # This is a common source of "graph doesn't show the workflow" bugs:
    # - claims declare dependencies, but edges.jsonl is missing the corresponding requires edges.
    declared_deps: set[tuple[str, str]] = set()
    for lineno, obj in claim_recs:
        cid = obj.get("id")
        if not isinstance(cid, str) or not cid.strip():
            continue
        deps = obj.get("dependencies", [])
        if deps is None:
            deps = []
        if not isinstance(deps, list):
            continue
        for d in deps:
            if isinstance(d, str) and d.strip():
                declared_deps.add((cid.strip(), d.strip()))

    missing_requires_edges = sorted(declared_deps - requires_edges)
    extra_requires_edges = sorted(requires_edges - declared_deps)
    if missing_requires_edges:
        level = "ERROR" if strict_dep_consistency else "WARN"
        for src, tgt in missing_requires_edges[:20]:
            issues.append(
                Issue(
                    level,
                    edges_path,
                    0,
                    f"dependency listed in claims.jsonl but missing requires edge: {src!r} requires {tgt!r} (add to edges.jsonl)",
                )
            )
        if len(missing_requires_edges) > 20:
            issues.append(Issue(level, edges_path, 0, f"... ({len(missing_requires_edges) - 20} more missing requires edges)"))
    if extra_requires_edges:
        level = "ERROR" if strict_dep_consistency else "WARN"
        for src, tgt in extra_requires_edges[:20]:
            issues.append(
                Issue(
                    level,
                    claims_path,
                    0,
                    f"requires edge not reflected in claim.dependencies: {src!r} requires {tgt!r} (add to claims.jsonl.dependencies or remove redundancy)",
                )
            )
        if len(extra_requires_edges) > 20:
            issues.append(Issue(level, claims_path, 0, f"... ({len(extra_requires_edges) - 20} more extra requires edges)"))

    errors = [x for x in issues if x.level == "ERROR"]
    warns = [x for x in issues if x.level == "WARN"]

    print(f"- Notes: `{notes}`")
    print(f"- Project root: `{project_root}`")
    print(f"- Claims: `{claims_path}` ({len(claim_recs)} records)")
    print(f"- Edges: `{edges_path}` ({len(edge_recs)} records)")
    if manifest_path is not None:
        print(f"- Evidence manifest: `{manifest_path}` ({len(evidence_ids)} ids)")
    print(f"- Issues: errors={len(errors)}, warnings={len(warns)}")

    gate = "PASS" if not errors else "FAIL"
    print(f"- Gate: {gate}")

    shown = 0
    for it in issues:
        if shown >= args.max_issues:
            break
        loc = f"{it.path}:{it.line}" if it.line > 0 else f"{it.path}"
        print(f"{it.level}: {loc}: {it.message}")
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
