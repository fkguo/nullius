"""Identity evidence and completed quorum are independent of route availability."""
import importlib.util
import json
from pathlib import Path
import sys


def launcher():
    source = Path(__file__).resolve().parents[1] / 'scripts/bin/run_multi_task.py'
    spec = importlib.util.spec_from_file_location('identity_launcher', source)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def roster():
    return {'version': 1, 'families': {
        'one': {'runner': 'claude-cli', 'models': {'default': 'named-one'}},
        'two': {'runner': 'opencode', 'models': {'default': 'provider/named-two'}},
    }, 'policy': {'cross_family_minimum': 2}}


def result(index, backend, model, **changes):
    return {'index': index, 'success': True, 'contract_ok': True,
            'resolved': {'backend': backend, 'model': model}, **changes}


def test_roster_present_unmatched_two_backend_lanes_have_no_quorum(monkeypatch, tmp_path):
    mod = launcher()
    monkeypatch.setenv('REVIEW_SWARM_NO_AUTO_CONFIG', '1')
    monkeypatch.setattr(mod, '_agents_runner_available', lambda _: True)
    config = tmp_path / 'agents.json'
    config.write_text(json.dumps(roster()))
    stub = tmp_path / 'runner.sh'
    stub.write_text('''#!/bin/bash
while [[ $# -gt 0 ]]; do
  case "$1" in --out) out="$2"; shift 2;; *) shift;; esac
done
printf '%s\\n' '{"verdict":"PASS","blocking_issues":[],"summary":"done"}' > "$out"
''')
    prompt = tmp_path / 'prompt'
    prompt.write_text('Inspect the supplied inputs.')
    out = tmp_path / 'out'
    monkeypatch.setattr(sys, 'argv', ['run_multi_task.py', '--out-dir', str(out),
        '--prompt', str(prompt), '--system', str(prompt), '--models', 'claude/unmatched,provider/unmatched',
        '--agents-file', str(config), '--claude-runner', str(stub), '--opencode-runner', str(stub),
        '--check-review-contract', '--check-convergence'])
    assert mod.main() == 0  # terminal deliveries may be useful, identities remain unknown
    meta = json.loads((out / 'meta.json').read_text())
    info = meta['independence']
    assert info['declared_available_families'] == ['one', 'two']
    assert info['machine_below_minimum'] is False
    assert info['below_minimum'] is True
    assert info['level'] == 'none'
    assert info['participating_families'] == []
    assert info['completed_eligible_count'] == 0
    assert all(a['family_evidence']['family'] == 'unknown' for a in meta['agents'])
    assert all(a['reported_model'] is None for a in meta['agents'])
    assert 'diversity' not in meta
    assert meta['convergence']['converged'] is False
    assert meta['convergence']['quorum_satisfied'] is False
    assert meta['convergence']['evaluated_outputs'] == []


def test_same_named_model_on_two_routes_without_roster_is_unknown():
    mod = launcher()
    rows = [result(0, 'claude', 'claude-same'), result(1, 'opencode', 'provider/claude-same')]
    info = mod._independence_summary(rows, None)
    assert info['level'] == 'none'
    assert info['completed_eligible_count'] == 0


def test_failed_invalid_contaminated_partial_never_complete_a_seat(monkeypatch):
    mod = launcher()
    monkeypatch.setattr(mod, '_agents_runner_available', lambda _: True)
    rows = [result(0, 'claude', 'named-one'),
            result(1, 'opencode', 'provider/named-two', success=False),
            result(2, 'opencode', 'provider/named-two', contract_ok=False),
            result(3, 'opencode', 'provider/named-two'),
            result(4, 'opencode', 'provider/named-two', partial=True)]
    info = mod._independence_summary(rows, roster(), contaminated_indices={3})
    assert info['participating_families'] == ['one']
    assert info['completed_eligible_count'] == 1
    assert info['below_minimum'] is True
    assert {r['reason'] for r in info['non_independent_lanes']} == {
        'not_completed', 'contract_invalid', 'AMBIENT_CONTEXT_CONTAMINATED', 'partial_output'}


def test_reported_identity_supersedes_requested_alias(monkeypatch):
    mod = launcher()
    monkeypatch.setattr(mod, '_agents_runner_available', lambda _: True)
    row = result(0, 'claude', 'named-one', reported_model='unmapped-actual')
    info = mod._independence_summary([row], roster())
    assert info['level'] == 'none'
    assert row['family_evidence']['model'] == 'unmapped-actual'
    assert row['family_evidence']['reported_by_cli'] is True
    assert row['family_evidence']['family'] == 'unknown'


def test_unchecked_delivery_does_not_supply_completed_review_quorum():
    mod = launcher()
    row = result(0, 'claude', 'named-one', contract_ok=None)
    info = mod._independence_summary([row], roster())
    assert info['completed_eligible_count'] == 0
    assert info['non_independent_lanes'][0]['reason'] == 'contract_unchecked'


def test_real_claude_runner_capture_separates_request_resolution_and_report(monkeypatch, tmp_path):
    mod = launcher()
    source = Path(__file__).resolve().parents[2] / 'claude-cli-runner/tests/test_progress_supervision.py'
    spec = importlib.util.spec_from_file_location('progress_fake_fixture', source)
    fake = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fake)
    _, env, _ = fake.setup(tmp_path, 'healthy')
    for name in ('PATH', 'CAPTURE_CASE', 'STARTED', 'MARKER'):
        monkeypatch.setenv(name, env[name])
    monkeypatch.setenv('REVIEW_SWARM_NO_AUTO_CONFIG', '1')
    monkeypatch.setattr(mod, '_agents_runner_available', lambda _: True)
    config = tmp_path / 'agents.json'
    config.write_text(json.dumps(roster()))
    out = tmp_path / 'review'
    monkeypatch.setattr(sys, 'argv', ['run_multi_task.py','--out-dir',str(out),
        '--prompt',str(tmp_path/'prompt'),'--system',str(tmp_path/'system'),
        '--models','claude/friendly-alias','--agents-file',str(config),
        '--claude-runner',str(fake.RUNNER),'--claude-live-capture', '--expected-secs','.1',
        '--inactivity-secs','.2','--inactivity-grace-secs','.2','--check-review-contract'])
    assert mod.main() == 0
    meta = json.loads((out/'meta.json').read_text())
    lane = meta['agents'][0]
    assert lane['requested']['model'] == 'claude/friendly-alias'
    assert lane['resolved']['model'] == 'friendly-alias'
    assert lane['reported_model'] == 'named-one'
    assert lane['family_evidence']['family'] == 'one'
    assert lane['family_evidence']['reported_by_cli'] is True
    assert lane['completed_eligible'] is True
    assert lane['independence_evidence']['method'] == 'not_machine_verified'
    assert lane['independence_evidence']['input_framing'] == 'not_machine_verified'
    assert lane['progress']['advancing_events'] == 12
    assert meta['hard_budget_secs'] is None
    assert 'PRIVATE_REASONING' not in json.dumps(meta)


def test_partial_body_never_reaches_swarm_contract_or_quorum(monkeypatch, tmp_path):
    mod = launcher()
    source = Path(__file__).resolve().parents[2] / 'claude-cli-runner/tests/test_progress_supervision.py'
    spec = importlib.util.spec_from_file_location('incomplete_fake_fixture', source)
    fake = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fake)
    _, env, _ = fake.setup(tmp_path, 'incomplete')
    for name in ('PATH', 'CAPTURE_CASE', 'STARTED', 'MARKER'):
        monkeypatch.setenv(name, env[name])
    monkeypatch.setenv('REVIEW_SWARM_NO_AUTO_CONFIG', '1')
    monkeypatch.setattr(mod, '_agents_runner_available', lambda _: True)
    config = tmp_path / 'agents.json'
    config.write_text(json.dumps(roster()))
    out = tmp_path/'review'
    monkeypatch.setattr(sys, 'argv', ['run_multi_task.py','--out-dir',str(out),
        '--prompt',str(tmp_path/'prompt'),'--system',str(tmp_path/'system'),
        '--models','claude/named-one','--agents-file',str(config),
        '--claude-runner',str(fake.RUNNER),'--claude-live-capture','--check-review-contract'])
    assert mod.main() == 2
    meta = json.loads((out/'meta.json').read_text())
    lane = meta['agents'][0]
    assert not Path(lane['out']).exists()
    assert Path(lane['out']+'.partial').exists()
    assert lane['success'] is False
    assert lane['failure_reason'] == 'incomplete_or_error_result'
    assert lane['contract_ok'] is False
    assert meta['independence']['completed_eligible_count'] == 0
