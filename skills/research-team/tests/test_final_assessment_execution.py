"""Fresh final-consumer execution counts; offline protocol witnesses, not science."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from reproduction_assessment_fixture import create_assessment
from test_convergence_gate_json import TEAM_GATE, _team_report
from test_independent_reproduction_gate import TAG, _make_project, _seed_member


@pytest.fixture
def candidate(tmp_path, monkeypatch):
    monkeypatch.delenv("RESEARCH_TEAM_CONFIG", raising=False)
    project = _make_project(tmp_path)
    evidence = [_seed_member(project, member, report_text=_team_report())
                for member in ("member_a", "member_b")]
    previous, historical = create_assessment(project, TAG, *evidence)
    assert previous.returncode == 0, previous.stderr
    reports = [project / json.loads(path.read_text())["original_transport"]["stages"]["final"]["output"]["path"]
               for path in evidence]
    # Count actual model-runner entries after seeding a historical assessment.
    # No gate verdict or observation authority is stubbed.
    calls = project / "assessor_calls.txt"
    backend = project / "fixture_assessor_backend.py"
    backend.write_text("from pathlib import Path\nwith Path(" + repr(str(calls))
                       + ").open('a') as log: log.write('invoked\\n')\n" + backend.read_text())
    command = [sys.executable, str(TEAM_GATE), "--workflow-mode", "peer",
               "--member-a", str(reports[0]), "--member-b", str(reports[1]),
               "--notes", str(project / "notes.md"), "--tag", TAG,
               "--project-root", str(project),
               "--member-a-evidence", str(evidence[0]), "--member-b-evidence", str(evidence[1]),
               "--assessor-model", "claude/fixture",
               "--assessor-runner", str(project / "fixture_assessor_launcher.py"),
               "--assessor-context-tokens", "1000000", "--assessor-context-bytes", "800000"]
    diagnostic = project / f"artifacts/runs/{TAG}/research_team/independent_reproduction_gate.json"
    return project, reports, command, calls, historical, diagnostic


def invoke(command):
    process = subprocess.run(command, capture_output=True, text=True, timeout=60)
    return process, json.loads(process.stdout)


def count_calls(path):
    return len(path.read_text().splitlines()) if path.is_file() else 0


def test_final_consumer_runs_once_per_acceptance_and_preserves_current_diagnostics(candidate):
    _, _, command, calls, historical, diagnostic = candidate
    previous_ref = str(historical)
    for attempt in (1, 2):
        process, result = invoke(command)
        assert process.returncode == 0, process.stderr
        assert count_calls(calls) == attempt
        assert result["meta"]["independent_confirmations"] == 2
        assert result["meta"]["verification_scope"] == "independent_reproduction"
        receipt = json.loads(diagnostic.read_text())
        assert receipt["status"] == "converged"
        assert receipt["meta"]["confirmation_refs"] == result["meta"]["confirmation_refs"]
        ref = result["meta"]["confirmation_refs"][0]
        assert ref["path"] != previous_ref
        assert ref["sha256"] == hashlib.sha256(Path(ref["path"]).read_bytes()).hexdigest()
        assert "- Gate: PASS" in process.stderr
        previous_ref = ref["path"]


def test_previous_success_cannot_mask_a_failed_current_assessor(candidate):
    _, _, command, calls, _, diagnostic = candidate
    accepted, _ = invoke(command)
    assert accepted.returncode == 0
    command[command.index("--assessor-model") + 1] = "claude/failure"
    failed, result = invoke(command)
    assert failed.returncode == 1
    assert count_calls(calls) == 2
    assert result["meta"]["independent_confirmations"] == 0
    assert result["meta"]["confirmation_refs"] == []
    receipt = json.loads(diagnostic.read_text())
    assert receipt["status"] == "not_converged"
    assert any("actual source-assessor invocation failed" in reason for reason in result["reasons"])
    assert set(receipt["reasons"]) <= set(result["reasons"])


def test_standalone_gate_still_executes_fresh_for_each_admission(candidate):
    _, _, command, calls, _, _ = candidate
    command[1] = str(TEAM_GATE.with_name("check_independent_reproduction.py"))
    mode = command.index("--workflow-mode")
    del command[mode:mode + 2]
    for member in ("a", "b"):
        report = command.index(f"--member-{member}")
        evidence = command.index(f"--member-{member}-evidence")
        command[report + 1] = command[evidence + 1]
        del command[evidence:evidence + 2]
    references = []
    for attempt in (1, 2):
        process, result = invoke(command)
        assert process.returncode == 0, process.stderr
        assert count_calls(calls) == attempt
        assert result["meta"]["independent_confirmations"] == 2
        ref = result["meta"]["confirmation_refs"][0]["path"]
        assert ref not in references
        references.append(ref)


def test_project_authored_diagnostic_cannot_supply_current_execution(candidate):
    _, _, command, calls, historical, diagnostic = candidate
    diagnostic.write_text(json.dumps({"status": "converged", "exit_code": 0,
        "meta": {"independent_confirmations": 2, "confirmation_refs": [{"path": str(historical)}]}}))
    index = command.index("--assessor-model")
    del command[index:index + 2]
    process, result = invoke(command)
    assert process.returncode == 1
    assert count_calls(calls) == 0
    assert result["meta"]["independent_confirmations"] == 0
    assert result["meta"]["confirmation_refs"] == []
    assert any("fresh source-assessor invocation is required" in reason for reason in result["reasons"])
    assert json.loads(diagnostic.read_text())["status"] == "not_converged"


@pytest.mark.parametrize("surface", ["raw_inputs", "executed_report"])
def test_changed_originals_refuse_before_model_dispatch(candidate, surface):
    project, reports, command, calls, _, _ = candidate
    path = project / "raw_inputs.json" if surface == "raw_inputs" else reports[0]
    path.write_text(path.read_text() + "\nchanged original bytes\n")
    process, result = invoke(command)
    assert process.returncode == 1
    assert count_calls(calls) == 0
    assert result["meta"]["independent_confirmations"] == 0
    assert result["meta"]["confirmation_refs"] == []
    assert any("original member report binding unavailable" in reason for reason in result["reasons"])


@pytest.mark.parametrize("failure,code", [("needs_revision", 1), ("parse_error", 2), ("early_stop", 3)])
def test_report_failure_cannot_borrow_old_confirmation(candidate, failure, code):
    _, reports, command, calls, _, diagnostic = candidate
    if failure == "needs_revision":
        reports[1].write_text(_team_report(verdict="needs revision"))
    elif failure == "parse_error":
        reports[1].write_text("Incomplete report.\n")
    else:
        reports[1].write_text(_team_report(extra="## Step 1: First\nStep verdict: CHALLENGED\n"
                                         "## Step 2: Second\nStep verdict: CHALLENGED\n"))
        command[command.index("--workflow-mode") + 1] = "leader"
    diagnostic.write_text('{"status":"converged","meta":{"independent_confirmations":2}}')
    process, result = invoke(command)
    assert process.returncode == code
    assert count_calls(calls) == 0
    assert result["status"] != "converged"
    assert result["meta"].get("independent_confirmations", 0) == 0
    assert result["meta"].get("confirmation_refs", []) == []


@pytest.mark.parametrize("rejection", ["contaminated", "rerun", "method-defect", "non-diagnostic"])
def test_final_consumer_still_requires_accepted_independent_lanes(candidate, rejection):
    _, _, command, calls, _, diagnostic = candidate
    command[command.index("--assessor-model") + 1] = "claude/" + rejection
    process, result = invoke(command)
    assert process.returncode == 1
    assert count_calls(calls) == 1
    assert result["meta"]["independent_confirmations"] == 0
    assert result["meta"]["confirmation_refs"] == []
    receipt = json.loads(diagnostic.read_text())
    assert receipt["status"] == "not_converged"
    assert any("UNVERIFIABLE_INDEPENDENCE" in reason for reason in result["reasons"])
    assert set(receipt["reasons"]) <= set(result["reasons"])
