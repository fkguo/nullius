"""Execute neutral-input routing; no semantic reviewer or research claim is mocked as fact."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/bin/team_cycle_prepare_reproduction_packet.py"
spec = importlib.util.spec_from_file_location("reproduction_packet_route", SCRIPT)
route = importlib.util.module_from_spec(spec)
spec.loader.exec_module(route)


def fixture(tmp_path, enabled=True, configured=None):
    notes = tmp_path / "research_notebook.md"
    notes.write_text("Candidate reference answer and author construction.\n", encoding="utf-8")
    (tmp_path / "research_team_config.json").write_text(json.dumps({
        "version": 1, "features": {"independent_reproduction_gate": enabled},
        "independent_reproduction": {"blind_packet": configured}}), encoding="utf-8")
    candidate = tmp_path / "candidate.txt"
    candidate.write_text("Candidate answer, author algorithm and reported output.\n", encoding="utf-8")
    output = tmp_path / "artifacts/runs/anonymous/research_team/reproduction_packet.txt"
    return notes, candidate, output


def test_enabled_gate_cannot_silently_reuse_full_candidate_packet(tmp_path):
    notes, candidate, output = fixture(tmp_path)
    with pytest.raises(ValueError, match="requires --reproduction-packet"):
        route.prepare_packet(notes, tmp_path, candidate, output)
    assert not output.exists()


@pytest.mark.parametrize("configured", [False, True])
def test_explicit_neutral_original_is_frozen_exactly_in_both_member_stage_route(tmp_path, configured):
    raw = b"Question: derive from original operands.\nRaw inputs: 17, 25.\n"
    source = tmp_path / "neutral.txt"
    source.write_bytes(raw)
    notes, candidate, output = fixture(tmp_path, configured="neutral.txt" if configured else None)
    systems = [tmp_path / f"system-{i}.txt" for i in range(2)]
    for system in systems:
        system.write_text("Earlier candidate-comparison duties.\n", encoding="utf-8")
    argv = [sys.executable, str(SCRIPT), "--notes", str(notes), "--project-root", str(tmp_path),
        "--packet", str(candidate), "--out", str(output),
        "--system-a", str(systems[0]), "--system-b", str(systems[1]),
        "--system-a-out", str(output.parent / "member-a-system.txt"),
        "--system-b-out", str(output.parent / "member-b-system.txt")]
    if not configured:
        argv += ["--source", str(source)]
    process = subprocess.run(argv, capture_output=True, text=True, check=False)
    assert process.returncode == 0, process.stderr
    assert Path(process.stdout.strip()) == output
    assert output.read_bytes() == raw
    assert "Candidate answer" not in output.read_text()
    for path in (output.parent / "member-a-system.txt", output.parent / "member-b-system.txt"):
        content = path.read_text()
        assert content.index("This stage instruction takes precedence") > content.index("Earlier candidate-comparison")
        assert "Do not request candidate answers" in content
    # An unchanged resume observes the same original; changed source cannot rewrite history.
    assert subprocess.run(argv, capture_output=True, text=True).returncode == 0
    source.write_text("Changed neutral input.\n", encoding="utf-8")
    assert subprocess.run(argv, capture_output=True, text=True).returncode == 2
    assert output.read_bytes() == raw


def test_disabled_gate_retains_candidate_review_route_without_constructing_false_blindness(tmp_path):
    notes, candidate, output = fixture(tmp_path, enabled=False)
    assert route.prepare_packet(notes, tmp_path, candidate, output) == candidate.resolve()
    assert not output.exists()


@pytest.mark.parametrize("bad", ["outside", "symlink", "invalid_utf8"])
def test_neutral_packet_cannot_escape_or_hide_unread_original(tmp_path, bad):
    notes, candidate, output = fixture(tmp_path)
    source = tmp_path / "neutral.txt"
    source.write_text("Neutral original question.\n", encoding="utf-8")
    if bad == "outside":
        source = tmp_path.parent / (tmp_path.name + "-outside.txt")
        source.write_text("Outside input.\n", encoding="utf-8")
    elif bad == "symlink":
        target = source
        source = tmp_path / "alias.txt"
        source.symlink_to(target)
    else:
        source.write_bytes(b"invalid\xff")
    with pytest.raises((ValueError, UnicodeError)):
        route.prepare_packet(notes, tmp_path, candidate, output, source)
    assert not output.exists()


def test_cycle_routes_both_full_access_members_only_to_selected_neutral_packet():
    cycle = SCRIPT.with_name("run_team_cycle.sh").read_text()
    assert cycle.count('--packet "${member_packet_for_run}" --system "${member_') == 2
    assert "team_cycle_prepare_reproduction_packet.py" in cycle
    assert "--reproduction-packet" in cycle


CAPACITY_READER = SCRIPT.with_name("team_cycle_get_review_settings.py")


def capacity_project(tmp_path, block):
    notes = tmp_path / "research_notebook.md"
    notes.write_text("Anonymous protocol fixture; no scientific approval.\n")
    (tmp_path / "research_team_config.json").write_text(json.dumps({
        "review_access_mode": "full_access", "independent_reproduction": block}))
    return notes


def test_exact_assessor_budget_reaches_the_single_final_cycle_route(tmp_path):
    # Execute the actual shell routing fragments with argv-only process spies.
    # They report no gate verdict, review, model output or scientific approval.
    notes = capacity_project(tmp_path, {"assessor_context_tokens": 1000000,
        "assessor_context_bytes": 800000, "assessor_timeout_secs": 900})
    spy = tmp_path / "argv_spy.py"
    spy.write_text("import json,os,sys\nprint(json.dumps({'argv':sys.argv[1:],'pid':os.getpid()}))\n")
    cycle = SCRIPT.with_name("run_team_cycle.sh").read_text()
    capacity = cycle.split("# Source-assessor capacity settings:", 1)[1].split("\n", 1)[1].split("# Member runner settings", 1)[0]
    final = '  gate_cmd=(\n' + cycle.split('  gate_cmd=(\n', 1)[1].split('\n  )', 1)[0] + '\n  )\n"${gate_cmd[@]}"\n'
    script = tmp_path / "route.sh"
    script.write_text("set -euo pipefail\n" + capacity + final)
    import os
    env = dict(os.environ)
    env.pop("RESEARCH_TEAM_CONFIG", None)
    env.update(REVIEW_SETTINGS_SCRIPT=str(CAPACITY_READER), NOTEBOOK_PATH=str(notes),
        GATE_SCRIPT=str(spy), RESOLVED_TAG="anonymous",
        member_a_evidence="a.json", member_b_evidence="b.json", PROJECT_ROOT=str(tmp_path),
        run_dir=str(tmp_path), member_a_out="a.md", member_b_out="b.md",
        WORKFLOW_MODE="peer", gate_sweep_flag="--no-require-sweep", INDEPENDENCE_ASSESSOR_SPEC="claude/opus")
    process = subprocess.run(["bash", str(script)], env=env, cwd=tmp_path,
        capture_output=True, text=True, timeout=10)
    assert process.returncode == 0, process.stderr
    calls = [json.loads(line) for line in process.stdout.splitlines()]
    assert len(calls) == 1
    for call in calls:
        argv = call["argv"]
        for flag, value in (("--assessor-model", "claude/opus"),
            ("--assessor-context-tokens", "1000000"), ("--assessor-context-bytes", "800000"),
            ("--assessor-timeout-secs", "900")):
            assert argv.count(flag) == 1 and argv[argv.index(flag)+1] == value
    assert "--member-a-evidence" in calls[0]["argv"]
    assert "--assessment" not in calls[0]["argv"]


def test_unset_assessor_bytes_retains_the_conservative_executor_default(tmp_path):
    notes = capacity_project(tmp_path, {})
    import os
    env = dict(os.environ); env.pop("RESEARCH_TEAM_CONFIG", None)
    proc = subprocess.run([sys.executable, str(CAPACITY_READER), "--notes", str(notes), "--assessor-capacity"],
        env=env, capture_output=True, text=True, timeout=10)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.splitlines() == ["--assessor-context-tokens", "200000", "--assessor-timeout-secs", "1200"]


@pytest.mark.parametrize('raw',[b'{ invalid JSON',b'[]',b'{"independent_reproduction":{"assessor_context_tokens":NaN}}',b'{"independent_reproduction":{},"independent_reproduction":{}}',b'\xff'])
def test_unreadable_or_malformed_control_input_cannot_dispatch_default_budget(tmp_path,raw):
    notes=capacity_project(tmp_path,{})
    (tmp_path/'research_team_config.json').write_bytes(raw)
    import os
    env=dict(os.environ);env.pop('RESEARCH_TEAM_CONFIG',None)
    proc=subprocess.run([sys.executable,str(CAPACITY_READER),'--notes',str(notes),'--assessor-capacity'],
                        env=env,text=True,capture_output=True,timeout=10)
    assert proc.returncode==2 and not proc.stdout
    assert 'unavailable assessor capacity configuration' in proc.stderr


@pytest.mark.parametrize('kind',['directory','dangling','explicit_missing'])
def test_broken_or_explicit_missing_capacity_config_does_not_fall_back(tmp_path,kind):
    notes=capacity_project(tmp_path,{})
    config=tmp_path/'research_team_config.json';config.unlink()
    import os
    env=dict(os.environ);env.pop('RESEARCH_TEAM_CONFIG',None)
    if kind=='directory':config.mkdir()
    elif kind=='dangling':config.symlink_to(tmp_path/'missing.json')
    else:env['RESEARCH_TEAM_CONFIG']=str(tmp_path/'explicit-missing.json')
    proc=subprocess.run([sys.executable,str(CAPACITY_READER),'--notes',str(notes),'--assessor-capacity'],
                        env=env,text=True,capture_output=True,timeout=10)
    assert proc.returncode==2 and not proc.stdout


@pytest.mark.parametrize('field,value', [
    ('assessor_context_tokens', True), ('assessor_context_tokens', '1000000'),
    ('assessor_context_tokens', 40960), ('assessor_context_bytes', False),
    ('assessor_context_bytes', '800000'), ('assessor_context_bytes', 11999),
    ('assessor_timeout_secs', True), ('assessor_timeout_secs', 1201),
    ('assessor_timeout_secs', 0), ('assessor_timeout_secs', '900'),
])
def test_invalid_assessor_configuration_has_no_default_success_fallback(tmp_path, field, value):
    notes = capacity_project(tmp_path, {field: value})
    import os
    env = dict(os.environ); env.pop("RESEARCH_TEAM_CONFIG", None)
    proc = subprocess.run([sys.executable, str(CAPACITY_READER), "--notes", str(notes), "--assessor-capacity"],
        env=env, capture_output=True, text=True, timeout=10)
    assert proc.returncode == 2 and not proc.stdout
    assert "unavailable assessor capacity configuration" in proc.stderr


def test_cycle_capacity_and_public_config_prose_stay_aligned():
    cycle = SCRIPT.with_name("run_team_cycle.sh").read_text()
    root = SCRIPT.parents[2]
    template = json.loads((root / "assets/research_team_config_template.json").read_text())
    guide = (root / "references/usage_guide.md").read_text()
    assert cycle.count('"${independence_assessor_capacity_flags[@]}"') == 1
    assert 'check_independent_reproduction.py' not in cycle
    assert 'it SKIPs (exit 0) on projects without a nullius' not in cycle
    for key, value in (("assessor_context_tokens", 200000), ("assessor_context_bytes", None), ("assessor_timeout_secs", 1200)):
        assert template["independent_reproduction"][key] == value
        assert key in guide
    assert "one fresh source-assessor invocation at the final convergence consumer" in guide
    assert "without truncation" in guide
