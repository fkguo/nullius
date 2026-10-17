"""Exercise the actual assessor adapter/launcher/gate/consumer chain offline."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from reproduction_assessment_fixture import create_assessment
from test_independent_reproduction_gate import _make_project, _seed_member, _run_gate, _member_dir, _write, TAG
from test_convergence_gate_json import _team_report, TEAM_GATE


def setup(proj, *, structured_reports=False):
    report_text = _team_report() if structured_reports else None
    a, b = _seed_member(proj, "member_a", report_text=report_text), _seed_member(proj, "member_b", report_text=report_text)
    proc, assessment = create_assessment(proj, TAG, a, b)
    assert proc.returncode == 0, proc.stderr
    return a, b, assessment


@pytest.mark.parametrize("model,accepted", [("claude/fixture", True), ("claude/contaminated", False),
    ("claude/rerun", False), ("claude/method-defect", False), ("claude/non-diagnostic", False)])
def test_actual_adapter_output_is_consumed(tmp_path, model, accepted):
    proj = _make_project(tmp_path)
    a, b = _seed_member(proj, "member_a"), _seed_member(proj, "member_b")
    executed, _ = create_assessment(proj, TAG, a, b, model=model)
    assert executed.returncode == 0, executed.stderr
    proc, payload = _run_gate(proj, a, b, assess=False)
    assert (proc.returncode == 0) is accepted
    assert payload["meta"]["independent_confirmations"] == (2 if accepted else 0)


@pytest.mark.parametrize("edited", ["raw", "source", "output", "assessment", "transport", "prompt"])
def test_freshness_binds_every_evidence_surface(tmp_path, edited):
    proj = _make_project(tmp_path)
    a, b, assessment = setup(proj)
    receipt = json.loads(assessment.read_text())
    transport = proj / receipt["transport_ref"]["path"]
    changes = {"raw": proj / "raw_inputs.json", "source": _member_dir(proj, "member_a") / "constructed_sum.py",
        "output": proj / json.loads(a.read_text())["commands_run"][0]["output_path"], "assessment": assessment,
        "transport": transport, "prompt": proj / json.loads(transport.read_text())["prompt"]["path"]}
    path = changes[edited]
    if edited == "assessment":
        receipt["independence_assessments"][0]["input_independent"] = "true"
        path.write_text(json.dumps(receipt))
    else:
        path.write_text(path.read_text() + "\nchanged\n")
    proc, _ = _run_gate(proj, a, b, assess=False)
    assert proc.returncode != 0


def test_failed_launcher_cannot_reuse_previous_success(tmp_path):
    proj = _make_project(tmp_path)
    a, b, assessment = setup(proj)
    proc, _ = create_assessment(proj, TAG, a, b, model="claude/failure")
    assert proc.returncode != 0 and not assessment.exists()
    gate, result = _run_gate(proj, a, b, assess=False)
    assert gate.returncode != 0
    assert result["meta"]["confirmation_refs"] == []


def test_shared_locator_disposition_requires_both_constructed_bodies():
    from check_independent_reproduction import evaluate_assessment
    lanes = [{"execution_id": f"anonymous-{i}", "derivation": f"Own source {i} accumulates each raw operand exactly once."} for i in range(2)]
    for d in lanes:
        d["construction_body"] = d["derivation"]
    packet = {"input_sha256": "anonymous-input", "derivations": lanes,
              "shared_source_locators": ["shared helper referenced by both sources"]}
    records = [{"index": i, "input_independent": True, "execution_independent": True,
                "construction_independent": True, "method_applicable": True, "diagnostic": True,
                "unresolved_defects": [], "evidence": {axis: {"source_span": d["derivation"],
                "reason": "The exact anonymous body supports this controlled protocol field."}
                for axis in ("input", "execution", "construction", "applicability", "diagnostic")}}
               for i,d in enumerate(lanes)]
    result = {"input_sha256": packet["input_sha256"], "assessor_role": "independent_source_review",
              "independence_assessments": records}
    assert evaluate_assessment(packet,result)[0] == []
    disposition = {"locator": packet["shared_source_locators"][0], "independence_preserved": True,
                   "reason": "The complete constructed sources independently apply the neutral operand rule.",
                   "evidence": [{"index": i, "source_span": d["construction_body"],
                                 "reason": "This exact constructed body performs its own complete arithmetic."}
                                for i,d in enumerate(lanes)]}
    result["shared_source_assessments"] = [disposition]
    assert evaluate_assessment(packet,result)[0] == [0,1]
    disposition["evidence"] = disposition["evidence"][:1]
    assert evaluate_assessment(packet,result)[0] == []
    result["shared_source_assessments"] = [disposition,disposition]
    assert evaluate_assessment(packet,result)[0] == []



def test_crlf_constructed_bodies_match_quotes_written_with_plain_newlines():
    from check_independent_reproduction import evaluate_assessment
    lanes = [{"execution_id": f"anonymous-{i}",
              "derivation": f"src/own_{i}.py:\r\ntotal = 0\r\nfor value in values: total += value\r\n"} for i in range(2)]
    for d in lanes:
        d["construction_body"] = d["derivation"]
    quotes = [d["derivation"].replace("\r\n", "\n").strip() for d in lanes]
    assert all(q not in d["construction_body"] for q, d in zip(quotes, lanes))
    packet = {"input_sha256": "anonymous-input", "derivations": lanes,
              "shared_source_locators": ["shared helper referenced by both sources"]}
    records = [{"index": i, "input_independent": True, "execution_independent": True,
                "construction_independent": True, "method_applicable": True, "diagnostic": True,
                "unresolved_defects": [], "evidence": {axis: {"source_span": quotes[i],
                "reason": "The exact anonymous body supports this controlled protocol field."}
                for axis in ("input", "execution", "construction", "applicability", "diagnostic")}}
               for i in range(2)]
    disposition = {"locator": packet["shared_source_locators"][0], "independence_preserved": True,
                   "reason": "The complete constructed sources independently apply the neutral operand rule.",
                   "evidence": [{"index": i, "source_span": quotes[i],
                                 "reason": "This exact constructed body performs its own complete arithmetic."} for i in range(2)]}
    result = {"input_sha256": packet["input_sha256"], "assessor_role": "independent_source_review",
              "independence_assessments": records, "shared_source_assessments": [disposition]}
    assert evaluate_assessment(packet, result)[0] == [0, 1]
    # Only line endings compare as equal; other text in the quote still has to be in the body.
    disposition["evidence"][1]["source_span"] = quotes[1].replace("+=", "-=")
    assert evaluate_assessment(packet, result)[0] == []


def test_recursive_shared_library_and_raw_input_closure(tmp_path):
    proj = _make_project(tmp_path)
    _write(proj / "shared_math.py", "import nested_math\ndef combine(values):\n    return nested_math.combine(values)\n")
    nested = _write(proj / "nested_math.py", "def combine(values):\n    return sum(values)\n")
    # Both offline member episodes actually import/call the recursive library
    # with raw input. This validates closure transport, not scientific approval.
    def member_source(member):
        result = f"artifacts/runs/{TAG}/research_team/{member}/independent/result.json"
        return ('import json, pathlib, sys\n'
                'sys.path.insert(0, str(pathlib.Path.cwd()))\nimport shared_math\n'
                'data = json.loads(pathlib.Path("raw_inputs.json").read_text())\n'
                'answer = shared_math.combine(data["values"])\nprint(answer)\n'
                'pathlib.Path(' + repr(result) + ').write_text(json.dumps({"value": answer})+"\\n")\n')
    a = _seed_member(proj, "member_a", construction_source=member_source("member_a"))
    b = _seed_member(proj, "member_b", construction_source=member_source("member_b"))
    for ev_path in (a, b):
        ev = json.loads(ev_path.read_text())
        command = ev["commands_run"][0]
        assert command["exit_code"] == 0
        inputs = {item["path"]: item for item in command["input_files"]}
        assert {"raw_inputs.json", "shared_math.py", "nested_math.py"} <= inputs.keys()
        for item in inputs.values():
            assert item["sha256"] == hashlib.sha256((proj / item["path"]).read_bytes()).hexdigest()
        assert (proj / command["output_path"]).read_bytes().strip()
    proc, assessment = create_assessment(proj, TAG, a, b)
    assert proc.returncode == 0, proc.stderr
    accepted, disposition = _run_gate(proj, a, b, assess=False)
    # Whole input transport succeeds, but an examiner that never disposes
    # the shared-computation locator cannot grant independent confirmation.
    assert accepted.returncode != 0
    assert disposition["meta"]["independent_confirmations"] == 0
    assert any("shared source" in reason for reason in disposition["reasons"])
    packet_path = proj / json.loads((proj / json.loads(assessment.read_text())["transport_ref"]["path"]).read_text())["prompt"]["path"]
    packet = json.loads(packet_path.read_text())
    assert {"raw_inputs.json", "shared_math.py", "nested_math.py"} <= packet["sources"].keys()
    assert packet["shared_source_locators"]
    assert all("shared_math.py:\n" not in lane["construction_body"] for lane in packet["derivations"])
    assert all(lane["source_roles"]["shared_math.py"] == "external_to_member_construction" for lane in packet["derivations"])
    assert all(any(f"{member} executes external project source '{name}'" == locator
                   for locator in packet["shared_source_locators"])
               for member in ("member_a", "member_b") for name in ("shared_math.py", "nested_math.py"))
    nested.write_text("def combine(values):\n    return sum(values) + 1\n")
    stale, _ = _run_gate(proj, a, b, assess=False)
    assert stale.returncode != 0


def test_one_member_external_computation_requires_source_disposition(tmp_path):
    from check_independent_reproduction import assessment_packet, _collect_member_sources
    proj = _make_project(tmp_path)
    _write(proj / "shared_utils" / "__init__.py", "def calculate(values):\n    return sum(values)\n")
    result = f"artifacts/runs/{TAG}/research_team/member_a/independent/result.json"
    source = ('import json, pathlib, sys\n'
              'sys.path.insert(0, str(pathlib.Path.cwd()))\nimport shared_utils\n'
              'data = json.loads(pathlib.Path("raw_inputs.json").read_text())\n'
              'answer = shared_utils.calculate(data["values"])\nprint(answer)\n'
              'pathlib.Path(' + repr(result) + ').write_text(json.dumps({"value": answer})+"\\n")\n')
    a = _seed_member(proj, "member_a", construction_source=source)
    b = _seed_member(proj, "member_b")
    lanes = {m: _collect_member_sources(m, _member_dir(proj, m)) for m in ("member_a", "member_b")}
    packet = assessment_packet(lanes, {"member_a": a, "member_b": b}, proj)
    locator = "member_a executes external project source 'shared_utils/__init__.py'"
    assert locator in packet["shared_source_locators"]
    assert not any("member_b executes external project source" in item for item in packet["shared_source_locators"])
    proc, value = _run_gate(proj, a, b)
    assert proc.returncode != 0
    assert value["meta"]["independent_confirmations"] == 0
    assert any("shared source" in reason for reason in value["reasons"])


@pytest.mark.parametrize("gate_enabled", [True, False])
def test_consumer_rejects_nonempty_prose_and_skip_bypass(tmp_path, gate_enabled):
    proj = _make_project(tmp_path, gate_enabled=gate_enabled)
    a = _write(proj / "a.md", _team_report() + "\n## Independent Derivation\nI independently checked it.\n")
    b = _write(proj / "b.md", a.read_text())
    proc = subprocess.run([sys.executable, str(TEAM_GATE), "--member-a", str(a), "--member-b", str(b),
        "--notes", str(proj / "notes.md"), "--project-root", str(proj), "--tag", TAG,
        "--member-a-evidence", str(proj / "a.json"), "--member-b-evidence", str(proj / "b.json")], capture_output=True, text=True)
    assert proc.returncode == 1
    assert json.loads(proc.stdout)["meta"]["independent_confirmations"] == 0


def test_consumer_carries_only_fresh_confirmation_refs(tmp_path):
    proj = _make_project(tmp_path)
    aev, bev, assessment = setup(proj, structured_reports=True)
    a = proj / json.loads(aev.read_text())["original_transport"]["stages"]["final"]["output"]["path"]
    b = proj / json.loads(bev.read_text())["original_transport"]["stages"]["final"]["output"]["path"]
    cmd = [sys.executable, str(TEAM_GATE), "--member-a", str(a), "--member-b", str(b),
        "--notes", str(proj / "notes.md"), "--project-root", str(proj), "--tag", TAG,
        "--member-a-evidence", str(aev), "--member-b-evidence", str(bev),
        "--assessor-context-tokens", "1000000", "--assessor-context-bytes", "800000", "--assessor-model", "claude/fixture", "--assessor-runner", str(proj / "fixture_assessor_launcher.py")]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    meta = json.loads(proc.stdout)["meta"]
    assert meta["independent_confirmations"] == 2 and meta["verification_scope"] == "independent_reproduction"
    actual = Path(meta["confirmation_refs"][0]["path"])
    assert actual != assessment and actual.is_file()
    assert meta["confirmation_refs"][0]["sha256"] == hashlib.sha256(actual.read_bytes()).hexdigest()
    (proj / "raw_inputs.json").write_text('{"values":[17,26]}')
    assert subprocess.run(cmd, capture_output=True).returncode == 1


def test_imported_author_receipt_has_no_current_invocation_authority(tmp_path):
    proj = _make_project(tmp_path)
    a, b, assessment = setup(proj)
    # Retain even a fully valid historical assessment. A caller supplies no
    # fresh runner/model, so none of its imported booleans can count now.
    gate = Path(__file__).resolve().parents[1] / "scripts/gates/check_independent_reproduction.py"
    proc = subprocess.run([sys.executable, str(gate), "--notes", str(proj / "notes.md"),
        "--project-root", str(proj), "--tag", TAG, "--member-a", str(a), "--member-b", str(b),
        "--assessment", str(assessment)], capture_output=True, text=True)
    result = json.loads(proc.stdout)
    assert proc.returncode == 1 and result["meta"]["independent_confirmations"] == 0
    assert "fresh source-assessor invocation" in " ".join(result["reasons"])


def test_consumer_cannot_promote_a_historical_receipt_without_fresh_call(tmp_path):
    proj = _make_project(tmp_path)
    aev, bev, _ = setup(proj)
    a, b = _write(proj / "a.md", _team_report()), _write(proj / "b.md", _team_report())
    proc = subprocess.run([sys.executable, str(TEAM_GATE), "--member-a", str(a), "--member-b", str(b),
        "--notes", str(proj / "notes.md"), "--project-root", str(proj), "--tag", TAG,
        "--member-a-evidence", str(aev), "--member-b-evidence", str(bev)], capture_output=True, text=True)
    result = json.loads(proc.stdout)
    assert proc.returncode == 1 and result["meta"]["independent_confirmations"] == 0


def test_explicit_project_method_risk_cannot_be_erased_by_same_method_execution(tmp_path):
    proj = _make_project(tmp_path)
    cfg = json.loads((proj / "research_team_config.json").read_text())
    cfg["independent_reproduction"] = {"requires_method_diversity": True,
        "method_diversity_risk": "A shared construction must be checked by a distinct mechanism."}
    (proj / "research_team_config.json").write_text(json.dumps(cfg))
    a, b, _ = setup(proj)
    proc, payload = _run_gate(proj, a, b, assess=False)
    assert proc.returncode == 1 and payload["meta"]["independent_confirmations"] == 0
    assert "project shared-failure/method-risk" in " ".join(payload["reasons"])


def test_substituted_ready_reports_cannot_mask_the_executed_report(tmp_path):
    proj = _make_project(tmp_path)
    aev, bev, _ = setup(proj, structured_reports=True)
    substitute = _write(proj / 'substitute.md', _team_report())
    proc = subprocess.run([sys.executable,str(TEAM_GATE),'--member-a',str(substitute),'--member-b',str(substitute),
        '--notes',str(proj/'notes.md'),'--project-root',str(proj),'--tag',TAG,
        '--member-a-evidence',str(aev),'--member-b-evidence',str(bev),
        '--assessor-context-tokens','1000000','--assessor-context-bytes','800000','--assessor-model','claude/fixture','--assessor-runner',str(proj/'fixture_assessor_launcher.py')],capture_output=True,text=True)
    result=json.loads(proc.stdout)
    assert proc.returncode == 1 and result['meta']['independent_confirmations'] == 0
    assert 'original executed member report' in ' '.join(result['reasons'])
