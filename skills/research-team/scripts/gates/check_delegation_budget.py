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
    included (a supplied `<placeholder>` value is an unfilled template).
    The ONE deliberate exemption: values under a "_"-prefixed key are
    skipped, because those keys are documentation notes (the shipped
    template's `_note` fields describe the schema in prose that may contain
    angle-bracketed examples). No required or budget-bearing field is
    "_"-prefixed, so the exemption cannot hide an unfilled real field.
  - `tolerance_ceiling.anchor_note` must be a single line.
  - A delegations path that exists but is not a directory, a non-boolean
    `features.delegation_budget_gate` / `delegation_budget.required`
    config value, or a failed --out-json persistence are input errors
    (exit 2), never silent skips or passes.
  - `contract_status` keys are schema-safe slugs derived from each contract
    file stem (the shared schema restricts contract keys to
    `^[a-z][a-z0-9_]*$`); the contract's project-relative path is carried
    in the member summary's `source_path`.

Budget-exhaustion semantics (enforced as prose contract, see the
research-harness skill): when the time box or attempt cap is exhausted,
the workstream wraps up from the atomic results already flushed to disk —
it never voids the whole batch; abandoned approaches are recorded in the
failed-approaches ledger (`failed_approaches_v1`).

Machine verdict:
  Emits a `delegation_budget_gate_result_v1` JSON object on stdout (and to
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
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from delegation_budget_schema import (  # type: ignore
    build_delegation_budget_meta,
    validate_delegation_budget_result,
)
from team_config import (  # type: ignore
    build_team_config,
    config_candidate_paths,
    find_broken_config_path,
    find_config_path,
    load_config_object,
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


def _read_regular_file_text(path: Path) -> str:
    """Read a contract file without blocking on non-regular entries: a FIFO
    (or a symlink to one) named *.json would hang read_text() forever and
    leave preflight with no verdict at all. Open nonblocking, fstat-verify a
    regular file on the OPEN descriptor (no stat/open race), then read."""
    import stat as stat_module

    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    try:
        st = os.fstat(fd)
        if not stat_module.S_ISREG(st.st_mode):
            raise ValueError(
                f"not a regular file (mode {stat_module.filemode(st.st_mode)}) — refusing to read"
            )
        chunks: list[bytes] = []
        while True:
            chunk = os.read(fd, 1 << 16)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        os.close(fd)
    return b"".join(chunks).decode("utf-8")


def _paths_alias(candidate: Path, protected: Path) -> bool:
    """Return true for lexical/resolved aliases and existing hard links."""
    try:
        if candidate.resolve(strict=False) == protected.resolve(strict=False):
            return True
    except OSError:
        # samefile below still gives a descriptor-backed answer when both
        # entries exist. Any later path failure remains fail-closed at write.
        pass
    try:
        return os.path.samefile(candidate, protected)
    except (FileNotFoundError, OSError):
        return False


def _guard_output_path(path: Path, protected_inputs: set[Path]) -> None:
    try:
        resolved_output = path.resolve(strict=False)
    except OSError as e:
        raise ValueError(f"OUTPUT_TARGET_INVALID: cannot resolve --out-json {path}: {e}") from e

    ordered_inputs = sorted(protected_inputs, key=str)
    for protected in ordered_inputs:
        if _paths_alias(path, protected):
            raise ValueError(
                f"OUTPUT_ALIASES_INPUT: --out-json {path} aliases consumed input {protected}"
            )

    for protected in ordered_inputs:
        try:
            resolved_protected = protected.resolve(strict=False)
        except OSError as e:
            raise ValueError(
                f"OUTPUT_TARGET_INVALID: cannot resolve protected input {protected}: {e}"
            ) from e
        if resolved_protected in resolved_output.parents:
            raise ValueError(
                f"OUTPUT_NESTED_UNDER_INPUT: --out-json {path} is nested under consumed "
                f"input slot {protected}"
            )
        if resolved_output in resolved_protected.parents:
            raise ValueError(
                f"OUTPUT_ANCESTOR_OF_INPUT: --out-json {path} would occupy an ancestor "
                f"of consumed input slot {protected}"
            )

    # Atomic replacement does not follow a leaf symlink, but accepting one is
    # surprising and would weaken the explicit no-alias contract. Reject every
    # existing symlink and every non-regular output target deterministically.
    import stat as stat_module

    try:
        st = path.lstat()
    except FileNotFoundError:
        return
    if stat_module.S_ISLNK(st.st_mode):
        raise ValueError("OUTPUT_TARGET_INVALID: --out-json target must not be a symlink")
    if not stat_module.S_ISREG(st.st_mode):
        raise ValueError(
            "OUTPUT_TARGET_INVALID: --out-json target is not a regular file "
            f"(mode {stat_module.filemode(st.st_mode)})"
        )


def _write_atomic_result(path: Path, text: str, protected_inputs: set[Path]) -> None:
    """Persist a verdict by same-directory temporary file + atomic replace.

    No consumed input may be the output target, including via a symlink or
    hard link. The input guard is repeated immediately before replace so a
    target swap during the write cannot turn persistence into evidence
    truncation. A failed write/replace leaves the old output intact.
    """
    _guard_output_path(path, protected_inputs)
    path.parent.mkdir(parents=True, exist_ok=True)
    _guard_output_path(path, protected_inputs)

    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    temporary: Path | None = Path(temporary_name)
    try:
        data = text.encode("utf-8")
        while data:
            written = os.write(fd, data)
            if written <= 0:
                raise OSError("atomic verdict write made no progress")
            data = data[written:]
        os.fsync(fd)
        os.fchmod(fd, 0o644)
        os.close(fd)
        fd = -1

        _guard_output_path(path, protected_inputs)
        os.replace(temporary_name, path)
        temporary = None
    finally:
        if fd >= 0:
            os.close(fd)
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """json.loads is silently last-wins on duplicate keys — an earlier
    placeholder value would be discarded before the placeholder sweep ever
    sees it, and different parsers disagree on which duplicate wins."""
    obj: dict[str, Any] = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError(f"duplicate key {key!r} in contract JSON")
        obj[key] = value
    return obj


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
    """Derive a contract_status key that satisfies the shared schema's key
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
    # int is exact and always finite — never route it through float
    # (math.isfinite(10**400) raises OverflowError, which would crash the
    # gate on a valid, if enormous, integer instead of validating the field).
    if isinstance(value, int):
        return value > 0
    if isinstance(value, float):
        return math.isfinite(value) and value > 0
    return False


def _is_positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _check_required_string(
    contract: dict[str, Any], key: str, label: str, issues: list[str]
) -> None:
    value = contract.get(key)
    if not isinstance(value, str) or not value.strip():
        issues.append(f"{label}: `{key}` must be a non-empty string")
    elif value.splitlines() != [value]:
        issues.append(f"{label}: `{key}` must be a single line with no line-break characters")


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
        elif anchor.splitlines() != [anchor]:
            # One line means NO line-boundary character at all \u2014 embedded or
            # terminal. Comparing splitlines() against [anchor] covers exactly
            # Python's full boundary set (LF, CR, VT, FF, FS, GS, RS, NEL,
            # U+2028, U+2029): any embedded boundary yields multiple elements,
            # and a terminal one makes the single element differ from anchor.
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
    contract_status: dict[str, Any],
    meta: dict[str, Any],
    out_json: Path | None,
    protected_inputs: set[Path],
) -> int:
    result: dict[str, Any] = {
        "status": status,
        "exit_code": exit_code,
        "reasons": reasons,
        "contract_status": contract_status,
        "meta": meta,
    }
    schema_errors = validate_delegation_budget_result(result)
    if schema_errors:
        result = {
            "status": "input_error",
            "exit_code": 2,
            "reasons": ["schema validation failed", *schema_errors],
            "contract_status": {k: {**v, "parse_ok": False} for k, v in contract_status.items()},
            "meta": meta,
        }
        exit_code = 2
        # Defense in depth: if the fallback itself would still be
        # schema-invalid (e.g. a key that violates the contract key pattern
        # leaked in), collapse to a minimal, always-valid contract_status
        # rather than emitting invalid JSON on the error path.
        if validate_delegation_budget_result(result):
            result["contract_status"] = {
                "gate": _contract_summary(list(result["reasons"]), parse_ok=False)
            }
            # Post-collapse check, same discipline as the persistence-failure
            # path: never print an unvalidated fallback silently. (When the
            # schema SSOT itself is unavailable nothing can validate; the
            # exit code stays the load-bearing signal.)
            for err in validate_delegation_budget_result(result):
                result["reasons"].append(f"fallback verdict validation: {err}")

    # Persist FIRST, then print: the stdout verdict and the process exit code
    # must never disagree. On persistence failure, the single stdout verdict
    # is an input_error (exit 2), not the original verdict.
    if out_json is not None:
        try:
            _write_atomic_result(
                out_json,
                json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                protected_inputs,
            )
        except (OSError, ValueError) as e:
            reason = f"OUTPUT_PERSISTENCE_ERROR: failed to persist machine verdict to --out-json {out_json}: {e}"
            print(f"ERROR: {reason}", file=sys.stderr)
            err_result = {
                "status": "input_error",
                "exit_code": 2,
                "reasons": [reason],
                "contract_status": {"gate": _contract_summary([reason], parse_ok=False)},
                "meta": meta,
            }
            # Same discipline as the schema-fallback path: never print an
            # unvalidated fallback. (If the schema SSOT itself is unavailable
            # no emission can validate; the exit code stays the load-bearing
            # signal and the reasons carry the diagnostics.)
            for err in validate_delegation_budget_result(err_result):
                err_result["reasons"].append(f"fallback verdict validation: {err}")
            print(json.dumps(err_result, ensure_ascii=False, sort_keys=True))
            return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return exit_code


class _CliInputError(Exception):
    """Raised instead of argparse's SystemExit so malformed CLI input still
    produces one schema-valid input_error machine verdict (--help keeps its
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
            status="input_error",
            exit_code=2,
            reasons=[reason],
            contract_status={"gate": _contract_summary([reason], parse_ok=False)},
            meta=build_delegation_budget_meta(),
            out_json=None,
            protected_inputs=set(),
        )
    base_meta = build_delegation_budget_meta()
    if args.tag.strip():
        base_meta["tag"] = args.tag.strip()

    protected_inputs = {args.notes.resolve(strict=False)}

    def _input_error(reasons: list[str]) -> int:
        for r in reasons:
            print(f"ERROR: {r}", file=sys.stderr)
        return _emit(
            status="input_error",
            exit_code=2,
            reasons=reasons,
            contract_status={"delegations": _contract_summary(reasons, parse_ok=False)},
            meta=base_meta,
            out_json=args.out_json,
            protected_inputs=protected_inputs,
        )

    try:
        return _run(args, base_meta, _input_error, protected_inputs)
    except Exception as e:
        # Fail-closed: an unforeseen crash must still leave a machine-readable
        # input_error verdict on stdout (exit 2), not a bare traceback whose
        # missing verdict a caller could mistake for "gate not run".
        return _input_error([f"unexpected gate error: {type(e).__name__}: {e}"])


def _run(
    args: argparse.Namespace,
    base_meta: dict[str, Any],
    _input_error: Any,
    protected_inputs: set[Path],
) -> int:
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
        protected_inputs.add(env_path.resolve(strict=False))
        if not env_path.is_file():
            return _input_error(
                [
                    f"RESEARCH_TEAM_CONFIG points to a missing config file: {env_path} "
                    "(fail-closed: a stale override would silently suppress the project config)"
                ]
            )
    protected_inputs.update(
        path.resolve(strict=False) for path in config_candidate_paths(args.notes)
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
    if config_path is not None:
        # Resolve ONCE at discovery: both the strict read below and the
        # default project root derive from this resolved path, so retargeting
        # a config symlink between the two cannot bind snapshot A's flags to
        # tree B's (possibly empty) delegations directory.
        config_path = config_path.resolve()
        protected_inputs.add(config_path)
    strict_raw: dict[str, Any] | None = None
    if config_path is not None:
        # Strict validation of the control input itself: the lenient loader's
        # last-wins duplicate keys or replacement-decoded UTF-8 could silently
        # flip delegation_budget_gate / required.
        try:
            strict_raw = load_config_object(config_path)
        except ValueError as e:
            return _input_error(
                [
                    f"team config failed strict validation: {e} — {config_path} "
                    "(fail-closed: fix the config before running the delegation budget gate)"
                ]
            )

    # Build the merged config from the SAME strict snapshot — a second,
    # lenient read of the file would reopen a swap-between-reads hole.
    cfg = build_team_config(config_path, strict_raw)
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
    elif config_path is not None:
        # Already resolved above — no fresh symlink resolution here.
        project_root = config_path.parent
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

    # Contract entries are carried as (display_name, resolved_path) pairs:
    # each path is resolved ONCE at discovery, and enumeration, provenance
    # (source_path) and the read all use that same resolved target — a
    # symlink retargeted after discovery cannot substitute a different
    # contract for the one that was selected.
    if args.contract:
        contract_entries: list[tuple[str, Path]] = []
        missing_explicit: list[str] = []
        for p in args.contract:
            abs_p = p if p.is_absolute() else (project_root / p)
            resolved = abs_p.resolve()
            protected_inputs.add(resolved)
            if not resolved.is_file():
                missing_explicit.append(str(abs_p))
            else:
                contract_entries.append((abs_p.name, resolved))
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
        # A dangling symlink anywhere on the lexical path (the leaf OR an
        # ancestor, e.g. team -> missing) is a broken setup, not an absent
        # directory. `lexical_dir` keeps the pre-resolution path so this
        # walk can be repeated if resolution/listing races.
        lexical_dir = delegations_dir
        protected_inputs.add(lexical_dir.resolve(strict=False))

        def _dangling_component() -> Path | None:
            for component in (lexical_dir, *lexical_dir.parents):
                if component.is_symlink() and not component.exists():
                    return component
            return None

        dangling = _dangling_component()
        if dangling is not None:
            return _input_error(
                [f"delegations path traverses a dangling symlink: {dangling}"]
            )
        # Bind the scan directory BEFORE enumeration: listing a symlinked
        # directory and resolving entries afterwards would let a retarget
        # between the two substitute a different contract set for the one
        # just enumerated.
        resolved_dir = lexical_dir.resolve()
        # Enumerate with os.listdir directly: Path.glob suppresses OSError,
        # and Path.exists()/is_dir() swallow ENOTDIR on nested bad paths
        # (e.g. <file>/subdir), which would silently SKIP. Only a genuinely
        # absent directory is "no delegations"; every other failure —
        # NotADirectoryError, PermissionError, ENOTDIR — is an input error.
        try:
            names: list[str] | None = sorted(os.listdir(resolved_dir))
        except FileNotFoundError:
            # ENOENT here can mean the symlink went live -> dangling between
            # the lexical check and resolve()/listdir. Re-run the walk: a now
            # dangling component is a broken setup (input error); only a
            # genuinely absent non-symlink directory is "no delegations".
            dangling = _dangling_component()
            if dangling is not None:
                return _input_error(
                    [f"delegations path traverses a dangling symlink: {dangling}"]
                )
            names = None
        except OSError as e:
            return _input_error([f"cannot read delegations directory {resolved_dir}: {e}"])
        contract_entries = (
            []
            if names is None
            else [(n, (resolved_dir / n).resolve()) for n in names if n.endswith(".json")]
        )

    protected_inputs.update(path for _, path in contract_entries)

    if not contract_entries:
        if required:
            reason = (
                "NO_CONTRACTS_FOUND: delegation budget contracts are required but none "
                "were found — every delegated computation / verification workstream "
                "needs a budget contract BEFORE dispatch (fail-closed)"
            )
            print(f"ERROR: {reason}", file=sys.stderr)
            return _emit(
                status="fail",
                exit_code=1,
                reasons=[reason],
                contract_status={"delegations": _contract_summary([reason], parse_ok=True)},
                meta=base_meta,
                out_json=args.out_json,
                protected_inputs=protected_inputs,
            )
        print(f"- Notes: `{args.notes}`", file=sys.stderr)
        print("- Gate: SKIP (no delegation contracts found and none required; nothing evaluated)", file=sys.stderr)
        return 0

    contract_status: dict[str, Any] = {}
    reasons: list[str] = []
    taken_keys: set[str] = set()
    for entry_name, path in contract_entries:
        # `path` is the once-resolved target; provenance records it (relative
        # to the project root when possible) and the read below uses it too.
        try:
            source_path = str(path.relative_to(project_root))
        except ValueError:
            source_path = str(path)
        key = _schema_safe_key(Path(entry_name), taken_keys)
        try:
            # parse_constant: Python's json accepts nonstandard NaN/Infinity
            # literals that standard JSON consumers reject — a contract other
            # tools cannot parse must not pass a fail-closed gate.
            contract = json.loads(
                _read_regular_file_text(path),
                parse_constant=_reject_json_constant,
                object_pairs_hook=_reject_duplicate_keys,
            )
        except (ValueError, OSError, UnicodeDecodeError) as e:
            issue = f"UNREADABLE_CONTRACT: {e}"
            contract_status[key] = _contract_summary([issue], parse_ok=False, source_path=source_path)
            reasons.append(f"{source_path}: {issue}")
            continue
        issues = _validate_contract(contract)
        contract_status[key] = _contract_summary(issues, parse_ok=True, source_path=source_path)
        reasons.extend(f"{source_path}: {issue}" for issue in issues)

    for key, summary in contract_status.items():
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
            status="fail",
            exit_code=1,
            reasons=reasons,
            contract_status=contract_status,
            meta=base_meta,
            out_json=args.out_json,
            protected_inputs=protected_inputs,
        )

    return _emit(
        status="pass",
        exit_code=0,
        reasons=[],
        contract_status=contract_status,
        meta=base_meta,
        out_json=args.out_json,
        protected_inputs=protected_inputs,
    )


if __name__ == "__main__":
    sys.exit(main())
