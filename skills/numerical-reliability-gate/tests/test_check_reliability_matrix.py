"""Behavior tests for the reliability-matrix checker (G0 required accuracy and error budget).

Each rule is exercised by a passing matrix and by a minimal edit that must make it
fail, so a rule that silently stopped firing would be caught. The contract's own
example matrix is also fed to the checker, so the contract and the checker cannot
drift apart.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

SKILL_DIR = Path(__file__).resolve().parents[1]
CHECKER = SKILL_DIR / "scripts" / "check_reliability_matrix.py"
CONTRACT = SKILL_DIR / "references" / "contract.md"


def _load():
    spec = importlib.util.spec_from_file_location("check_reliability_matrix", CHECKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


crm = _load()


def _row(**overrides):
    row = {
        "id": "q1",
        "quantity": "a fitted observable",
        "verdict": "reliable",
        "recorded_value": "1.92",
        "recorded_setting": "converged setting",
        "required_accuracy": {"kind": "absolute", "value": 0.02, "source": "display", "basis": "shown to two decimals"},
        "error_budget": [
            {"source": "integration grid", "estimate": 0.007, "dominant": True},
            {"source": "continuation order", "estimate": 0.001, "dominant": False},
        ],
    }
    row.update(overrides)
    return row


def _matrix(*rows):
    rows = list(rows) or [_row()]
    reliable = [r["id"] for r in rows if r.get("verdict") == "reliable"]
    return {
        "schema_version": 1,
        "total": len(rows),
        "reliable": len(reliable),
        "not_reliable": [r["id"] for r in rows if r.get("verdict") != "reliable"],
        "matrix": rows,
    }


def _codes(data):
    findings, _ = crm.check(data)
    return [f["code"] for f in findings]


def _run(tmp_path, data, *extra, raw=None):
    path = tmp_path / "numerical_reliability_matrix_v1.json"
    path.write_text(raw if raw is not None else json.dumps(data), encoding="utf-8")
    return subprocess.run([sys.executable, str(CHECKER), str(path), *extra], capture_output=True, text=True)


def test_well_formed_matrix_passes(tmp_path):
    unconverged = _row(
        id="q2",
        verdict="unconverged",
        recorded_value=None,
        recorded_setting=None,
        error_budget=[{"source": "seed dependence", "estimate": None, "dominant": True}],
    )
    proc = _run(tmp_path, _matrix(_row(), unconverged))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "OK" in proc.stdout


def test_missing_required_accuracy_fails(tmp_path):
    row = _row()
    del row["required_accuracy"]
    proc = _run(tmp_path, _matrix(row))
    assert proc.returncode == 1
    assert "MISSING_REQUIRED_ACCURACY" in proc.stdout


@pytest.mark.parametrize(
    "field,value",
    [
        ("source", "method_capability"),
        ("kind", "percent"),
        ("value", 0),
        ("value", -1.0),
        ("value", True),
        ("basis", ""),
        ("basis", "two\nlines"),
    ],
)
def test_malformed_required_accuracy_fails(field, value):
    row = _row()
    row["required_accuracy"] = dict(row["required_accuracy"], **{field: value})
    assert "INVALID_REQUIRED_ACCURACY" in _codes(_matrix(row))


def test_missing_error_budget_fails():
    row = _row()
    del row["error_budget"]
    assert "MISSING_ERROR_BUDGET" in _codes(_matrix(row))


@pytest.mark.parametrize(
    "budget",
    [
        [],
        [{"source": "grid", "estimate": -0.1, "dominant": True}],
        [{"source": "grid", "dominant": True}],
        [{"source": "grid", "estimate": 0.001, "dominant": "yes"}],
        [{"source": "", "estimate": 0.001, "dominant": True}],
        [{"source": "grid", "estimate": 0.001, "dominant": True, "note": "x"}],
    ],
)
def test_malformed_error_budget_fails(budget):
    assert "INVALID_ERROR_BUDGET" in _codes(_matrix(_row(error_budget=budget)))


def test_exactly_one_dominant_source():
    two = [
        {"source": "grid", "estimate": 0.001, "dominant": True},
        {"source": "order", "estimate": 0.001, "dominant": True},
    ]
    none = [{"source": "grid", "estimate": 0.001, "dominant": False}]
    assert "DOMINANT_SOURCE_COUNT" in _codes(_matrix(_row(error_budget=two)))
    assert "DOMINANT_SOURCE_COUNT" in _codes(_matrix(_row(error_budget=none)))


def test_dominant_must_be_the_largest_source():
    budget = [
        {"source": "integration precision", "estimate": 1e-9, "dominant": True},
        {"source": "basis truncation", "estimate": 4e-2, "dominant": False},
    ]
    assert "DOMINANT_NOT_LARGEST" in _codes(_matrix(_row(error_budget=budget)))


def test_reliable_requires_dominant_error_within_required_accuracy():
    above = [{"source": "grid", "estimate": 0.03, "dominant": True}]
    at = [{"source": "grid", "estimate": 0.02, "dominant": True}]
    assert "DOMINANT_ABOVE_REQUIRED_ACCURACY" in _codes(_matrix(_row(error_budget=above)))
    assert _codes(_matrix(_row(error_budget=at))) == []


def test_unconverged_row_may_carry_a_dominant_error_above_the_target():
    row = _row(verdict="unconverged", recorded_value=None, error_budget=[{"source": "grid", "estimate": 0.03, "dominant": True}])
    assert _codes(_matrix(row)) == []


def test_reliable_row_needs_every_error_estimated():
    budget = [
        {"source": "grid", "estimate": 0.001, "dominant": True},
        {"source": "model choice", "estimate": None, "dominant": False},
    ]
    assert "RELIABLE_WITH_UNESTIMATED_ERROR" in _codes(_matrix(_row(error_budget=budget)))


def test_refinement_far_past_the_target_warns_without_failing(tmp_path):
    budget = [{"source": "grid", "estimate": 1e-9, "dominant": True}]
    findings, warnings = crm.check(_matrix(_row(error_budget=budget)))
    assert findings == []
    assert [w["code"] for w in warnings] == ["REFINED_PAST_REQUIRED_ACCURACY"]
    proc = _run(tmp_path, _matrix(_row(error_budget=budget)))
    assert proc.returncode == 0
    assert "WARNING REFINED_PAST_REQUIRED_ACCURACY" in proc.stdout
    # A dominant error within three orders of the target is not flagged.
    close = [{"source": "grid", "estimate": 1e-4, "dominant": True}]
    assert crm.check(_matrix(_row(error_budget=close)))[1] == []


def test_only_reliable_rows_carry_a_recorded_value():
    assert "RECORDED_VALUE_MISMATCH" in _codes(_matrix(_row(recorded_value=None)))
    assert "RECORDED_VALUE_MISMATCH" in _codes(_matrix(_row(verdict="mirage")))


def test_verdict_vocabulary_and_unique_ids():
    assert "INVALID_VERDICT" in _codes(_matrix(_row(verdict="good_enough")))
    assert "DUPLICATE_ID" in _codes(_matrix(_row(), _row()))


def test_summary_counts_must_match_rows():
    data = _matrix(_row())
    data["total"] = 2
    assert "COUNT_MISMATCH" in _codes(data)
    data = _matrix(_row())
    data["not_reliable"] = ["q1"]
    assert "COUNT_MISMATCH" in _codes(data)


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        "[]",
        '{"matrix": [], "schema_version": 1}',
        '{"schema_version": 2, "matrix": []}',
        '{"schema_version": true, "matrix": []}',
        '{"schema_version": 1, "matrix": {}}',
        '{"schema_version": 1, "matrix": [], "matrix": []}',
        '{"schema_version": 1, "matrix": [{"id": "q", "estimate": NaN}]}',
    ],
)
def test_unjudgeable_input_exits_2(tmp_path, raw):
    proc = _run(tmp_path, None, raw=raw)
    assert proc.returncode == 2, proc.stdout + proc.stderr


def test_json_output_reports_findings(tmp_path):
    row = _row()
    del row["required_accuracy"]
    proc = _run(tmp_path, _matrix(row), "--json")
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert payload["result"] == "findings"
    assert payload["findings"][0]["code"] == "MISSING_REQUIRED_ACCURACY"


def _strip_line_comments(text: str) -> str:
    """Remove // comments outside JSON strings (the contract example is JSON with comments)."""
    out, in_string, escaped, i = [], False, False, 0
    while i < len(text):
        ch = text[i]
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if text.startswith("//", i):
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def test_contract_example_matrix_satisfies_the_checker():
    contract = CONTRACT.read_text(encoding="utf-8")
    block = re.search(r"```jsonc\n(.*?)\n```", contract, re.S)
    assert block, "contract.md must keep its jsonc example matrix"
    data = json.loads(_strip_line_comments(block.group(1)))
    findings, _ = crm.check(data)
    assert findings == [], findings
    # The example must actually exercise G0 on every row, including an unestimated source.
    rows = data["matrix"]
    assert all("required_accuracy" in r and "error_budget" in r for r in rows)
    assert any(e["estimate"] is None for r in rows for e in r["error_budget"])


def test_contract_example_with_g0_removed_fails():
    contract = CONTRACT.read_text(encoding="utf-8")
    data = json.loads(_strip_line_comments(re.search(r"```jsonc\n(.*?)\n```", contract, re.S).group(1)))
    broken = copy.deepcopy(data)
    del broken["matrix"][0]["required_accuracy"]
    assert "MISSING_REQUIRED_ACCURACY" in _codes(broken)
