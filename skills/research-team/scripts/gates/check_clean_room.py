#!/usr/bin/env python3
"""
Clean-room evidence gate for full_access team-cycle runs.

THREE-LAYER gate:
  Layer 1 — Cross-member path scan (CONTAMINATION_DETECTED)
  Layer 2 — Provenance/audit cross-validation (PROVENANCE_MISMATCH)
  Layer 3 — Hard-fail exit codes (non-degradable, no config bypass)

Exit codes:
  0  PASS (or SKIP for restricted / config-disabled)
  1  FAIL — soft violation (legacy soft path scan)
  3  HARD-FAIL — CONTAMINATION_DETECTED (non-degradable)
  4  HARD-FAIL — PROVENANCE_MISMATCH or PROVENANCE_MISSING (non-degradable)
  2  Input / execution error
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from audit_interceptor import AuditEntry, load_audit_log  # type: ignore
from provenance import extract_tool_call_ids, validate_tool_call_ids_against_audit  # type: ignore
from team_config import load_team_config  # type: ignore


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Issue:
    member: str
    field: str
    message: str
    hard_fail: bool = False  # True → exit 3/4


# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--notes", type=Path, required=True, help="Notebook path (used to locate config).")
    p.add_argument("--member-a", type=Path, required=True, help="Member A evidence JSON path.")
    p.add_argument("--member-b", type=Path, required=True, help="Member B evidence JSON path.")
    p.add_argument("--safe-tag", default="", help="Safe tag used in team/runs/<tag>.")
    p.add_argument("--audit-a", type=Path, default=None, help="Member A audit JSONL path (optional).")
    p.add_argument("--audit-b", type=Path, default=None, help="Member B audit JSONL path (optional).")
    p.add_argument("--workspace-id-a", default="", help="Member A workspace ID (for provenance check).")
    p.add_argument("--workspace-id-b", default="", help="Member B workspace ID (for provenance check).")
    p.add_argument("--max-issues", type=int, default=50)
    return p.parse_args()


# ---------------------------------------------------------------------------
# Layer 1: cross-member path scan
# ---------------------------------------------------------------------------


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8", errors="replace"))


def _as_list(d: dict[str, Any], key: str) -> list[Any]:
    v = d.get(key, [])
    return v if isinstance(v, list) else []


def _forbidden_patterns(member: str, safe_tag: str) -> list[re.Pattern[str]]:
    other = "member_b" if member == "member_a" else "member_a"
    base: list[str] = []
    if safe_tag:
        base.extend(
            [
                rf"team/runs/{re.escape(safe_tag)}/{re.escape(other)}(?:/|$)",
                rf"team/runs/{re.escape(safe_tag)}/{re.escape(other)}_evidence\.json",
                rf"artifacts/{re.escape(safe_tag)}/{re.escape(other)}(?:/|$)",
                # Workspace isolation dirs: block access to other member's isolated workspace.
                rf"team/runs/{re.escape(safe_tag)}/workspaces/{re.escape(other)}_",
                # Top-level member report file (e.g. <safe_tag>_member_b.md in run dir).
                rf"team/runs/{re.escape(safe_tag)}/{re.escape(safe_tag)}_{re.escape(other)}\.md",
                # Audit log and per-member attempt log subdir.
                rf"team/runs/{re.escape(safe_tag)}/{re.escape(other)}_audit\.jsonl",
                rf"team/runs/{re.escape(safe_tag)}/logs/{re.escape(other)}(?:/|$)",
            ]
        )
    else:
        base.extend(
            [
                rf"/{re.escape(other)}/",
                rf"{re.escape(other)}_evidence\.json",
                rf"artifacts/.+/{re.escape(other)}/",
            ]
        )
    return [re.compile(x) for x in base]


def _scan_member_paths(member: str, ev: dict[str, Any], safe_tag: str) -> list[Issue]:
    issues: list[Issue] = []
    pats = _forbidden_patterns(member, safe_tag)
    _dotdot_re = re.compile(r"(?:(?:^|[^\w.])\.\.(?:[^\w.]|$))")

    def bad(s: str) -> bool:
        normalized = s.replace("\\", "/")
        # Detect path traversal via '..' components (e.g., ../../member_b/...).
        if _dotdot_re.search(normalized):
            return True
        return any(p.search(normalized) for p in pats)

    for i, it in enumerate(_as_list(ev, "files_read")):
        if not isinstance(it, dict):
            continue
        path = str(it.get("path", "")).strip()
        if path and bad(path):
            issues.append(
                Issue(member, f"files_read[{i}].path", f"CONTAMINATION_DETECTED: forbidden cross-member path: {path!r}", hard_fail=True)
            )

    for i, it in enumerate(_as_list(ev, "commands_run")):
        if not isinstance(it, dict):
            continue
        for field, val in (("command", it.get("command", "")), ("cwd", it.get("cwd", "")), ("output_path", it.get("output_path", ""))):
            s = str(val).strip()
            if s and bad(s):
                issues.append(
                    Issue(member, f"commands_run[{i}].{field}", f"CONTAMINATION_DETECTED: command references other-member paths", hard_fail=True)
                )

    for i, it in enumerate(_as_list(ev, "network_queries")):
        if not isinstance(it, dict):
            continue
        for field in ("query_or_url", "downloaded_to"):
            val = str(it.get(field, "")).strip()
            if val and bad(val):
                issues.append(
                    Issue(member, f"network_queries[{i}].{field}", f"CONTAMINATION_DETECTED: network query references other-member paths: {val!r}", hard_fail=True)
                )

    for i, it in enumerate(_as_list(ev, "fetched_sources")):
        if not isinstance(it, dict):
            continue
        for field in ("original_url", "local_path_under_references"):
            val = str(it.get(field, "")).strip()
            if val and bad(val):
                issues.append(
                    Issue(member, f"fetched_sources[{i}].{field}", f"CONTAMINATION_DETECTED: fetched_sources references other-member paths: {val!r}", hard_fail=True)
                )

    for i, it in enumerate(_as_list(ev, "outputs_produced")):
        if not isinstance(it, dict):
            continue
        path = str(it.get("path", "")).strip()
        if path and bad(path):
            issues.append(
                Issue(member, f"outputs_produced[{i}].path", f"CONTAMINATION_DETECTED: forbidden cross-member output path: {path!r}", hard_fail=True)
            )

    return issues


# ---------------------------------------------------------------------------
# Layer 2: provenance/audit cross-validation
# ---------------------------------------------------------------------------


def _validate_provenance(
    member: str,
    ev: dict[str, Any],
    audit_entries: list[AuditEntry],
    workspace_id: str,
) -> list[Issue]:
    tc_ids = extract_tool_call_ids(ev)
    if not tc_ids:
        return []
    if not audit_entries:
        # Evidence carries tc_ids but no audit log was provided — the provenance
        # chain cannot be verified, which is a hard failure.
        return [
            Issue(
                member,
                "provenance",
                f"PROVENANCE_MISMATCH: evidence contains {len(tc_ids)} tc_id(s) but no audit log was provided",
                hard_fail=True,
            )
        ]
    raw_issues = validate_tool_call_ids_against_audit(tc_ids, audit_entries, own_workspace=workspace_id)
    return [
        Issue(member, "provenance", msg, hard_fail=True)
        for msg in raw_issues
    ]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    args = _parse_args()
    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}", file=sys.stderr)
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("clean_room_gate", default=False):
        print(f"- Notes: `{args.notes}`")
        print("- Gate: SKIP (clean_room_gate disabled by config)")
        return 0

    mode = str(getattr(cfg, "data", {}).get("review_access_mode", "packet_only")).strip().lower()
    if mode != "full_access":
        print(f"- Notes: `{args.notes}`")
        print(f"- Review access mode: {mode or 'packet_only'}")
        print("- Gate: SKIP (review_access_mode != full_access)")
        return 0

    if not args.member_a.is_file() or not args.member_b.is_file():
        print("ERROR: missing member evidence file(s)", file=sys.stderr)
        print(f"  member_a: {args.member_a}", file=sys.stderr)
        print(f"  member_b: {args.member_b}", file=sys.stderr)
        return 2

    ev_a = _load(args.member_a)
    ev_b = _load(args.member_b)

    # Layer 1: cross-member path scan.
    issues: list[Issue] = []
    issues.extend(_scan_member_paths("member_a", ev_a, args.safe_tag))
    issues.extend(_scan_member_paths("member_b", ev_b, args.safe_tag))

    # Layer 2: provenance cross-validation (only when audit logs are provided).
    audit_a: list[AuditEntry] = []
    audit_b: list[AuditEntry] = []
    if args.workspace_id_a and args.audit_a is None:
        # full_access mode (workspace_id set) but audit log path was not passed — this
        # means the audit interceptor was never initialised, which is a hard failure.
        issues.append(Issue("member_a", "provenance",
                            "PROVENANCE_MISSING: full_access run (workspace_id set) but no audit log was provided to the gate",
                            hard_fail=True))
    elif args.audit_a is not None:
        if not Path(args.audit_a).is_file():
            issues.append(Issue("member_a", "provenance",
                                f"PROVENANCE_MISSING: audit log expected but not found: {args.audit_a}",
                                hard_fail=True))
        else:
            audit_a = load_audit_log(args.audit_a)
    if args.workspace_id_b and args.audit_b is None:
        issues.append(Issue("member_b", "provenance",
                            "PROVENANCE_MISSING: full_access run (workspace_id set) but no audit log was provided to the gate",
                            hard_fail=True))
    elif args.audit_b is not None:
        if not Path(args.audit_b).is_file():
            issues.append(Issue("member_b", "provenance",
                                f"PROVENANCE_MISSING: audit log expected but not found: {args.audit_b}",
                                hard_fail=True))
        else:
            audit_b = load_audit_log(args.audit_b)

    issues.extend(_validate_provenance("member_a", ev_a, audit_a, args.workspace_id_a))
    issues.extend(_validate_provenance("member_b", ev_b, audit_b, args.workspace_id_b))

    print(f"- Notes: `{args.notes}`")
    print(f"- Member A evidence: `{args.member_a}`")
    print(f"- Member B evidence: `{args.member_b}`")
    if args.audit_a:
        print(f"- Member A audit: `{args.audit_a}` ({len(audit_a)} entries)")
    if args.audit_b:
        print(f"- Member B audit: `{args.audit_b}` ({len(audit_b)} entries)")
    print(f"- Issues: {len(issues)}")

    if not issues:
        print("- Gate: PASS")
        return 0

    hard_contamination = [i for i in issues if i.hard_fail and "CONTAMINATION_DETECTED" in i.message]
    hard_provenance = [i for i in issues if i.hard_fail and ("PROVENANCE_MISMATCH" in i.message or "PROVENANCE_MISSING" in i.message)]

    for it in (issues[: args.max_issues]):
        severity = "HARD-FAIL" if it.hard_fail else "ERROR"
        print(f"{severity}: {it.member} {it.field}: {it.message}")
    if len(issues) > args.max_issues:
        print(f"... ({len(issues) - args.max_issues} more)")

    # Layer 3: hard-fail exit codes (non-degradable).
    if hard_contamination:
        print("- Gate: HARD-FAIL (CONTAMINATION_DETECTED)")
        return 3
    if hard_provenance:
        print("- Gate: HARD-FAIL (PROVENANCE_MISMATCH or PROVENANCE_MISSING)")
        return 4
    # Soft violations only (legacy path for backward compatibility).
    print("- Gate: FAIL")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
