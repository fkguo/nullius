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

Strictness notes (each closes a fail-open hole):
  - `contract_version` must be the exact integer 1: True / 1.0 do not pass.
  - The placeholder sweep covers the WHOLE contract, optional fields
    included (a supplied `<placeholder>` value is an unfilled template);
    only "_"-prefixed documentation keys are exempt.
  - `tolerance_ceiling.anchor_note` must be a single line.
  - A delegations path that exists but is not a directory, a non-boolean
    `features.delegation_budget_gate` / `delegation_budget.required`
    config value, or a failed --out-json persistence are input errors
    (exit 2), never silent skips or passes.
  - `report_status` keys are schema-safe slugs derived from each contract
    file stem (the shared schema restricts member keys to
    `^[a-z][a-z0-9_]*$`); the contract's project-relative path is carried
    in the member summary's `source_path`.

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
import os
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from convergence_schema import (  # type: ignore
    build_gate_meta,
    validate_convergence_result,
)
from team_config import (  # type: ignore
    find_broken_config_path,
    find_config_path,
    load_config_object,
    load_team_config,
)

SUPPORTED_CONTRACT_VERSION = 1
DEFAULT_DELEGATIONS_DIR = "team/delegations"

# An unfilled template placeholder is a string whose entire trimmed value is
# an angle-bracketed hint like "<one line: ...>". Substring matching is NOT
# used: legitimate prose such as "error < 1% and > 0" must not false-positive.
_PLACEHOLDER_RE = re.compile(r"^<.*>$", re.DOTALL)


def _is_placeholder(value: str) -> bool:
    return bool(_PLACEHOLDER_RE.match(value.strip()))


def _reject_json_constant(token: str) -> Any:
    raise ValueError(f"nonstandard JSON constant {token!r} is not valid contract JSON")


def _scan_placeholders(node: Any, path: str, issues: list[str]) -> None:
    """Fail-closed sweep for unfilled template placeholders anywhere in the
    contract — optional fields included: a supplied value that is still a
    placeholder is an unfilled template, not a filled contract. Keys starting
    with "_" (documentation notes) are skipped."""
    if isinstance(node, str):
        if _is_placeholder(node):
            issues.append(
                f"PLACEHOLDER_VALUE: `{path}` still carries the template placeholder {node.strip()!r}"
            )
    elif isinstance(node, dict):
        for key, value in node.items():
            if isinstance(key, str) and key.startswith("_"):
                continue
            _scan_placeholders(value, f"{path}.{key}" if path else str(key), issues)
    elif isinstance(node, list):
        for idx, value in enumerate(node):
            _scan_placeholders(value, f"{path}[{idx}]", issues)


def _schema_safe_key(path: Path, taken: set[str]) -> str:
    """Derive a report_status key that satisfies the shared schema's member key
    pattern (^[a-z][a-z0-9_]*$) from the contract file stem; the full relative
    path is carried in the member summary's `source_path` instead."""
    stem = re.sub(r"[^a-z0-9_]", "_", path.stem.lower())
    stem = stem.lstrip("_0123456789") or "contract"
    if not re.fullmatch(r"[a-z][a-z0-9_]*", stem):
        stem = "contract"
    key = stem
    counter = 2
    while key in taken:
        key = f"{stem}_{counter}"
        counter += 1
    taken.add(key)
    return key


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


def _validate_contract(contract: Any) -> list[str]:
    """Return the fail-closed issue list for one parsed contract object."""
    if not isinstance(contract, dict):
        return ["UNREADABLE_CONTRACT: top-level JSON value must be an object"]

    issues: list[str] = []

    version = contract.get("contract_version")
    # Strict identity, not Python equality: True == 1 and 1.0 == 1 must NOT
    # pass as version 1.
    if (
        not isinstance(version, int)
        or isinstance(version, bool)
        or version != SUPPORTED_CONTRACT_VERSION
    ):
        issues.append(
            "UNSUPPORTED_CONTRACT_VERSION: `contract_version` must be the integer "
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
        elif any(ch in anchor for ch in "\n\r\v\f\x85\u2028\u2029"):
            # Reject ANY Unicode line-boundary character, terminal ones
            # included ("x\n".splitlines() has length 1, so a splitlines
            # count alone would let a trailing separator through).
            issues.append(
                "MISSING_TOLERANCE_ANCHOR: `tolerance_ceiling.anchor_note` must be a "
                "single line with no line-break characters — one auditable sentence, not an essay"
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

    # Whole-contract placeholder sweep, optional fields included.
    _scan_placeholders(contract, "", issues)

    return issues


def _contract_summary(
    issues: list[str], *, parse_ok: bool, source_path: str | None = None
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "verdict": "ready" if parse_ok and not issues else ("needs_revision" if parse_ok else "unknown"),
        "blocking_count": len(issues),
        "parse_ok": parse_ok,
    }
    if source_path is not None:
        out["source_path"] = source_path
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
        # Defense in depth: if the fallback itself would still be
        # schema-invalid (e.g. a key that violates the member key pattern
        # leaked in), collapse to a minimal, always-valid report_status
        # rather than emitting invalid JSON on the error path.
        if validate_convergence_result(result):
            result["report_status"] = {
                "gate": _contract_summary(list(result["reasons"]), parse_ok=False)
            }
            # Post-collapse check, same discipline as the persistence-failure
            # path: never print an unvalidated fallback silently. (When the
            # schema SSOT itself is unavailable nothing can validate; the
            # exit code stays the load-bearing signal.)
            for err in validate_convergence_result(result):
                result["reasons"].append(f"fallback verdict validation: {err}")

    # Persist FIRST, then print: the stdout verdict and the process exit code
    # must never disagree. On persistence failure, the single stdout verdict
    # is a parse_error (exit 2), not the original verdict.
    if out_json is not None:
        try:
            out_json.parent.mkdir(parents=True, exist_ok=True)
            out_json.write_text(
                json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        except OSError as e:
            reason = f"failed to persist machine verdict to --out-json {out_json}: {e}"
            print(f"ERROR: {reason}", file=sys.stderr)
            err_result = {
                "status": "parse_error",
                "exit_code": 2,
                "reasons": [reason],
                "report_status": {"gate": _contract_summary([reason], parse_ok=False)},
                "meta": meta,
            }
            # Same discipline as the schema-fallback path: never print an
            # unvalidated fallback. (If the schema SSOT itself is unavailable
            # no emission can validate; the exit code stays the load-bearing
            # signal and the reasons carry the diagnostics.)
            for err in validate_convergence_result(err_result):
                err_result["reasons"].append(f"fallback verdict validation: {err}")
            print(json.dumps(err_result, ensure_ascii=False, sort_keys=True))
            return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return exit_code


class _CliInputError(Exception):
    """Raised instead of argparse's SystemExit so malformed CLI input still
    produces one schema-valid parse_error machine verdict (--help keeps its
    normal exit-0 behavior)."""


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> Any:  # type: ignore[override]
        raise _CliInputError(message)

    def exit(self, status: int = 0, message: str | None = None) -> Any:  # type: ignore[override]
        # --help exits 0 normally; any nonzero argparse exit must become a
        # machine verdict, even if a future argparse routes an error through
        # exit() instead of error().
        if status:
            raise _CliInputError(message or f"argument parsing failed (status {status})")
        super().exit(status, message)


def _parse_args() -> argparse.Namespace:
    ap = _Parser(description="Delegation budget contract gate (fail-closed)")
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
    try:
        args = _parse_args()
    except _CliInputError as e:
        reason = f"invalid command line: {e}"
        print(f"ERROR: {reason}", file=sys.stderr)
        return _emit(
            status="parse_error",
            exit_code=2,
            reasons=[reason],
            report_status={"gate": _contract_summary([reason], parse_ok=False)},
            meta=build_gate_meta("delegation_budget"),
            out_json=None,
        )
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

    # Fail-closed config loading: load_team_config silently falls back to
    # defaults when a config file exists but cannot be parsed — for this gate
    # that would be fail-open (a broken config carrying required=true or a
    # custom delegations_dir would silently SKIP). Detect that case first.
    # A RESEARCH_TEAM_CONFIG env override pointing at a missing file is the
    # same hazard: find_config_path returns None WITHOUT falling back to
    # local discovery, so the project's real config would be ignored.
    env_override = os.environ.get("RESEARCH_TEAM_CONFIG", "").strip()
    if env_override:
        env_path = Path(env_override)
        if not env_path.is_absolute():
            env_path = Path.cwd() / env_path
        if not env_path.is_file():
            return _input_error(
                [
                    f"RESEARCH_TEAM_CONFIG points to a missing config file: {env_path} "
                    "(fail-closed: a stale override would silently suppress the project config)"
                ]
            )
    broken_config = find_broken_config_path(args.notes)
    if broken_config is not None:
        return _input_error(
            [
                f"reserved team config path is present but not a regular file "
                f"(dangling symlink or directory): {broken_config} — fail-closed: "
                "fix or remove it before running the delegation budget gate"
            ]
        )
    config_path = find_config_path(args.notes)
    if config_path is not None and load_config_object(config_path) is None:
        return _input_error(
            [
                f"team config exists but could not be parsed as an object: {config_path} "
                "(fail-closed: fix the config before running the delegation budget gate)"
            ]
        )

    cfg = load_team_config(args.notes)
    # Strict feature-flag typing: a malformed flag must not silently disable a
    # fail-closed gate (e.g. "false"/""/0 in JSON where a boolean belongs).
    feats = cfg.data.get("features", {}) if isinstance(cfg.data, dict) else {}
    if isinstance(feats, dict) and "delegation_budget_gate" in feats:
        flag = feats["delegation_budget_gate"]
        if not isinstance(flag, bool):
            return _input_error(
                [f"config `features.delegation_budget_gate` must be a boolean (got {flag!r})"]
            )
    if not cfg.feature_enabled("delegation_budget_gate", default=True):
        print(f"- Notes: `{args.notes}`", file=sys.stderr)
        print("- Gate: SKIP (delegation_budget_gate disabled by config)", file=sys.stderr)
        return 0

    if args.project_root is not None:
        project_root = args.project_root.resolve()
        # A broken explicit root would make every relative scan path
        # FileNotFoundError and silently SKIP — fail closed instead.
        if not project_root.is_dir():
            return _input_error([f"--project-root is not an existing directory: {project_root}"])
    elif cfg.path is not None:
        project_root = cfg.path.resolve().parent
    else:
        project_root = args.notes.resolve().parent

    block = cfg.data.get("delegation_budget", {}) if isinstance(cfg.data, dict) else {}
    if not isinstance(block, dict):
        return _input_error(["config `delegation_budget` must be an object when present"])
    required_cfg = block.get("required", False)
    if not isinstance(required_cfg, bool):
        return _input_error(
            [f"config `delegation_budget.required` must be a boolean (got {required_cfg!r})"]
        )
    required = bool(args.require) or required_cfg

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
        # Enumerate with os.listdir directly: Path.glob suppresses OSError,
        # and Path.exists()/is_dir() swallow ENOTDIR on nested bad paths
        # (e.g. <file>/subdir), which would silently SKIP. Only a genuinely
        # absent directory is "no delegations"; every other failure —
        # NotADirectoryError, PermissionError, ENOTDIR — is an input error.
        try:
            names: list[str] | None = sorted(os.listdir(delegations_dir))
        except FileNotFoundError:
            # Genuinely absent is "no delegations" — but a dangling symlink
            # anywhere on the path (the leaf OR an ancestor, e.g.
            # team -> missing) is a broken setup, not an absent directory.
            for component in (delegations_dir, *delegations_dir.parents):
                if component.is_symlink() and not component.exists():
                    return _input_error(
                        [f"delegations path traverses a dangling symlink: {component}"]
                    )
            names = None
        except OSError as e:
            return _input_error([f"cannot read delegations directory {delegations_dir}: {e}"])
        contract_paths = (
            [] if names is None else [delegations_dir / n for n in names if n.endswith(".json")]
        )

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
    taken_keys: set[str] = set()
    for path in contract_paths:
        try:
            source_path = str(path.resolve().relative_to(project_root))
        except ValueError:
            source_path = str(path)
        key = _schema_safe_key(path, taken_keys)
        try:
            # parse_constant: Python's json accepts nonstandard NaN/Infinity
            # literals that standard JSON consumers reject — a contract other
            # tools cannot parse must not pass a fail-closed gate.
            contract = json.loads(
                path.read_text(encoding="utf-8"), parse_constant=_reject_json_constant
            )
        except (ValueError, OSError, UnicodeDecodeError) as e:
            issue = f"UNREADABLE_CONTRACT: {e}"
            report_status[key] = _contract_summary([issue], parse_ok=False, source_path=source_path)
            reasons.append(f"{source_path}: {issue}")
            continue
        issues = _validate_contract(contract)
        report_status[key] = _contract_summary(issues, parse_ok=True, source_path=source_path)
        reasons.extend(f"{source_path}: {issue}" for issue in issues)

    for key, summary in report_status.items():
        marker = "ok" if summary["verdict"] == "ready" else "FAIL"
        print(
            f"- Contract {summary.get('source_path', key)}: {marker} ({summary['blocking_count']} issue(s))",
            file=sys.stderr,
        )
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
