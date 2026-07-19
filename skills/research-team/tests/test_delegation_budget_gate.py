#!/usr/bin/env python3
"""Behavior tests for the delegation budget gate (fail-closed contract
validation + convergence_gate_result_v1 emission).

Negative controls are the point: each mandated budget field group must
individually fail the gate when absent, so the discipline cannot erode one
field at a time.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GATE = ROOT / "scripts" / "gates" / "check_delegation_budget.py"
TEMPLATE = ROOT / "assets" / "delegation_budget_contract_template.json"

sys.path.insert(0, str(ROOT / "scripts" / "gates"))
from convergence_schema import (  # noqa: E402
    REPORT_STATUS_KEY_PATTERN,
    validate_convergence_result,
)


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
    # Every report_status key must satisfy the schema SSOT's member key
    # pattern (path-shaped keys once emitted schema-invalid verdicts).
    assert REPORT_STATUS_KEY_PATTERN is not None
    import re as _re

    for key in verdict["report_status"]:
        assert _re.fullmatch(f"(?:{REPORT_STATUS_KEY_PATTERN})", key), (
            f"report_status key {key!r} violates schema pattern {REPORT_STATUS_KEY_PATTERN!r}"
        )


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


def test_boolean_contract_version_fails(tmp_path: Path) -> None:
    """True == 1 in Python; a boolean must not pass as version 1."""
    contract = _complete_contract()
    contract["contract_version"] = True
    _assert_fails_with(tmp_path, contract, "UNSUPPORTED_CONTRACT_VERSION")


def test_float_contract_version_fails(tmp_path: Path) -> None:
    """1.0 == 1 in Python; a float must not pass as version 1."""
    contract = _complete_contract()
    contract["contract_version"] = 1.0
    _assert_fails_with(tmp_path, contract, "UNSUPPORTED_CONTRACT_VERSION")


def test_float_time_box_seconds_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    contract["time_box"]["seconds"] = 7200.0
    _assert_fails_with(tmp_path, contract, "MISSING_TIME_BOX")


def test_multiline_anchor_note_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    contract["tolerance_ceiling"]["anchor_note"] = "line one\nline two"
    _assert_fails_with(tmp_path, contract, "MISSING_TOLERANCE_ANCHOR")


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
    _assert_verdict_valid(verdict)
    statuses = {k: v["verdict"] for k, v in verdict["report_status"].items()}
    assert statuses["good"] == "ready"
    assert statuses["bad"] == "needs_revision"
    sources = {k: v["source_path"] for k, v in verdict["report_status"].items()}
    assert sources["good"] == "team/delegations/good.json"
    assert sources["bad"] == "team/delegations/bad.json"


def test_report_status_keys_schema_safe_for_hyphenated_filenames(tmp_path: Path) -> None:
    """File names with hyphens/digits must map to schema-pattern-safe keys."""
    proj = _make_project(
        tmp_path, contracts={"lane-scan-01.json": _complete_contract()}
    )
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 0, proc.stderr
    assert verdict is not None
    _assert_verdict_valid(verdict)
    (key,) = verdict["report_status"].keys()
    assert key == "lane_scan_01"
    assert verdict["report_status"][key]["source_path"] == "team/delegations/lane-scan-01.json"


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


def test_placeholder_in_optional_field_fails(tmp_path: Path) -> None:
    """Optional fields are swept too: a supplied placeholder is an unfilled template."""
    contract = _complete_contract()
    contract["peak_memory_estimate"]["dry_run_ref"] = "<optional: pointer to the dry-run log>"
    _assert_fails_with(tmp_path, contract, "PLACEHOLDER_VALUE")


def test_placeholder_in_scope_entry_reported_even_with_blank_entry(tmp_path: Path) -> None:
    """A blank entry must not mask a placeholder entry: both labels surface."""
    contract = _complete_contract()
    contract["scope_negative_list"] = ["  ", "<no infrastructure rewrites>"]
    proj = _make_project(tmp_path, contracts={"c.json": contract})
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 1
    assert verdict is not None
    assert any("MISSING_SCOPE_NEGATIVE_LIST" in r for r in verdict["reasons"])
    assert any("PLACEHOLDER_VALUE" in r for r in verdict["reasons"])


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


# ------------------------------------------- strict config + wiring hardening


def test_tag_flag_produces_schema_valid_verdict(tmp_path: Path) -> None:
    """run_team_cycle.sh always passes --tag; the tagged verdict must validate."""
    proj = _make_project(tmp_path, contracts={"c.json": _complete_contract()})
    proc, verdict = _run_gate(proj, "--tag", "20260719T000000Z-m1-r1")
    assert proc.returncode == 0, proc.stderr
    assert verdict is not None
    _assert_verdict_valid(verdict)
    assert verdict["meta"]["tag"] == "20260719T000000Z-m1-r1"


def test_non_boolean_feature_flag_is_input_error(tmp_path: Path) -> None:
    """A malformed flag must not silently disable a fail-closed gate."""
    proj = tmp_path / "proj"
    _write(
        proj / "research_team_config.json",
        json.dumps({"features": {"delegation_budget_gate": "false"}}),
    )
    _write(proj / "notes.md", "# notes\n")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_non_boolean_required_is_input_error(tmp_path: Path) -> None:
    proj = tmp_path / "proj"
    _write(
        proj / "research_team_config.json",
        json.dumps({"delegation_budget": {"required": "yes"}}),
    )
    _write(proj / "notes.md", "# notes\n")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_empty_delegations_dir_config_is_input_error(tmp_path: Path) -> None:
    proj = tmp_path / "proj"
    _write(
        proj / "research_team_config.json",
        json.dumps({"delegation_budget": {"delegations_dir": "  "}}),
    )
    _write(proj / "notes.md", "# notes\n")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_non_dict_delegation_budget_block_is_input_error(tmp_path: Path) -> None:
    proj = tmp_path / "proj"
    _write(
        proj / "research_team_config.json",
        json.dumps({"delegation_budget": "team/delegations"}),
    )
    _write(proj / "notes.md", "# notes\n")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_delegations_path_that_is_a_file_is_input_error(tmp_path: Path) -> None:
    """A broken scan path must not silently SKIP as an empty delegation set."""
    proj = _make_project(tmp_path)
    _write(proj / "team" / "delegations", "")  # regular file, not a directory
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_delegations_dir_flag_relative(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    _write(proj / "elsewhere" / "c.json", json.dumps(_complete_contract()))
    proc, verdict = _run_gate(proj, "--delegations-dir", "elsewhere")
    assert proc.returncode == 0, proc.stderr
    assert verdict is not None and verdict["status"] == "converged"


def test_delegations_dir_flag_absolute(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    outside = tmp_path / "outside_dir"
    _write(outside / "c.json", json.dumps(_complete_contract()))
    proc, verdict = _run_gate(proj, "--delegations-dir", str(outside))
    assert proc.returncode == 0, proc.stderr
    assert verdict is not None and verdict["status"] == "converged"
    _assert_verdict_valid(verdict)


def test_unwritable_out_json_is_input_error_with_single_verdict(tmp_path: Path) -> None:
    """--out-json persistence failure: exactly one stdout verdict, and it is a
    parse_error whose exit_code field agrees with the process exit code 2."""
    proj = _make_project(tmp_path, contracts={"c.json": _complete_contract()})
    blocked = proj / "blocked_dir"
    blocked.mkdir()
    proc = subprocess.run(
        [
            sys.executable,
            str(GATE),
            "--notes",
            str(proj / "notes.md"),
            "--project-root",
            str(proj),
            "--out-json",
            str(blocked),  # a directory: the write must fail
        ],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 2
    assert "Traceback" not in proc.stderr
    lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
    assert len(lines) == 1, f"expected exactly one stdout verdict line, got: {lines}"
    verdict = json.loads(lines[0])
    assert verdict["status"] == "parse_error"
    assert verdict["exit_code"] == 2
    _assert_verdict_valid(verdict)


def test_malformed_config_json_is_input_error(tmp_path: Path) -> None:
    """A config file that exists but cannot be parsed must not silently fall
    back to defaults (a broken required=true would otherwise SKIP)."""
    proj = tmp_path / "proj"
    _write(proj / "research_team_config.json", "{broken json")
    _write(proj / "notes.md", "# notes\n")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_non_object_config_json_is_input_error(tmp_path: Path) -> None:
    proj = tmp_path / "proj"
    _write(proj / "research_team_config.json", json.dumps(["not", "an", "object"]))
    _write(proj / "notes.md", "# notes\n")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_unreadable_delegations_dir_is_input_error(tmp_path: Path) -> None:
    """An existing but unreadable delegations directory must not SKIP as empty."""
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        return  # root bypasses permission bits; nothing to test
    proj = _make_project(tmp_path, contracts={"c.json": _complete_contract()})
    locked = proj / "team" / "delegations"
    locked.chmod(0o000)
    try:
        proc, verdict = _run_gate(proj)
    finally:
        locked.chmod(0o755)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


# --------------------------------------------------- default-ON without config


def test_no_config_file_defaults_gate_on(tmp_path: Path) -> None:
    """With no team config at all, the gate is still enforced (default-ON)."""
    proj = tmp_path / "proj"
    _write(proj / "notes.md", "# notes\n")
    bad = _complete_contract()
    del bad["time_box"]
    _write(proj / "team" / "delegations" / "bad.json", json.dumps(bad))
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 1
    assert verdict is not None
    _assert_verdict_valid(verdict)
    assert any("MISSING_TIME_BOX" in r for r in verdict["reasons"])


def test_no_config_file_no_contracts_skips(tmp_path: Path) -> None:
    proj = tmp_path / "proj"
    _write(proj / "notes.md", "# notes\n")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 0, proc.stderr
    assert verdict is None
    assert "SKIP" in proc.stderr


# --------------------------------------- exhaustive type/range negative controls
# (Nonfinite NaN/Infinity cannot reach field validation through standard JSON:
#  the gate rejects those literals at parse level — see
#  test_nonstandard_json_nan_constant_fails.)


import pytest


@pytest.mark.parametrize("bad", [0, -1, True, 2.0, "2", None])
def test_bad_max_attempts_fails(tmp_path: Path, bad: object) -> None:
    contract = _complete_contract()
    contract["max_attempts"] = bad
    _assert_fails_with(tmp_path, contract, "MISSING_MAX_ATTEMPTS")


@pytest.mark.parametrize("bad", [0, -1e-6])
def test_bad_tolerance_value_fails(tmp_path: Path, bad: float) -> None:
    contract = _complete_contract()
    contract["tolerance_ceiling"]["value"] = bad
    _assert_fails_with(tmp_path, contract, "MISSING_TOLERANCE_VALUE")


@pytest.mark.parametrize("bad", [0, -100, True, "1800"])
def test_bad_dry_run_peak_rss_fails(tmp_path: Path, bad: object) -> None:
    contract = _complete_contract()
    contract["peak_memory_estimate"]["dry_run_peak_rss_mb"] = bad
    _assert_fails_with(tmp_path, contract, "MISSING_DRY_RUN_PEAK_RSS")


@pytest.mark.parametrize("bad", [0, -4096, True, "4096"])
def test_bad_heap_limit_fails(tmp_path: Path, bad: object) -> None:
    contract = _complete_contract()
    contract["peak_memory_estimate"]["heap_limit_mb"] = bad
    _assert_fails_with(tmp_path, contract, "MISSING_HEAP_LIMIT")


@pytest.mark.parametrize("bad", [-1, True, 1.5, "7200", None])
def test_bad_time_box_seconds_fails(tmp_path: Path, bad: object) -> None:
    contract = _complete_contract()
    contract["time_box"]["seconds"] = bad
    _assert_fails_with(tmp_path, contract, "MISSING_TIME_BOX")


# --------------------------------------------------- CLI + environment hardening


def test_malformed_cli_emits_machine_verdict(tmp_path: Path) -> None:
    """Missing required --notes must still emit one schema-valid parse_error
    verdict on stdout (exit 2), not a bare argparse usage error."""
    proc = subprocess.run(
        [sys.executable, str(GATE)],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 2
    lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
    assert len(lines) == 1, f"expected one stdout verdict line, got: {lines}"
    verdict = json.loads(lines[0])
    assert verdict["status"] == "parse_error"
    assert verdict["exit_code"] == 2
    assert not validate_convergence_result(verdict)


def test_help_still_exits_zero() -> None:
    proc = subprocess.run(
        [sys.executable, str(GATE), "--help"],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0
    assert "delegation" in proc.stdout.lower()


def test_stale_env_config_override_is_input_error(tmp_path: Path) -> None:
    """RESEARCH_TEAM_CONFIG pointing at a missing file suppresses local config
    discovery entirely (find_config_path does not fall back) — with a local
    required=true config that would fail open. Must be an input error."""
    proj = _make_project(tmp_path, required=True)
    env = dict(os.environ)
    env["RESEARCH_TEAM_CONFIG"] = str(tmp_path / "no_such_config.json")
    proc = subprocess.run(
        [
            sys.executable,
            str(GATE),
            "--notes",
            str(proj / "notes.md"),
            "--project-root",
            str(proj),
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    assert proc.returncode == 2
    verdict = json.loads(proc.stdout.strip())
    assert verdict["status"] == "parse_error"
    assert any("RESEARCH_TEAM_CONFIG" in r for r in verdict["reasons"])


def test_nested_bad_delegations_path_is_input_error(tmp_path: Path) -> None:
    """A scan path nested under a regular file (ENOTDIR) must not SKIP:
    Path.exists() swallows ENOTDIR and would report it as absent."""
    proj = _make_project(tmp_path)
    _write(proj / "team" / "delegations_file", "not a dir")
    proc, verdict = _run_gate(
        proj, "--delegations-dir", str(proj / "team" / "delegations_file" / "nested")
    )
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_nonexistent_project_root_is_input_error(tmp_path: Path) -> None:
    """A broken explicit --project-root must not SKIP as 'no delegations'."""
    proj = _make_project(tmp_path, contracts={"c.json": _complete_contract()})
    proc = subprocess.run(
        [
            sys.executable,
            str(GATE),
            "--notes",
            str(proj / "notes.md"),
            "--project-root",
            str(tmp_path / "no_such_root"),
        ],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 2
    assert json.loads(proc.stdout.strip())["status"] == "parse_error"


def test_dangling_symlink_delegations_dir_is_input_error(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    (proj / "team").mkdir(parents=True, exist_ok=True)
    (proj / "team" / "delegations").symlink_to(tmp_path / "gone")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity"])
def test_nonstandard_json_nan_constant_fails(tmp_path: Path, token: str) -> None:
    """Python json accepts NaN/Infinity literals; standard JSON consumers do
    not — such a contract must fail as unreadable."""
    body = json.dumps(_complete_contract())
    body = body.replace("1800", token, 1)
    _assert_fails_with(tmp_path, body, "UNREADABLE_CONTRACT")


def test_unicode_line_separator_anchor_note_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    contract["tolerance_ceiling"]["anchor_note"] = "line one line two"
    _assert_fails_with(tmp_path, contract, "MISSING_TOLERANCE_ANCHOR")


_LINE_BOUNDARIES = ["\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"]


@pytest.mark.parametrize("sep", _LINE_BOUNDARIES)
@pytest.mark.parametrize("position", ["embedded", "terminal"])
def test_any_line_boundary_in_anchor_note_fails(tmp_path: Path, sep: str, position: str) -> None:
    """EVERY line boundary Python recognizes violates the one-line rule,
    embedded or terminal (a splitlines count alone misses terminal ones;
    an explicit character set misses FS/GS/RS)."""
    contract = _complete_contract()
    anchor = f"part one{sep}part two" if position == "embedded" else f"one line{sep}"
    contract["tolerance_ceiling"]["anchor_note"] = anchor
    _assert_fails_with(tmp_path, contract, "MISSING_TOLERANCE_ANCHOR")


def test_duplicate_json_keys_fail(tmp_path: Path) -> None:
    """json.loads is last-wins on duplicate keys: an earlier placeholder
    would vanish before the placeholder sweep — duplicates must fail."""
    body = json.dumps(_complete_contract())
    dup = body[:-1] + ', "max_attempts": 3}'
    _assert_fails_with(tmp_path, dup, "UNREADABLE_CONTRACT")


def test_dangling_symlink_ancestor_of_delegations_dir_is_input_error(tmp_path: Path) -> None:
    """team -> missing: the dangling link is an ANCESTOR of the scan path, so
    the leaf never lexically exists — must still be an input error, not SKIP."""
    proj = _make_project(tmp_path)
    (proj / "team").symlink_to(tmp_path / "missing_target")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_config_path_as_directory_is_input_error(tmp_path: Path) -> None:
    """A reserved config path that is a directory is silently ignored by
    find_config_path (defaults inherited) — must be an input error."""
    proj = tmp_path / "proj"
    (proj / "research_team_config.json").mkdir(parents=True)
    _write(proj / "notes.md", "# notes\n")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_config_path_as_dangling_symlink_is_input_error(tmp_path: Path) -> None:
    proj = tmp_path / "proj"
    proj.mkdir(parents=True)
    (proj / "research_team_config.json").symlink_to(tmp_path / "gone.json")
    _write(proj / "notes.md", "# notes\n")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_duplicate_config_key_is_input_error(tmp_path: Path) -> None:
    """A duplicate enforcement flag in the config (true then false) is a
    last-wins ambiguity that could silently disable the gate — must be an
    input error, never a SKIP."""
    proj = tmp_path / "proj"
    _write(
        proj / "research_team_config.json",
        '{"features": {"delegation_budget_gate": true, "delegation_budget_gate": false}}',
    )
    _write(proj / "notes.md", "# notes\n")
    bad = _complete_contract()
    del bad["time_box"]
    _write(proj / "team" / "delegations" / "bad.json", json.dumps(bad))
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_invalid_utf8_config_is_input_error(tmp_path: Path) -> None:
    proj = tmp_path / "proj"
    proj.mkdir(parents=True)
    (proj / "research_team_config.json").write_bytes(b'{"features": {\xff\xfe}}')
    _write(proj / "notes.md", "# notes\n")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_multiline_workstream_fails(tmp_path: Path) -> None:
    contract = _complete_contract()
    contract["workstream"] = "line one\nline two"
    _assert_fails_with(tmp_path, contract, "MISSING_WORKSTREAM")


def test_json_constant_in_config_is_input_error(tmp_path: Path) -> None:
    proj = tmp_path / "proj"
    _write(proj / "research_team_config.json", '{"delegation_budget": {"x": NaN}}')
    _write(proj / "notes.md", "# notes\n")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_yaml_duplicate_config_key_is_input_error(tmp_path: Path) -> None:
    pytest.importorskip("yaml")
    proj = tmp_path / "proj"
    _write(
        proj / "research_team_config.yaml",
        "features:\n  delegation_budget_gate: true\n  delegation_budget_gate: false\n",
    )
    _write(proj / "notes.md", "# notes\n")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_yaml_non_mapping_config_is_input_error(tmp_path: Path) -> None:
    pytest.importorskip("yaml")
    proj = tmp_path / "proj"
    _write(proj / "research_team_config.yaml", "- just\n- a\n- list\n")
    _write(proj / "notes.md", "# notes\n")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 2
    assert verdict is not None and verdict["status"] == "parse_error"


def test_yaml_config_without_yaml_module_is_input_error(tmp_path: Path) -> None:
    """A YAML config that cannot be validated (no yaml module) must be an
    input error, not silently 'no config'. A stub yaml module that raises on
    import simulates the missing dependency."""
    shim = tmp_path / "shim"
    _write(shim / "yaml.py", 'raise ImportError("yaml deliberately unavailable for this test")\n')
    proj = tmp_path / "proj"
    _write(proj / "research_team_config.yaml", "features:\n  delegation_budget_gate: true\n")
    _write(proj / "notes.md", "# notes\n")
    env = dict(os.environ)
    env["PYTHONPATH"] = f"{shim}{os.pathsep}" + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [
            sys.executable,
            str(GATE),
            "--notes",
            str(proj / "notes.md"),
            "--project-root",
            str(proj),
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    assert proc.returncode == 2
    verdict = json.loads(proc.stdout.strip())
    assert verdict["status"] == "parse_error"


def test_gate_uses_strict_config_snapshot(tmp_path: Path, monkeypatch: object) -> None:
    """The merged config must come from the SAME strict snapshot that was
    validated — not from a second, lenient re-read of the file (a swap
    between reads could flip required/enabled)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("check_delegation_budget_snapshot_test", GATE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    proj = tmp_path / "proj"
    # On-disk config says NOT required; the strict snapshot says required.
    _write(proj / "research_team_config.json", json.dumps({"delegation_budget": {"required": False}}))
    _write(proj / "notes.md", "# notes\n")

    monkeypatch.setattr(mod, "load_config_object", lambda path: {"delegation_budget": {"required": True}})
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "check_delegation_budget.py",
            "--notes",
            str(proj / "notes.md"),
            "--project-root",
            str(proj),
        ],
    )
    # required=True from the snapshot + no contracts on disk → FAIL, proving
    # the snapshot (not the lenient re-read) is the authority.
    assert mod.main() == 1


def test_fifo_contract_entry_fails_without_blocking(tmp_path: Path) -> None:
    """A FIFO named *.json must fail as UNREADABLE_CONTRACT, not hang the
    preflight forever on read()."""
    if not hasattr(os, "mkfifo"):
        return  # platform without FIFOs
    proj = _make_project(tmp_path, contracts={"good.json": _complete_contract()})
    os.mkfifo(proj / "team" / "delegations" / "a_fifo.json")
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 1
    assert verdict is not None
    assert any("UNREADABLE_CONTRACT" in r for r in verdict["reasons"])


def test_symlink_to_fifo_contract_entry_fails_without_blocking(tmp_path: Path) -> None:
    if not hasattr(os, "mkfifo"):
        return
    proj = _make_project(tmp_path, contracts={"good.json": _complete_contract()})
    fifo = tmp_path / "outside.fifo"
    os.mkfifo(fifo)
    (proj / "team" / "delegations" / "linked.json").symlink_to(fifo)
    proc, verdict = _run_gate(proj)
    assert proc.returncode == 1
    assert verdict is not None
    assert any("UNREADABLE_CONTRACT" in r for r in verdict["reasons"])


def test_symlinked_config_binds_root_to_resolved_parent(tmp_path: Path) -> None:
    """With no --project-root, the default root derives from the RESOLVED
    config path: the strict snapshot and the delegations tree bind to the
    same target, so retargeting the symlink cannot pair snapshot A with
    tree B."""
    real = tmp_path / "real"
    bad = _complete_contract()
    del bad["time_box"]
    _write(real / "research_team_config.json", json.dumps({"features": {"delegation_budget_gate": True}}))
    _write(real / "team" / "delegations" / "bad.json", json.dumps(bad))
    link_dir = tmp_path / "link_dir"
    link_dir.mkdir()
    (link_dir / "research_team_config.json").symlink_to(real / "research_team_config.json")
    _write(link_dir / "notes.md", "# notes\n")
    proc = subprocess.run(
        [sys.executable, str(GATE), "--notes", str(link_dir / "notes.md")],
        capture_output=True,
        text=True,
    )
    # Root = resolved parent (real/), whose delegations tree carries the bad
    # contract → FAIL. If the root were the symlink's directory, the empty
    # link_dir would silently SKIP.
    assert proc.returncode == 1, proc.stderr
    assert "MISSING_TIME_BOX" in proc.stdout
