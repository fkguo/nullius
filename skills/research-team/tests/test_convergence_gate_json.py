#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
TEAM_GATE = ROOT / "scripts" / "gates" / "check_team_convergence.py"
DRAFT_GATE = ROOT / "scripts" / "gates" / "check_draft_convergence.py"


def _run_gate(script: Path, args: list[str]) -> tuple[subprocess.CompletedProcess[str], dict]:
    proc = subprocess.run(
        [sys.executable, str(script), *args],
        capture_output=True,
        text=True,
        check=False,
    )
    payload = json.loads(proc.stdout.strip())
    return proc, payload


def _write(path: Path, content: str) -> Path:
    path.write_text(content, encoding="utf-8")
    return path


def _team_report(
    *,
    verdict: str = "ready for next milestone",
    deriv_status: str = "pass",
    comp_status: str = "pass",
    deriv_comp: str = "match",
    comp_comp: str = "match within tolerance",
    sweep: str = "pass",
    extra: str = "",
    verdict_heading: str = "## Verdict",
) -> str:
    return f"""\
## Derivation Replication
Comparison: {deriv_comp}

## Computation Replication
Falsification pathway: independent algebraic route
Failure mode targeted: sign error in coupling
Triviality classification: NONTRIVIAL
Nontriviality reason: INDEPENDENT_PATH
Comparison: {comp_comp}

## Sweep Semantics / Parameter Dependence
Consistency verdict: {sweep}

## Reproduction Summary
| Check | Status | Notes |
|---|---|---|
| Derivation replication | {deriv_status} | ok |
| Computation replication | {comp_status} | ok |

{verdict_heading}
- {verdict}
- Blocking issues: none
{extra}
"""


def _draft_report(
    *,
    verdict: str = "ready for review cycle",
    blocking_declared_line: str = "Blocking issues count: 0",
    blocking_section: str = "(none)",
) -> str:
    return f"""\
## Verdict
Verdict: {verdict}
{blocking_declared_line}

## Blocking Issues
{blocking_section}

## Minimal Fix List
- none
"""


def test_team_gate_converged_outputs_structured_json(tmp_path: Path):
    member_a = _write(tmp_path / "a.md", _team_report())
    member_b = _write(tmp_path / "b.md", _team_report())

    proc, payload = _run_gate(
        TEAM_GATE,
        ["--member-a", str(member_a), "--member-b", str(member_b), "--workflow-mode", "leader"],
    )

    assert proc.returncode == 0
    assert payload["status"] == "converged"
    assert payload["exit_code"] == 0
    assert payload["report_status"]["member_a"]["parse_ok"] is True
    assert "Team convergence check" not in proc.stdout


def test_team_gate_needs_revision_is_not_converged(tmp_path: Path):
    member_a = _write(tmp_path / "a.md", _team_report())
    member_b = _write(tmp_path / "b.md", _team_report(verdict="needs revision"))

    proc, payload = _run_gate(
        TEAM_GATE,
        ["--member-a", str(member_a), "--member-b", str(member_b), "--workflow-mode", "peer"],
    )

    assert proc.returncode == 1
    assert payload["status"] == "not_converged"
    assert payload["exit_code"] == 1


def test_team_gate_heading_drift_is_parse_error(tmp_path: Path):
    member_a = _write(tmp_path / "a.md", _team_report())
    member_b = _write(tmp_path / "b.md", _team_report(verdict_heading="## Decision"))

    proc, payload = _run_gate(
        TEAM_GATE,
        ["--member-a", str(member_a), "--member-b", str(member_b), "--workflow-mode", "peer"],
    )

    assert proc.returncode == 2
    assert payload["status"] == "parse_error"
    assert payload["exit_code"] == 2


def test_team_gate_markdown_decoration_still_parses(tmp_path: Path):
    member_a = _write(
        tmp_path / "a.md",
        _team_report(deriv_status="**pass**", comp_status="`pass`", deriv_comp="**Comparison:** match", comp_comp="**Comparison:** match"),
    )
    member_b = _write(tmp_path / "b.md", _team_report())

    proc, payload = _run_gate(
        TEAM_GATE,
        ["--member-a", str(member_a), "--member-b", str(member_b), "--workflow-mode", "peer"],
    )

    assert proc.returncode == 0
    assert payload["status"] == "converged"


def test_team_gate_leader_early_stop(tmp_path: Path):
    member_a = _write(tmp_path / "a.md", _team_report())
    member_b = _write(
        tmp_path / "b.md",
        _team_report(
            extra="""\
## Step 1: Setup
Step verdict: CHALLENGED

## Step 2: Integration
Step verdict: CHALLENGED
""",
        ),
    )

    proc, payload = _run_gate(
        TEAM_GATE,
        ["--member-a", str(member_a), "--member-b", str(member_b), "--workflow-mode", "leader"],
    )

    assert proc.returncode == 3
    assert payload["status"] == "early_stop"
    assert payload["exit_code"] == 3


def test_draft_gate_converged_outputs_structured_json(tmp_path: Path):
    member_a = _write(tmp_path / "a.md", _draft_report())
    member_b = _write(tmp_path / "b.md", _draft_report())
    member_c = _write(tmp_path / "c.md", _draft_report())

    proc, payload = _run_gate(
        DRAFT_GATE,
        ["--tag", "D0-r1", "--member-a", str(member_a), "--member-b", str(member_b), "--member-c", str(member_c)],
    )

    assert proc.returncode == 0
    assert payload["status"] == "converged"
    assert payload["exit_code"] == 0
    assert "Draft convergence check" not in proc.stdout


def test_draft_gate_not_converged(tmp_path: Path):
    member_a = _write(tmp_path / "a.md", _draft_report())
    member_b = _write(tmp_path / "b.md", _draft_report(verdict="needs revision"))
    member_c = _write(tmp_path / "c.md", _draft_report())

    proc, payload = _run_gate(
        DRAFT_GATE,
        ["--tag", "D0-r2", "--member-a", str(member_a), "--member-b", str(member_b), "--member-c", str(member_c)],
    )

    assert proc.returncode == 1
    assert payload["status"] == "not_converged"


def test_draft_gate_label_drift_is_parse_error(tmp_path: Path):
    member_a = _write(tmp_path / "a.md", _draft_report())
    member_b = _write(tmp_path / "b.md", _draft_report(blocking_declared_line="Blocking count: 0"))
    member_c = _write(tmp_path / "c.md", _draft_report())

    proc, payload = _run_gate(
        DRAFT_GATE,
        ["--tag", "D0-r3", "--member-a", str(member_a), "--member-b", str(member_b), "--member-c", str(member_c)],
    )

    assert proc.returncode == 2
    assert payload["status"] == "parse_error"
    assert payload["exit_code"] == 2


# ------------------------------------------- shared-validator strictness (SSOT)
# Direct contract tests for validate_convergence_result: booleans must not
# pass as integers (JSON Schema draft 2020-12 semantics) and report_status
# keys must satisfy the SSOT member-key pattern with ECMA-262 anchoring.

sys.path.insert(0, str(ROOT / "scripts" / "gates"))
from convergence_schema import build_gate_meta, validate_convergence_result  # noqa: E402


def _valid_meta() -> dict:
    return build_gate_meta("team_convergence")


def _member(verdict: str = "ready", blocking: object = 0) -> dict:
    return {"verdict": verdict, "blocking_count": blocking, "parse_ok": True}


def test_validator_rejects_boolean_exit_code() -> None:
    verdict = {
        "status": "converged",
        "exit_code": True,
        "reasons": [],
        "report_status": {"gate": _member()},
        "meta": _valid_meta(),
    }
    assert any("exit_code" in e for e in validate_convergence_result(verdict))


def test_validator_rejects_boolean_blocking_count() -> None:
    verdict = {
        "status": "converged",
        "exit_code": 0,
        "reasons": [],
        "report_status": {"gate": _member(blocking=True)},
        "meta": _valid_meta(),
    }
    assert any("blocking_count" in e for e in validate_convergence_result(verdict))


def test_validator_rejects_boolean_schema_version() -> None:
    meta = _valid_meta()
    meta["schema_version"] = True
    verdict = {
        "status": "converged",
        "exit_code": 0,
        "reasons": [],
        "report_status": {"gate": _member()},
        "meta": meta,
    }
    assert any("schema_version" in e for e in validate_convergence_result(verdict))


def test_validator_rejects_pattern_violating_key() -> None:
    verdict = {
        "status": "converged",
        "exit_code": 0,
        "reasons": [],
        "report_status": {"team/delegations/c.json": _member()},
        "meta": _valid_meta(),
    }
    assert any("does not match the shared schema" in e for e in validate_convergence_result(verdict))


def test_validator_rejects_trailing_newline_key() -> None:
    """ECMA-262 `$` does not match before a trailing newline; ours must not either."""
    verdict = {
        "status": "converged",
        "exit_code": 0,
        "reasons": [],
        "report_status": {"gate\n": _member()},
        "meta": _valid_meta(),
    }
    assert any("does not match the shared schema" in e for e in validate_convergence_result(verdict))
