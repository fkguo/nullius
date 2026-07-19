#!/usr/bin/env python3
"""Behavior tests for the delegation budget gate (fail-closed contract
validation + convergence_gate_result_v1 emission).

Negative controls are the point: each mandated budget field group must
individually fail the gate when absent, so the discipline cannot erode one
field at a time.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GATE = ROOT / "scripts" / "gates" / "check_delegation_budget.py"
TEMPLATE = ROOT / "assets" / "delegation_budget_contract_template.json"

sys.path.insert(0, str(ROOT / "scripts" / "gates"))
from convergence_schema import validate_convergence_result  # noqa: E402


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _complete_contract() -> dict:
    return {
        "contract_version": 1,
        "delegation_id": "lane-scan-01",
        "workstream": "run the parameter scan for milestone 1 and report the tabulated results",
        "tolerance_ceiling": {
            "value": 1e-6,
            "anchor_note": "downstream comparison only distinguishes results at the 1e-5 level; 1e-6 is one guard digit",
        },
        "time_box": {"seconds": 7200},
        "max_attempts": 2,
        "scope_negative_list": [
            "no infrastructure / build-system rewrites",
            "no building a full test suite beyond the delegated checks",
            "no third-party benchmarking",
        ],
        "peak_memory_estimate": {
            "dry_run_peak_rss_mb": 1800,
            "heap_limit_mb": 4096,
            "dry_run_ref": "artifacts/runs/dry/scan_unit0.log",
        },
    }


def _make_project(
    tmp_path: Path,
    *,
    contracts: dict[str, dict | str] | None = None,
    gate_enabled: bool = True,
    required: bool | None = None,
) -> Path:
    proj = tmp_path / "proj"
    cfg: dict = {"features": {"delegation_budget_gate": gate_enabled}}
    if required is not None:
        cfg["delegation_budget"] = {"required": required}
    _write(proj / "research_team_config.json", json.dumps(cfg))
    _write(proj / "notes.md", "# notes\n")
    for name, contract in (contracts or {}).items():
        body = contract if isinstance(contract, str) else json.dumps(contract)
        _write(proj / "team" / "delegations" / name, body)
    return proj


def _run_gate(proj: Path, *extra: str) -> tuple[subprocess.CompletedProcess, dict | None]:
    out_json = proj / "verdict.json"
    proc = subprocess.run(
        [
            sys.executable,
            str(GATE),
            "--notes",
            str(proj / "notes.md"),
            "--project-root",
            str(proj),
            "--out-json",
            str(out_json),
            *extra,
        ],
        capture_output=True,
        text=True,
    )
    verdict = json.loads(out_json.read_text(encoding="utf-8")) if out_json.is_file() else None
    return proc, verdict


def _assert_verdict_valid(verdict: dict) -> None:
    errors = validate_convergence_result(verdict)
    assert not errors, f"machine verdict fails schema validation: {errors}"
    assert verdict["meta"]["gate_id"] == "delegation_budget"


# ---------------------------------------------------------------- positive


def test_complete_contract_passes(tmp_path: Path) -> None:
    proj = _make_project(tmp_path, contracts={"lane-scan-01.json": _complete_contract()})
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 0, proc.stderr
    assert verdict is not None
    _assert_verdict_valid(verdict)
    assert verdict["status"] == "converged"
    (summary,) = verdict["report_status"].values()
    assert summary["verdict"] == "ready"
    # stdout carries the same verdict for callers that only capture stdout
    assert json.loads(proc.stdout.strip())["status"] == "converged"


def test_multiple_complete_contracts_pass(tmp_path: Path) -> None:
    second = _complete_contract()
    second["delegation_id"] = "lane-verify-02"
    proj = _make_project(
        tmp_path,
        contracts={"lane-scan-01.json": _complete_contract(), "lane-verify-02.json": second},
    )
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 0, proc.stderr
    assert verdict is not None and len(verdict["report_status"]) == 2


def test_explicit_contract_flag(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    contract = _write(proj / "elsewhere" / "c.json", json.dumps(_complete_contract()))
    proc, verdict = _run_gate(proj, "--contract", str(contract))
    assert proc.returncode == 0, proc.stderr
    assert verdict is not None and verdict["status"] == "converged"


# ------------------------------------------------- negative controls (mandate)


def _assert_fails_with(tmp_path: Path, contract: dict | str, label: str) -> None:
    proj = _make_project(tmp_path, contracts={"c.json": contract})
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 1, f"expected FAIL for {label}; stderr: {proc.stderr}"
    assert verdict is not None
    _assert_verdict_valid(verdict)
    assert verdict["status"] == "not_converged"
    assert any(label in r for r in verdict["reasons"]), (label, verdict["reasons"])


def test_missing_tolerance_ceiling_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    del contract["tolerance_ceiling"]
    _assert_fails_with(tmp_path, contract, "MISSING_TOLERANCE_CEILING")


def test_missing_tolerance_anchor_note_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    del contract["tolerance_ceiling"]["anchor_note"]
    _assert_fails_with(tmp_path, contract, "MISSING_TOLERANCE_ANCHOR")


def test_blank_tolerance_anchor_note_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    contract["tolerance_ceiling"]["anchor_note"] = "   "
    _assert_fails_with(tmp_path, contract, "MISSING_TOLERANCE_ANCHOR")


def test_non_numeric_tolerance_value_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    contract["tolerance_ceiling"]["value"] = "1e-6"
    _assert_fails_with(tmp_path, contract, "MISSING_TOLERANCE_VALUE")


def test_boolean_tolerance_value_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    contract["tolerance_ceiling"]["value"] = True
    _assert_fails_with(tmp_path, contract, "MISSING_TOLERANCE_VALUE")


def test_missing_time_box_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    del contract["time_box"]
    _assert_fails_with(tmp_path, contract, "MISSING_TIME_BOX")


def test_nonpositive_time_box_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    contract["time_box"]["seconds"] = 0
    _assert_fails_with(tmp_path, contract, "MISSING_TIME_BOX")


def test_missing_max_attempts_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    del contract["max_attempts"]
    _assert_fails_with(tmp_path, contract, "MISSING_MAX_ATTEMPTS")


def test_missing_scope_negative_list_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    del contract["scope_negative_list"]
    _assert_fails_with(tmp_path, contract, "MISSING_SCOPE_NEGATIVE_LIST")


def test_empty_scope_negative_list_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    contract["scope_negative_list"] = []
    _assert_fails_with(tmp_path, contract, "MISSING_SCOPE_NEGATIVE_LIST")


def test_missing_peak_memory_estimate_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    del contract["peak_memory_estimate"]
    _assert_fails_with(tmp_path, contract, "MISSING_PEAK_MEMORY_ESTIMATE")


def test_missing_dry_run_peak_rss_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    del contract["peak_memory_estimate"]["dry_run_peak_rss_mb"]
    _assert_fails_with(tmp_path, contract, "MISSING_DRY_RUN_PEAK_RSS")


def test_missing_heap_limit_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    del contract["peak_memory_estimate"]["heap_limit_mb"]
    _assert_fails_with(tmp_path, contract, "MISSING_HEAP_LIMIT")


def test_heap_limit_below_dry_run_peak_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    contract["peak_memory_estimate"]["heap_limit_mb"] = 100
    _assert_fails_with(tmp_path, contract, "HEAP_LIMIT_BELOW_DRY_RUN_PEAK")


def test_unknown_contract_version_fails_closed(tmp_path: Path) -> None:
    contract = _complete_contract()
    contract["contract_version"] = 2
    _assert_fails_with(tmp_path, contract, "UNSUPPORTED_CONTRACT_VERSION")


def test_missing_delegation_identity_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    del contract["delegation_id"]
    del contract["workstream"]
    _assert_fails_with(tmp_path, contract, "MISSING_DELEGATION_ID")
    _assert_fails_with(tmp_path, contract, "MISSING_WORKSTREAM")


def test_unreadable_contract_fails(tmp_path: Path) -> None:
    _assert_fails_with(tmp_path, "{not json", "UNREADABLE_CONTRACT")


def test_one_bad_contract_fails_the_run(tmp_path: Path) -> None:
    bad = _complete_contract()
    del bad["time_box"]
    proj = _make_project(
        tmp_path, contracts={"good.json": _complete_contract(), "bad.json": bad}
    )
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 1
    assert verdict is not None
    statuses = {k: v["verdict"] for k, v in verdict["report_status"].items()}
    assert statuses["team/delegations/good.json"] == "ready"
    assert statuses["team/delegations/bad.json"] == "needs_revision"


# -------------------------------------------------- template stays fail-closed


def test_unfilled_template_fails(tmp_path: Path) -> None:
    """The shipped template must not pass as-is: unfilled placeholders fail."""
    template_body = TEMPLATE.read_text(encoding="utf-8")
    proj = _make_project(tmp_path, contracts={"copied-template.json": template_body})
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 1
    assert verdict is not None
    assert any("PLACEHOLDER_VALUE" in r for r in verdict["reasons"]), verdict["reasons"]


def test_placeholder_anchor_note_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    contract["tolerance_ceiling"]["anchor_note"] = "<one line: which task requirement derives this ceiling>"
    _assert_fails_with(tmp_path, contract, "PLACEHOLDER_VALUE")


def test_legitimate_angle_brackets_in_prose_pass(tmp_path: Path) -> None:
    """Inequality signs inside real prose must not be mistaken for placeholders."""
    contract = _complete_contract()
    contract["tolerance_ceiling"]["anchor_note"] = "relative error < 1e-5 is where the downstream comparison stops changing; ceiling adds > 1 guard digit"
    proj = _make_project(tmp_path, contracts={"c.json": contract})
    proc, _ = _run_gate(proj)
    assert proc.returncode == 0, proc.stderr


# ------------------------------------------------------ presence + skip logic


def test_no_contracts_not_required_skips_without_verdict(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 0, proc.stderr
    assert verdict is None, "SKIP must not emit a machine verdict (nothing evaluated)"
    assert "SKIP" in proc.stderr


def test_no_contracts_required_by_config_fails(tmp_path: Path) -> None:
    proj = _make_project(tmp_path, required=True)
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 1
    assert verdict is not None
    _assert_verdict_valid(verdict)
    assert any("NO_CONTRACTS_FOUND" in r for r in verdict["reasons"])


def test_no_contracts_required_by_flag_fails(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    proc, verdict = _run_gate(proj, "--require")
    assert proc.returncode == 1
    assert verdict is not None
    assert any("NO_CONTRACTS_FOUND" in r for r in verdict["reasons"])


def test_feature_disabled_skips_even_with_bad_contract(tmp_path: Path) -> None:
    bad = _complete_contract()
    del bad["time_box"]
    proj = _make_project(tmp_path, contracts={"bad.json": bad}, gate_enabled=False)
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 0
    assert verdict is None
    assert "SKIP" in proc.stderr


def test_missing_notes_is_input_error(tmp_path: Path) -> None:
    proc = subprocess.run(
        [sys.executable, str(GATE), "--notes", str(tmp_path / "absent.md")],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 2
    verdict = json.loads(proc.stdout.strip())
    assert verdict["status"] == "parse_error"


def test_missing_explicit_contract_is_input_error(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    proc, verdict = _run_gate(proj, "--contract", str(proj / "absent.json"))
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"
