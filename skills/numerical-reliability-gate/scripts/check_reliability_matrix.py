#!/usr/bin/env python3
"""Check a numerical_reliability_matrix_v1.json against the machine-readable rules of its contract.

Why this checker exists: an executing agent's default drift is to keep refining a
number long after it is accurate enough for its use, or to hold a correct result
back behind a check far stricter than anything the result is used for. The gate's
G0 rule fixes the stopping point before any refinement: every gated quantity
records the accuracy its use requires, and an error budget naming the dominant
error source. This script checks that those records exist, are well formed, and
are consistent with the verdict: a quantity is foldable (`reliable`) only when its
dominant error is at or below the accuracy its use requires.

It also checks the matrix bookkeeping the contract states (verdict vocabulary,
unique ids, the summary counts, and that only `reliable` rows carry a recorded
value). It does not re-judge G1-G10 evidence; that judgement stays with the gate
and its reviewers.

A dominant error far below the required accuracy (more than three orders of
magnitude) is reported as a warning: the refinement went past what the result
needed. Warnings never change the exit status.

Exit status: 0 no findings; 1 findings; 2 the file is unreadable, is not one
unambiguous JSON object, or is not a version-1 matrix.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

VERDICTS = frozenset(
    {
        "reliable",
        "mirage",
        "unconverged",
        "method_disagreement",
        "fragile_method",
        "anchor_failed",
        "degenerate",
        "stale_artifact",
        "heterogeneous_series",
        "precondition_violated",
        "reference_mismatch",
        "circular_validation",
        "overclaimed_heuristic",
    }
)
ACCURACY_KINDS = frozenset({"absolute", "relative"})
ACCURACY_SOURCES = frozenset({"display", "downstream_sensitivity", "comparison_uncertainty"})

# A dominant error this many times smaller than the required accuracy is reported
# as refinement carried past what the result needed.
OVER_REFINEMENT_FACTOR = 1000.0


class InputError(Exception):
    """The input cannot be judged at all (exit status 2)."""


def _reject_constant(name: str) -> Any:
    raise InputError(f"non-finite JSON constant {name} is not allowed")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise InputError(f"duplicate JSON object key {key!r}")
        out[key] = value
    return out


def load_matrix(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise InputError(f"cannot read {path}: {exc}") from exc
    try:
        data = json.loads(text, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except json.JSONDecodeError as exc:
        raise InputError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise InputError("the matrix file must hold one JSON object")
    keys = list(data)
    if not keys or keys[0] != "schema_version":
        raise InputError("`schema_version` must be the first field")
    version = data["schema_version"]
    if isinstance(version, bool) or version != SCHEMA_VERSION:
        raise InputError(f"`schema_version` must be {SCHEMA_VERSION} (got {version!r})")
    if not isinstance(data.get("matrix"), list):
        raise InputError("`matrix` must be a list of rows")
    return data


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_text(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != "" and "\n" not in value


def _check_required_accuracy(row_id: str, row: dict[str, Any], findings: list[dict[str, str]]) -> dict[str, Any] | None:
    acc = row.get("required_accuracy")
    if acc is None:
        findings.append(_finding(row_id, "MISSING_REQUIRED_ACCURACY",
                                 "`required_accuracy` is required on every row: state the accuracy the quantity's use requires before any refinement"))
        return None
    problems = []
    if not isinstance(acc, dict):
        problems.append("must be an object")
    else:
        if acc.get("kind") not in ACCURACY_KINDS:
            problems.append(f"`kind` must be one of {sorted(ACCURACY_KINDS)}")
        if not _is_number(acc.get("value")) or acc.get("value") <= 0:
            problems.append("`value` must be a finite positive number")
        if acc.get("source") not in ACCURACY_SOURCES:
            problems.append(f"`source` must be one of {sorted(ACCURACY_SOURCES)} (what the method can achieve is never a source)")
        if not _is_text(acc.get("basis")):
            problems.append("`basis` must be a non-empty one-line string")
        extra = set(acc) - {"kind", "value", "source", "basis"}
        if extra:
            problems.append(f"unknown field(s) {sorted(extra)}")
    if problems:
        findings.append(_finding(row_id, "INVALID_REQUIRED_ACCURACY", "; ".join(problems)))
        return None
    return acc


def _check_error_budget(row_id: str, row: dict[str, Any], findings: list[dict[str, str]]) -> list[dict[str, Any]] | None:
    budget = row.get("error_budget")
    if budget is None:
        findings.append(_finding(row_id, "MISSING_ERROR_BUDGET",
                                 "`error_budget` is required on every row: list the error sources with estimated sizes and name the dominant one"))
        return None
    if not isinstance(budget, list) or not budget:
        findings.append(_finding(row_id, "INVALID_ERROR_BUDGET", "`error_budget` must be a non-empty list"))
        return None
    problems = []
    for index, entry in enumerate(budget):
        where = f"entry {index}"
        if not isinstance(entry, dict):
            problems.append(f"{where} must be an object")
            continue
        if not _is_text(entry.get("source")):
            problems.append(f"{where}: `source` must be a non-empty one-line string")
        estimate = entry.get("estimate", "missing")
        if estimate is not None and (not _is_number(estimate) or estimate < 0):
            problems.append(f"{where}: `estimate` must be a finite non-negative number or null")
        if not isinstance(entry.get("dominant"), bool):
            problems.append(f"{where}: `dominant` must be true or false")
        extra = set(entry) - {"source", "estimate", "dominant"}
        if extra:
            problems.append(f"{where}: unknown field(s) {sorted(extra)}")
    if problems:
        findings.append(_finding(row_id, "INVALID_ERROR_BUDGET", "; ".join(problems)))
        return None
    dominant = [entry for entry in budget if entry["dominant"]]
    if len(dominant) != 1:
        findings.append(_finding(row_id, "DOMINANT_SOURCE_COUNT",
                                 f"exactly one `error_budget` entry must be marked dominant (found {len(dominant)})"))
        return None
    top = dominant[0]["estimate"]
    if top is not None:
        larger = [entry["source"] for entry in budget
                  if not entry["dominant"] and entry["estimate"] is not None and entry["estimate"] > top]
        if larger:
            findings.append(_finding(row_id, "DOMINANT_NOT_LARGEST",
                                     f"the source marked dominant is smaller than {larger}; refinement must go to the largest error source"))
            return None
    return budget


def _finding(row_id: str, code: str, message: str) -> dict[str, str]:
    return {"id": row_id, "code": code, "message": message}


def check(data: dict[str, Any]) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    findings: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    seen: set[str] = set()
    reliable_ids: list[str] = []
    other_ids: list[str] = []

    for index, row in enumerate(data["matrix"]):
        if not isinstance(row, dict):
            findings.append(_finding(f"row {index}", "INVALID_ROW", "each matrix row must be an object"))
            continue
        row_id = row.get("id")
        if not _is_text(row_id):
            findings.append(_finding(f"row {index}", "INVALID_ID", "`id` must be a non-empty one-line string"))
            row_id = f"row {index}"
        elif row_id in seen:
            findings.append(_finding(row_id, "DUPLICATE_ID", "row ids must be unique"))
        seen.add(row_id)

        verdict = row.get("verdict")
        if verdict not in VERDICTS:
            findings.append(_finding(row_id, "INVALID_VERDICT", f"`verdict` must be one of the contract's verdicts (got {verdict!r})"))
            verdict = None
        reliable = verdict == "reliable"
        (reliable_ids if reliable else other_ids).append(row_id)

        if reliable and row.get("recorded_value") is None:
            findings.append(_finding(row_id, "RECORDED_VALUE_MISMATCH", "a `reliable` row must carry its `recorded_value`"))
        if verdict is not None and not reliable and row.get("recorded_value") is not None:
            findings.append(_finding(row_id, "RECORDED_VALUE_MISMATCH",
                                     "only a `reliable` row may carry a `recorded_value`; every other row stays a labeled candidate"))

        accuracy = _check_required_accuracy(row_id, row, findings)
        budget = _check_error_budget(row_id, row, findings)
        if accuracy is None or budget is None:
            continue
        dominant = next(entry for entry in budget if entry["dominant"])
        unestimated = [entry["source"] for entry in budget if entry["estimate"] is None]
        if reliable and unestimated:
            findings.append(_finding(row_id, "RELIABLE_WITH_UNESTIMATED_ERROR",
                                     f"a `reliable` row needs a numeric estimate for every error source (unestimated: {unestimated})"))
            continue
        if dominant["estimate"] is None:
            continue
        if reliable and dominant["estimate"] > accuracy["value"]:
            findings.append(_finding(row_id, "DOMINANT_ABOVE_REQUIRED_ACCURACY",
                                     f"dominant error {dominant['estimate']} ({dominant['source']}) exceeds the required accuracy "
                                     f"{accuracy['value']}; the row is `unconverged`, and the next refinement goes to that source"))
        elif reliable and dominant["estimate"] * OVER_REFINEMENT_FACTOR < accuracy["value"]:
            warnings.append(_finding(row_id, "REFINED_PAST_REQUIRED_ACCURACY",
                                     f"dominant error {dominant['estimate']} is more than {OVER_REFINEMENT_FACTOR:g} times below the "
                                     f"required accuracy {accuracy['value']}: refinement went past what the result needed"))

    total = data.get("total")
    if total is not None and total != len(data["matrix"]):
        findings.append(_finding("matrix", "COUNT_MISMATCH", f"`total` is {total!r} but the matrix has {len(data['matrix'])} rows"))
    reliable_count = data.get("reliable")
    if reliable_count is not None and reliable_count != len(reliable_ids):
        findings.append(_finding("matrix", "COUNT_MISMATCH", f"`reliable` is {reliable_count!r} but {len(reliable_ids)} rows are reliable"))
    not_reliable = data.get("not_reliable")
    if not_reliable is not None and (not isinstance(not_reliable, list) or sorted(map(str, not_reliable)) != sorted(other_ids)):
        findings.append(_finding("matrix", "COUNT_MISMATCH", "`not_reliable` must list exactly the ids whose verdict is not `reliable`"))
    return findings, warnings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("matrix", type=Path, help="path to numerical_reliability_matrix_v1.json")
    parser.add_argument("--json", action="store_true", help="print the result as JSON")
    args = parser.parse_args(argv)

    try:
        data = load_matrix(args.matrix)
    except InputError as exc:
        if args.json:
            print(json.dumps({"result": "invalid_input", "error": str(exc), "findings": [], "warnings": []}, indent=2))
        else:
            print(f"[check_reliability_matrix] invalid input: {exc}", file=sys.stderr)
        return 2

    findings, warnings = check(data)
    if args.json:
        print(json.dumps({"result": "findings" if findings else "pass", "findings": findings, "warnings": warnings}, indent=2))
    else:
        for item in findings:
            print(f"FINDING {item['code']} [{item['id']}]: {item['message']}")
        for item in warnings:
            print(f"WARNING {item['code']} [{item['id']}]: {item['message']}")
        print("[check_reliability_matrix] " + ("FAIL" if findings else "OK"))
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
