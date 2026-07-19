#!/usr/bin/env python3
"""
Delegation budget gate for delegated computation / verification workstreams.

Why this gate exists (AI failure mode, domain-agnostic): a delegated
executing agent's default drift is to refine precision indefinitely and to
expand scope on its own initiative; a delegation without explicit budgets
is drift by construction. The counter-discipline is a machine-checked
budget contract written by the coordinator BEFORE dispatch. The check is
fail-closed: a contract missing any required budget field, carrying an
unfilled template placeholder, or using an unknown contract version does
NOT pass.

Contract shape (`delegation_budget_contract_v1`, one JSON file per
delegated workstream, default location `<project_root>/team/delegations/`):

  - contract_version: 1
  - delegation_id: short stable id for the delegated workstream
  - workstream: one line stating WHAT is delegated
  - tolerance_ceiling:
      value: numeric tolerance ceiling the result must reach — and must
             NOT be refined beyond (reaching the ceiling means STOP)
      anchor_note: one line stating which requirement of the task derives
             this ceiling (what the result is for — not what the method
             can achieve)
  - time_box: { seconds: hard wall-clock budget for the workstream }
  - max_attempts: cap on "one last attempt" retries (>= 1)
  - scope_negative_list: non-empty list of expansions the executor must
      NOT undertake on its own initiative (e.g. infrastructure rewrites,
      building a full test suite, third-party benchmarking)
  - peak_memory_estimate:
      dry_run_peak_rss_mb: peak resident-set size measured on a
             single-unit dry run BEFORE the full launch (estimating
             wall-clock alone is not a resource estimate)
      heap_limit_mb: explicit heap cap for the full run
             (must be >= dry_run_peak_rss_mb)

Falsification labels (all fail-closed):
  NO_CONTRACTS_FOUND, UNREADABLE_CONTRACT, UNSUPPORTED_CONTRACT_VERSION,
  MISSING_DELEGATION_ID, MISSING_WORKSTREAM,
  MISSING_TOLERANCE_CEILING, MISSING_TOLERANCE_VALUE,
  MISSING_TOLERANCE_ANCHOR, MISSING_TIME_BOX, MISSING_MAX_ATTEMPTS,
  MISSING_SCOPE_NEGATIVE_LIST, MISSING_PEAK_MEMORY_ESTIMATE,
  MISSING_DRY_RUN_PEAK_RSS, MISSING_HEAP_LIMIT,
  HEAP_LIMIT_BELOW_DRY_RUN_PEAK, PLACEHOLDER_VALUE

Budget-exhaustion semantics (enforced as prose contract, see the
research-harness skill): when the time box or attempt cap is exhausted,
the workstream wraps up from the atomic results already flushed to disk —
it never voids the whole batch; abandoned approaches are recorded in the
failed-approaches ledger (`failed_approaches_v1`).

Machine verdict:
  Emits a `convergence_gate_result_v1` JSON object on stdout (and to
  --out-json when given) whenever the gate actually evaluates
  (PASS / FAIL / input error). Human diagnostics go to stderr. On SKIP
  (feature disabled, or no contracts exist and none are required) no
  verdict is emitted: nothing was evaluated.

Exit codes:
  0  PASS (or SKIP)
  1  FAIL (incomplete/invalid contract, or contracts required but absent)
  2  Input / execution error
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from convergence_schema import (  # type: ignore
    build_gate_meta,
    emit_convergence_result,
    validate_convergence_result,
)
from team_config import load_team_config  # type: ignore

SUPPORTED_CONTRACT_VERSION = 1
DEFAULT_DELEGATIONS_DIR = "team/delegations"

# An unfilled template placeholder is a string whose entire trimmed value is
# an angle-bracketed hint like "<one line: ...>". Substring matching is NOT
# used: legitimate prose such as "error < 1% and > 0" must not false-positive.
_PLACEHOLDER_RE = re.compile(r"^<.*>$", re.DOTALL)


def _is_placeholder(value: str) -> bool:
    return bool(_PLACEHOLDER_RE.match(value.strip()))


def _is_finite_positive_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if not isinstance(value, (int, float)):
        return False
    return math.isfinite(value) and value > 0


def _is_positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _check_required_string(
    contract: dict[str, Any], key: str, label: str, issues: list[str]
) -> None:
    value = contract.get(key)
    if not isinstance(value, str) or not value.strip():
        issues.append(f"{label}: `{key}` must be a non-empty string")
    elif _is_placeholder(value):
        issues.append(f"PLACEHOLDER_VALUE: `{key}` still carries the template placeholder {value.strip()!r}")


def _validate_contract(contract: Any) -> list[str]:
    """Return the fail-closed issue list for one parsed contract object."""
    if not isinstance(contract, dict):
        return ["UNREADABLE_CONTRACT: top-level JSON value must be an object"]

    issues: list[str] = []

    version = contract.get("contract_version")
    if version != SUPPORTED_CONTRACT_VERSION:
        issues.append(
            "UNSUPPORTED_CONTRACT_VERSION: `contract_version` must be "
            f"{SUPPORTED_CONTRACT_VERSION} (got {version!r}); unknown versions fail closed"
        )

    _check_required_string(contract, "delegation_id", "MISSING_DELEGATION_ID", issues)
    _check_required_string(contract, "workstream", "MISSING_WORKSTREAM", issues)

    # tolerance_ceiling: numeric ceiling + one-line anchor note.
    tol = contract.get("tolerance_ceiling")
    if not isinstance(tol, dict):
        issues.append(
            "MISSING_TOLERANCE_CEILING: `tolerance_ceiling` object is required "
            "(numeric ceiling + anchor note); without it the executor's default "
            "is to refine precision without bound"
        )
    else:
        if not _is_finite_positive_number(tol.get("value")):
            issues.append(
                "MISSING_TOLERANCE_VALUE: `tolerance_ceiling.value` must be a finite "
                f"positive number (got {tol.get('value')!r})"
            )
        anchor = tol.get("anchor_note")
        if not isinstance(anchor, str) or not anchor.strip():
            issues.append(
                "MISSING_TOLERANCE_ANCHOR: `tolerance_ceiling.anchor_note` must be a "
                "non-empty one-line statement of which task requirement derives the "
                "ceiling — an unanchored tolerance is a number nobody can audit"
            )
        elif _is_placeholder(anchor):
            issues.append(
                "PLACEHOLDER_VALUE: `tolerance_ceiling.anchor_note` still carries the "
                f"template placeholder {anchor.strip()!r}"
            )

    # time_box: hard wall-clock budget.
    time_box = contract.get("time_box")
    if not isinstance(time_box, dict) or not _is_positive_int(time_box.get("seconds")):
        issues.append(
            "MISSING_TIME_BOX: `time_box.seconds` must be a positive integer "
            f"(got {time_box!r}); an open-ended delegation has no stopping point"
        )

    # max_attempts: cap on "one last attempt" retries.
    if not _is_positive_int(contract.get("max_attempts")):
        issues.append(
            "MISSING_MAX_ATTEMPTS: `max_attempts` must be a positive integer "
            f"(got {contract.get('max_attempts')!r})"
        )

    # scope_negative_list: expansions the executor must not undertake.
    scope = contract.get("scope_negative_list")
    if (
        not isinstance(scope, list)
        or not scope
        or any(not isinstance(item, str) or not item.strip() for item in scope)
    ):
        issues.append(
            "MISSING_SCOPE_NEGATIVE_LIST: `scope_negative_list` must be a non-empty "
            "list of non-empty strings naming expansions the executor must NOT "
            "undertake on its own initiative"
        )
    elif any(_is_placeholder(item) for item in scope):
        issues.append(
            "PLACEHOLDER_VALUE: `scope_negative_list` still carries a template placeholder entry"
        )

    # peak_memory_estimate: single-unit dry-run peak RSS + explicit heap cap.
    mem = contract.get("peak_memory_estimate")
    if not isinstance(mem, dict):
        issues.append(
            "MISSING_PEAK_MEMORY_ESTIMATE: `peak_memory_estimate` object is required "
            "(single-unit dry-run peak RSS + heap cap); estimating wall-clock alone "
            "is not a resource estimate"
        )
    else:
        rss = mem.get("dry_run_peak_rss_mb")
        heap = mem.get("heap_limit_mb")
        if not _is_finite_positive_number(rss):
            issues.append(
                "MISSING_DRY_RUN_PEAK_RSS: `peak_memory_estimate.dry_run_peak_rss_mb` "
                f"must be a finite positive number measured on a dry run (got {rss!r})"
            )
        if not _is_finite_positive_number(heap):
            issues.append(
                "MISSING_HEAP_LIMIT: `peak_memory_estimate.heap_limit_mb` must be a "
                f"finite positive number (got {heap!r})"
            )
        if _is_finite_positive_number(rss) and _is_finite_positive_number(heap) and heap < rss:
            issues.append(
                "HEAP_LIMIT_BELOW_DRY_RUN_PEAK: `heap_limit_mb` "
                f"({heap!r}) is below the measured dry-run peak RSS ({rss!r}); "
                "the full run would exceed its own cap"
            )

    return issues


def _contract_summary(issues: list[str], *, parse_ok: bool) -> dict[str, Any]:
    out: dict[str, Any] = {
        "verdict": "ready" if parse_ok and not issues else ("needs_revision" if parse_ok else "unknown"),
        "blocking_count": len(issues),
        "parse_ok": parse_ok,
    }
    if issues:
        out["errors"] = issues
    return out


def _emit(
    *,
    status: str,
    exit_code: int,
    reasons: list[str],
    report_status: dict[str, Any],
    meta: dict[str, Any],
    out_json: Path | None,
) -> int:
    result: dict[str, Any] = {
        "status": status,
        "exit_code": exit_code,
        "reasons": reasons,
        "report_status": report_status,
        "meta": meta,
    }
    schema_errors = validate_convergence_result(result)
    if schema_errors:
        result = {
            "status": "parse_error",
            "exit_code": 2,
            "reasons": ["schema validation failed", *schema_errors],
            "report_status": {k: {**v, "parse_ok": False} for k, v in report_status.items()},
            "meta": meta,
        }
        exit_code = 2
    emit_convergence_result(result, out_json=out_json)
    return exit_code


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Delegation budget contract gate (fail-closed)")
    ap.add_argument("--notes", type=Path, required=True, help="research notebook path (locates team config)")
    ap.add_argument("--project-root", type=Path, default=None, help="project root (default: config/notes dir)")
    ap.add_argument(
        "--contract",
        type=Path,
        action="append",
        default=[],
        help="explicit delegation contract file (repeatable; overrides directory scan)",
    )
    ap.add_argument(
        "--delegations-dir",
        type=Path,
        default=None,
        help=f"directory scanned for *.json contracts (default: <project_root>/{DEFAULT_DELEGATIONS_DIR})",
    )
    ap.add_argument(
        "--require",
        action="store_true",
        help="fail (NO_CONTRACTS_FOUND) when no contract exists — for callers that know a delegation happened",
    )
    ap.add_argument("--tag", default="", help="run tag (recorded in the machine verdict)")
    ap.add_argument("--out-json", type=Path, default=None, help="also write the machine verdict to this path")
    return ap.parse_args()


def main() -> int:
    args = _parse_args()
    base_meta = build_gate_meta("delegation_budget")
    if args.tag.strip():
        base_meta["tag"] = args.tag.strip()

    def _input_error(reasons: list[str]) -> int:
        for r in reasons:
            print(f"ERROR: {r}", file=sys.stderr)
        return _emit(
            status="parse_error",
            exit_code=2,
            reasons=reasons,
            report_status={"delegations": _contract_summary(reasons, parse_ok=False)},
            meta=base_meta,
            out_json=args.out_json,
        )

    try:
        return _run(args, base_meta, _input_error)
    except Exception as e:
        # Fail-closed: an unforeseen crash must still leave a machine-readable
        # parse_error verdict on stdout (exit 2), not a bare traceback whose
        # missing verdict a caller could mistake for "gate not run".
        return _input_error([f"unexpected gate error: {type(e).__name__}: {e}"])


def _run(args: argparse.Namespace, base_meta: dict[str, Any], _input_error: Any) -> int:
    if not args.notes.is_file():
        return _input_error([f"notes not found: {args.notes}"])

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("delegation_budget_gate", default=True):
        print(f"- Notes: `{args.notes}`", file=sys.stderr)
        print("- Gate: SKIP (delegation_budget_gate disabled by config)", file=sys.stderr)
        return 0

    if args.project_root is not None:
        project_root = args.project_root.resolve()
    elif cfg.path is not None:
        project_root = cfg.path.resolve().parent
    else:
        project_root = args.notes.resolve().parent

    block = cfg.data.get("delegation_budget", {}) if isinstance(cfg.data, dict) else {}
    if not isinstance(block, dict):
        return _input_error(["config `delegation_budget` must be an object when present"])
    required = bool(args.require or block.get("required", False))

    if args.contract:
        contract_paths = [p if p.is_absolute() else (project_root / p) for p in args.contract]
        missing_explicit = [str(p) for p in contract_paths if not p.is_file()]
        if missing_explicit:
            return _input_error([f"contract file not found: {p}" for p in missing_explicit])
    else:
        if args.delegations_dir is not None:
            delegations_dir = (
                args.delegations_dir
                if args.delegations_dir.is_absolute()
                else project_root / args.delegations_dir
            )
        else:
            rel = block.get("delegations_dir", DEFAULT_DELEGATIONS_DIR)
            if not isinstance(rel, str) or not rel.strip():
                return _input_error(["config `delegation_budget.delegations_dir` must be a non-empty string"])
            delegations_dir = project_root / rel
        contract_paths = sorted(delegations_dir.glob("*.json")) if delegations_dir.is_dir() else []

    if not contract_paths:
        if required:
            reason = (
                "NO_CONTRACTS_FOUND: delegation budget contracts are required but none "
                "were found — every delegated computation / verification workstream "
                "needs a budget contract BEFORE dispatch (fail-closed)"
            )
            print(f"ERROR: {reason}", file=sys.stderr)
            return _emit(
                status="not_converged",
                exit_code=1,
                reasons=[reason],
                report_status={"delegations": _contract_summary([reason], parse_ok=True)},
                meta=base_meta,
                out_json=args.out_json,
            )
        print(f"- Notes: `{args.notes}`", file=sys.stderr)
        print("- Gate: SKIP (no delegation contracts found and none required; nothing evaluated)", file=sys.stderr)
        return 0

    report_status: dict[str, Any] = {}
    reasons: list[str] = []
    for path in contract_paths:
        try:
            key = str(path.resolve().relative_to(project_root))
        except ValueError:
            key = str(path)
        try:
            contract = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError) as e:
            issue = f"UNREADABLE_CONTRACT: {e}"
            report_status[key] = _contract_summary([issue], parse_ok=False)
            reasons.append(f"{key}: {issue}")
            continue
        issues = _validate_contract(contract)
        report_status[key] = _contract_summary(issues, parse_ok=True)
        reasons.extend(f"{key}: {issue}" for issue in issues)

    for key, summary in report_status.items():
        marker = "ok" if summary["verdict"] == "ready" else "FAIL"
        print(f"- Contract {key}: {marker} ({summary['blocking_count']} issue(s))", file=sys.stderr)
    for reason in reasons:
        print(f"  * {reason}", file=sys.stderr)

    if reasons:
        print(
            "[gate] Fail-closed: delegation budget contract(s) incomplete. Fill every "
            "required budget field (tolerance ceiling + anchor, time box, attempt cap, "
            "scope negative list, dry-run peak RSS + heap cap) before dispatch.",
            file=sys.stderr,
        )
        return _emit(
            status="not_converged",
            exit_code=1,
            reasons=reasons,
            report_status=report_status,
            meta=base_meta,
            out_json=args.out_json,
        )

    return _emit(
        status="converged",
        exit_code=0,
        reasons=[],
        report_status=report_status,
        meta=base_meta,
        out_json=args.out_json,
    )


if __name__ == "__main__":
    sys.exit(main())
