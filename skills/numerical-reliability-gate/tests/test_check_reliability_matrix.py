"""Behavior tests for the reliability-matrix checker (G0 required accuracy, error budget, total error).

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


def _acc(value=0.02, uses=None, **extra):
    acc = {
        "kind": "absolute",
        "value": value,
        "uses": uses if uses is not None else [{"source": "display", "value": value, "basis": "shown to two decimals"}],
    }
    acc.update(extra)
    return acc


def _row(**overrides):
    row = {
        "id": "q1",
        "quantity": "a fitted observable",
        "verdict": "reliable",
        "recorded_value": "1.92",
        "recorded_setting": "converged setting",
        "required_accuracy": _acc(
            0.02,
            [
                {"source": "comparison_uncertainty", "value": 0.02, "basis": "compared against a value quoted to 0.02"},
                {"source": "display", "value": 0.05, "basis": "shown to one decimal"},
            ],
        ),
        "error_budget": [
            {"source": "integration grid", "estimate": 0.007, "dominant": True},
            {"source": "continuation order", "estimate": 0.001, "dominant": False},
        ],
        "total_error": {"rule": "linear_sum", "value": 0.008},
    }
    row.update(overrides)
    return row


def _candidate(**overrides):
    """A non-reliable row: no recorded value or setting."""
    base = dict(verdict="unconverged", recorded_value=None, recorded_setting=None)
    base.update(overrides)
    return _row(**base)


def _matrix(*rows):
    rows = list(rows) or [_row()]
    return {
        "schema_version": 1,
        "total": len(rows),
        "reliable": sum(1 for r in rows if r.get("verdict") == "reliable"),
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


# --- the passing baseline -------------------------------------------------------------------


def test_well_formed_matrix_passes(tmp_path):
    unestimated = _candidate(
        id="q2",
        error_budget=[{"source": "seed dependence", "estimate": None, "dominant": True}],
        total_error=None,
    )
    proc = _run(tmp_path, _matrix(_row(), unestimated))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "OK" in proc.stdout


# --- required accuracy: every use, the strictest one governs --------------------------------


def test_missing_required_accuracy_fails(tmp_path):
    row = _row()
    del row["required_accuracy"]
    proc = _run(tmp_path, _matrix(row))
    assert proc.returncode == 1
    assert "MISSING_REQUIRED_ACCURACY" in proc.stdout


@pytest.mark.parametrize(
    "acc",
    [
        _acc(kind="percent"),
        _acc(value=0),
        _acc(value=-1.0),
        _acc(value=True),
        _acc(uses=[]),
        _acc(uses=[{"source": "method_capability", "value": 0.02, "basis": "what the solver reaches"}]),
        _acc(uses=[{"source": "display", "value": 0.02, "basis": ""}]),
        _acc(uses=[{"source": "display", "value": 0.02, "basis": "two\nlines"}]),
        _acc(uses=[{"source": "display", "value": 0.02, "basis": "ok", "note": "x"}]),
        _acc(source="display"),
        "0.02",
    ],
)
def test_malformed_required_accuracy_fails(acc):
    assert "INVALID_REQUIRED_ACCURACY" in _codes(_matrix(_row(required_accuracy=acc)))


def test_required_accuracy_is_the_strictest_use():
    uses = [
        {"source": "display", "value": 0.05, "basis": "shown to one decimal"},
        {"source": "downstream_sensitivity", "value": 0.004, "basis": "a threshold decision moves at 0.004"},
    ]
    # Choosing the coarse display requirement while a finer use exists is refused.
    assert "REQUIRED_ACCURACY_NOT_STRICTEST" in _codes(_matrix(_row(required_accuracy=_acc(0.05, uses))))
    # Taking the strictest use makes the same row fail on its total error, as it should.
    assert "TOTAL_ERROR_ABOVE_REQUIRED_ACCURACY" in _codes(_matrix(_row(required_accuracy=_acc(0.004, uses))))


# --- error budget: one dominant source, the largest ------------------------------------------


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
        {"source": "basis truncation", "estimate": 4e-3, "dominant": False},
    ]
    assert "DOMINANT_NOT_LARGEST" in _codes(_matrix(_row(error_budget=budget)))


def test_reliable_row_needs_every_error_estimated():
    budget = [
        {"source": "grid", "estimate": 0.001, "dominant": True},
        {"source": "model choice", "estimate": None, "dominant": False},
    ]
    assert "RELIABLE_WITH_UNESTIMATED_ERROR" in _codes(_matrix(_row(error_budget=budget)))


# --- total error and the stop rule -----------------------------------------------------------


def test_stop_rule_uses_the_total_error_not_only_the_dominant_source():
    # Two sources of 0.015 each: the largest is within 0.02, the total is not.
    budget = [
        {"source": "grid", "estimate": 0.015, "dominant": True},
        {"source": "truncation", "estimate": 0.015, "dominant": False},
    ]
    linear = _row(error_budget=budget, total_error={"rule": "linear_sum", "value": 0.03})
    assert "TOTAL_ERROR_ABOVE_REQUIRED_ACCURACY" in _codes(_matrix(linear))
    quad = _row(error_budget=budget, total_error={"rule": "quadrature", "value": 0.0213, "basis": "independent knobs"})
    assert "TOTAL_ERROR_ABOVE_REQUIRED_ACCURACY" in _codes(_matrix(quad))
    # Understating the total below its own rule is refused.
    understated = _row(error_budget=budget, total_error={"rule": "linear_sum", "value": 0.015})
    assert "TOTAL_ERROR_BELOW_ITS_RULE" in _codes(_matrix(understated))


def test_total_within_or_at_target_passes():
    at = _row(error_budget=[{"source": "grid", "estimate": 0.02, "dominant": True}],
              total_error={"rule": "linear_sum", "value": 0.02})
    assert _codes(_matrix(at)) == []
    assert _codes(_matrix(_row())) == []


@pytest.mark.parametrize(
    "total",
    [
        {"rule": "quadrature", "value": 0.0071},
        {"rule": "rms", "value": 0.008},
        {"rule": "linear_sum", "value": -1},
        {"rule": "linear_sum", "value": 0.008, "note": "x"},
        {"rule": ["linear_sum"], "value": 0.008},
        "0.008",
    ],
)
def test_malformed_total_error_fails(total):
    assert "INVALID_TOTAL_ERROR" in _codes(_matrix(_row(total_error=total)))


def test_quadrature_with_independence_basis_passes():
    row = _row(total_error={"rule": "quadrature", "value": 0.0071, "basis": "grid and order errors come from independent knobs"})
    assert _codes(_matrix(row)) == []


def test_reliable_row_needs_a_total_error():
    assert "MISSING_TOTAL_ERROR" in _codes(_matrix(_row(total_error=None)))


def test_total_error_cannot_be_formed_from_unestimated_sources():
    row = _candidate(error_budget=[{"source": "seed", "estimate": None, "dominant": True}],
                     total_error={"rule": "linear_sum", "value": 0.0})
    assert "INVALID_TOTAL_ERROR" in _codes(_matrix(row))


def test_candidate_row_may_carry_a_total_above_the_target():
    row = _candidate(error_budget=[{"source": "grid", "estimate": 0.03, "dominant": True}],
                     total_error={"rule": "linear_sum", "value": 0.03})
    assert _codes(_matrix(row)) == []


def test_refinement_far_past_the_target_warns_without_failing(tmp_path):
    tiny = dict(error_budget=[{"source": "grid", "estimate": 1e-9, "dominant": True}],
                total_error={"rule": "linear_sum", "value": 1e-9})
    findings, warnings = crm.check(_matrix(_row(**tiny)))
    assert findings == []
    assert [w["code"] for w in warnings] == ["REFINED_PAST_REQUIRED_ACCURACY"]
    proc = _run(tmp_path, _matrix(_row(**tiny)))
    assert proc.returncode == 0
    assert "WARNING REFINED_PAST_REQUIRED_ACCURACY" in proc.stdout
    # A non-reliable row that documents wasted refinement is flagged too.
    assert [w["code"] for w in crm.check(_matrix(_candidate(**tiny)))[1]] == ["REFINED_PAST_REQUIRED_ACCURACY"]
    # Within three orders of the target, or an exactly zero error, is not flagged.
    close = _row(error_budget=[{"source": "grid", "estimate": 1e-4, "dominant": True}],
                 total_error={"rule": "linear_sum", "value": 1e-4})
    zero = _row(error_budget=[{"source": "exact identity", "estimate": 0, "dominant": True}],
                total_error={"rule": "linear_sum", "value": 0})
    assert crm.check(_matrix(close))[1] == []
    assert crm.check(_matrix(zero)) == ([], [])


def test_rounding_allowance_cannot_reverse_the_verdict():
    # A reported total a hair below its rule (inside the rounding allowance) must not let a
    # total that truly exceeds the target pass: the stop rule uses the recomputed value.
    big = 1_000_000_000_000
    row = _row(
        required_accuracy=_acc(999_999_999_999.75),
        error_budget=[{"source": "grid", "estimate": big, "dominant": True}],
        total_error={"rule": "linear_sum", "value": 999_999_999_999.5},
    )
    assert "TOTAL_ERROR_ABOVE_REQUIRED_ACCURACY" in _codes(_matrix(row))


def test_large_integers_keep_their_exact_ordering():
    # 2**53 + 1 rounds to 2**53 as a float; the checker must not let that hide a total above target.
    row = _row(
        required_accuracy=_acc(2**53),
        error_budget=[{"source": "grid", "estimate": 2**53 + 1, "dominant": True}],
        total_error={"rule": "linear_sum", "value": 2**53 + 1},
    )
    assert "TOTAL_ERROR_ABOVE_REQUIRED_ACCURACY" in _codes(_matrix(row))
    # A total reported as 2**53 (within the rounding allowance of the exact sum) still fails,
    # because the exact sum of the estimates governs.
    understated = dict(row, total_error={"rule": "linear_sum", "value": 2**53})
    assert "TOTAL_ERROR_ABOVE_REQUIRED_ACCURACY" in _codes(_matrix(understated))


def test_mixed_integer_and_decimal_sums_stay_exact(tmp_path):
    # 2**53 + 1 plus 0.0 must not round to 2**53 (in-process and from a JSON file).
    row = _row(
        required_accuracy=_acc(2**53),
        error_budget=[
            {"source": "grid", "estimate": 2**53 + 1, "dominant": True},
            {"source": "order", "estimate": 0.0, "dominant": False},
        ],
        total_error={"rule": "linear_sum", "value": 2**53},
    )
    assert "TOTAL_ERROR_ABOVE_REQUIRED_ACCURACY" in _codes(_matrix(row))
    proc = _run(tmp_path, _matrix(row))
    assert proc.returncode == 1 and "TOTAL_ERROR_ABOVE_REQUIRED_ACCURACY" in proc.stdout


def test_decimal_sums_hit_the_target_exactly(tmp_path):
    # 0.1 + 0.2 is exactly 0.3 as written; binary floats would put it above 0.3.
    row = _row(
        required_accuracy=_acc(0.3),
        error_budget=[
            {"source": "grid", "estimate": 0.2, "dominant": True},
            {"source": "order", "estimate": 0.1, "dominant": False},
        ],
        total_error={"rule": "linear_sum", "value": 0.3},
    )
    proc = _run(tmp_path, _matrix(row))
    assert proc.returncode == 0, proc.stdout
    # The same holds for values handed over in-process as Python floats.
    assert _codes(_matrix(row)) == []


def test_written_digits_beyond_binary_precision_are_kept(tmp_path):
    # 0.30000000000000000001 exceeds 0.3 by 1e-20; a binary float would erase the excess.
    row = _row(
        required_accuracy=_acc(0.3),
        error_budget=[{"source": "grid", "estimate": 0.3, "dominant": True}],
        total_error={"rule": "linear_sum", "value": 0.3},
    )
    raw = json.dumps(_matrix(row)).replace('"estimate": 0.3', '"estimate": 0.30000000000000000001')
    raw = raw.replace('"total_error": {"rule": "linear_sum", "value": 0.3}', '"total_error": {"rule": "linear_sum", "value": 0.30000000000000000001}')
    proc = _run(tmp_path, None, raw=raw)
    assert proc.returncode == 1 and "TOTAL_ERROR_ABOVE_REQUIRED_ACCURACY" in proc.stdout, proc.stdout


def test_quadrature_of_large_accepted_estimates_does_not_overflow():
    budget = [
        {"source": "grid", "estimate": 1e200, "dominant": True},
        {"source": "order", "estimate": 1e200, "dominant": False},
    ]
    row = _row(
        required_accuracy=_acc(2e200),
        error_budget=budget,
        total_error={"rule": "quadrature", "value": 1.5e200, "basis": "independent knobs"},
    )
    assert _codes(_matrix(row)) == []


@pytest.mark.parametrize("bad", ["two\rlines", "two\u2028lines", "trailing\n"])
def test_one_line_fields_reject_every_line_break(bad):
    assert "DIAGNOSTIC_WITHOUT_BASIS" in _codes(_matrix(_row(invariant_check={"passed": True, "threshold_basis": bad})))


@pytest.mark.parametrize(
    "overrides",
    [
        {"required_accuracy": _acc(10**400)},
        {"error_budget": [{"source": "grid", "estimate": 10**400, "dominant": True}]},
        {"total_error": {"rule": "linear_sum", "value": 10**400}},
    ],
)
def test_oversized_integers_are_findings_not_crashes(overrides):
    assert _codes(_matrix(_row(**overrides)))


@pytest.mark.parametrize("block", ["invariant_check", "method_precondition"])
def test_diagnostic_threshold_needs_a_machine_readable_basis(block):
    without = {"passed": True, "threshold": 1e-10}
    assert "DIAGNOSTIC_WITHOUT_BASIS" in _codes(_matrix(_row(**{block: without})))
    assert "DIAGNOSTIC_WITHOUT_BASIS" in _codes(_matrix(_row(**{block: "passed"})))
    with_basis = dict(without, threshold_basis="a residual of that size moves the quantity by less than 1e-4")
    assert _codes(_matrix(_row(**{block: with_basis}))) == []


# --- matrix bookkeeping ----------------------------------------------------------------------


@pytest.mark.parametrize("field", ["recorded_value", "recorded_setting"])
def test_only_reliable_rows_carry_recorded_fields(field):
    assert "RECORDED_FIELD_MISMATCH" in _codes(_matrix(_row(**{field: None})))
    assert "RECORDED_FIELD_MISMATCH" in _codes(_matrix(_candidate(**{field: "something"})))


def test_verdict_vocabulary_and_unique_ids():
    assert "INVALID_VERDICT" in _codes(_matrix(_row(verdict="good_enough")))
    assert "DUPLICATE_ID" in _codes(_matrix(_row(), _row()))


@pytest.mark.parametrize(
    "overrides",
    [
        {"verdict": []},
        {"verdict": {}},
        {"required_accuracy": {"kind": {}, "value": 0.02, "uses": [{"source": [], "value": 0.02, "basis": "x"}]}},
        {"total_error": {"rule": {}, "value": 0.008}},
        {"id": ["q1"]},
    ],
)
def test_unhashable_field_values_are_findings_not_crashes(overrides):
    assert _codes(_matrix(_row(**overrides)))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.update(total=2),
        lambda d: d.update(total=True),
        lambda d: d.update(reliable=None),
        lambda d: d.pop("total"),
        lambda d: d.pop("not_reliable"),
        lambda d: d.update(not_reliable=["q1"]),
        lambda d: d.update(not_reliable=[1]),
    ],
)
def test_summary_counts_are_required_and_must_match_rows(mutate):
    data = _matrix(_row())
    mutate(data)
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


# --- the contract and the checker stay in step -----------------------------------------------


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


def _contract_example():
    contract = CONTRACT.read_text(encoding="utf-8")
    block = re.search(r"```jsonc\n(.*?)\n```", contract, re.S)
    assert block, "contract.md must keep its jsonc example matrix"
    return json.loads(_strip_line_comments(block.group(1)))


def test_contract_example_matrix_satisfies_the_checker():
    data = _contract_example()
    findings, _ = crm.check(data)
    assert findings == [], findings
    rows = data["matrix"]
    assert all("required_accuracy" in r and "error_budget" in r and "total_error" in r for r in rows)
    assert any(len(r["required_accuracy"]["uses"]) > 1 for r in rows)
    assert any(e["estimate"] is None for r in rows for e in r["error_budget"])
    # The example demonstrates a diagnostic threshold stricter than its row's required accuracy,
    # carrying its machine-readable basis.
    diagnostic = [r for r in rows if isinstance(r.get("invariant_check"), dict)]
    assert diagnostic and all(r["invariant_check"].get("threshold_basis") for r in diagnostic)
    assert any(r["invariant_check"]["integer_residual_threshold"] < r["required_accuracy"]["value"] for r in diagnostic)
    # Every cross-method entry of a reliable example row records the contract's mandatory G2 evidence.
    for row in rows:
        if row["verdict"] == "reliable":
            for entry in row["cross_method"]:
                for field in ("method_diversity", "model_family", "execution_independence", "input_independence",
                              "raw_input_provenance", "applicability", "known_defects", "diagnostic_limits"):
                    assert entry.get(field), (row["id"], entry["method"], field)


def test_contract_example_with_g0_removed_fails():
    broken = copy.deepcopy(_contract_example())
    del broken["matrix"][0]["required_accuracy"]
    assert "MISSING_REQUIRED_ACCURACY" in _codes(broken)
