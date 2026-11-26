import importlib.util
import json
import shlex
import sys
import time
from pathlib import Path

import pytest


@pytest.fixture
def launcher(monkeypatch):
    monkeypatch.setenv('REVIEW_SWARM_NO_AUTO_CONFIG', '1')
    path = Path(__file__).resolve().parents[1] / 'scripts/bin/run_multi_task.py'
    spec = importlib.util.spec_from_file_location('budget_launcher', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def runner(tmp_path, name, behavior, delay=0):
    log = tmp_path / 'calls.jsonl'
    script = tmp_path / f'{name}.py'
    script.write_text(f'''import json, sys, time
from pathlib import Path
args = sys.argv[1:]
with open({str(log)!r}, 'a') as log:
    log.write(json.dumps({{"backend": {name!r}, "args": args}}) + '\\n')
out = Path(args[args.index('--out') + 1])
time.sleep({delay!r})
behavior = {behavior!r}
if behavior == 'fail':
    sys.exit(3)
elif behavior == 'nonempty-fail':
    out.write_text('Original failed output; retain these bytes.')
    sys.exit(3)
elif behavior == 'empty':
    out.write_text('')
elif behavior == 'two-phase' and '.phase1.' in out.name:
    out.write_text('<review_criteria>\\n' + json.dumps({{"categories": [{{"name": "correctness", "blocking_criteria": "Behavior contradicts the contract."}}], "severity_scale": "BLOCKING, HIGH, LOW"}}) + '\\n</review_criteria>\\n')
else:
    out.write_text('VERDICT: READY\\n')
''')
    shell = tmp_path / f'run_{name}.sh'
    shell.write_text(f'#!/bin/bash\nexec {shlex.quote(sys.executable)} {shlex.quote(str(script))} "$@"\n')
    return shell


def run(launcher, monkeypatch, tmp_path, primary, *, extra=(), fallback=None):
    system = tmp_path / 'system.md'
    prompt = tmp_path / 'prompt.md'
    scope = tmp_path / 'scope.md'
    for file in (system, prompt, scope):
        file.write_text('Check the supplied public contract.')
    out = tmp_path / 'out'
    argv = ['run_multi_task.py', '--out-dir', str(out), '--system', str(system),
            '--prompt', str(prompt), '--models', 'codex/default',
            '--codex-runner', str(primary)]
    if '--two-phase' in extra:
        argv += ['--scope-prompt', str(scope)]
    if fallback:
        argv += ['--gemini-runner', str(fallback), '--fallback-mode', 'auto',
                 '--fallback-target-backends', 'codex', '--fallback-order', 'gemini,codex']
    monkeypatch.setattr(sys, 'argv', argv + list(extra))
    code = launcher.main()
    meta = json.loads((out / 'meta.json').read_text())
    calls = [json.loads(line) for line in (tmp_path / 'calls.jsonl').read_text().splitlines()]
    return code, meta, calls


def test_empty_retries_share_total_two_call_budget(launcher, monkeypatch, tmp_path):
    primary = runner(tmp_path, 'codex', 'empty')
    code, meta, calls = run(launcher, monkeypatch, tmp_path, primary,
                            extra=['--max-attempts', '2', '--retry-empty-output', '8'])
    assert code == 2
    assert len(calls) == 2
    assert meta['agents'][0]['failure_reason'] == 'attempt_budget_exhausted'
    assert meta['agents'][0]['seat_budget']['runner_invocations'] == 2
    assert meta['agents'][0]['empty_output_retries'] == 1
    assert meta['unavailable_backends']


def test_outer_fallback_shares_total_two_call_budget(launcher, monkeypatch, tmp_path):
    primary = runner(tmp_path, 'codex', 'fail')
    fallback = runner(tmp_path, 'gemini', 'fail')
    code, meta, calls = run(launcher, monkeypatch, tmp_path, primary,
                            extra=['--max-attempts', '2'], fallback=fallback)
    assert code == 2
    assert [call['backend'] for call in calls] == ['codex', 'gemini']
    assert meta['agents'][0]['failure_reason'] == 'attempt_budget_exhausted'


def test_successful_fallback_keeps_failed_original_and_gets_its_own_observation(launcher, monkeypatch, tmp_path):
    primary = runner(tmp_path, 'codex', 'nonempty-fail')
    fallback = runner(tmp_path, 'gemini', 'ready')
    code, meta, calls = run(launcher, monkeypatch, tmp_path, primary, extra=['--max-attempts', '2'], fallback=fallback)
    assert code == 0 and len(calls) == 2
    first, second = [Path(call['args'][call['args'].index('--out') + 1]) for call in calls]
    assert first != second
    assert first.read_text() == 'Original failed output; retain these bytes.'
    assert second.read_text() == 'VERDICT: READY\n'
    assert Path(meta['agents'][0]['out']) == second
    import runtime_capture_observation
    from hashlib import sha256
    hashes = [sha256((tmp_path / name).read_bytes()).hexdigest() for name in ('system.md', 'prompt.md')]
    runtime_capture_observation.verify_capture_observation(None, second, hashes, str(Path.cwd()))


def test_two_phase_uses_one_seat_budget(launcher, monkeypatch, tmp_path):
    primary = runner(tmp_path, 'codex', 'two-phase')
    code, meta, calls = run(launcher, monkeypatch, tmp_path, primary,
                            extra=['--max-attempts', '1', '--two-phase'])
    assert code == 2
    assert len(calls) == 1
    assert meta['agents'][0]['failure_reason'] == 'attempt_budget_exhausted'
    assert meta['agents'][0]['two_phase']['criteria_ok'] is True


@pytest.mark.parametrize('two_phase', [False, True])
def test_total_deadline_is_not_reset_for_next_call(launcher, monkeypatch, tmp_path, two_phase):
    primary = runner(tmp_path, 'codex', 'two-phase' if two_phase else 'fail', delay=0.65)
    fallback = None if two_phase else runner(tmp_path, 'gemini', 'ready', delay=0.65)
    start = time.monotonic()
    code, meta, calls = run(launcher, monkeypatch, tmp_path, primary,
                            extra=['--timeout-secs', '1', '--two-phase'] if two_phase else ['--timeout-secs', '1'],
                            fallback=fallback)
    assert time.monotonic() - start < 1.8
    assert code == 2
    assert len(calls) == 2
    assert meta['agents'][0]['success'] is False
    assert meta['agents'][0]['seat_budget']['timeout_secs'] == 1


@pytest.mark.parametrize('backend,expected', [
    ('codex', ['--max-retries', '1']),
    ('claude', ['--max-retries', '1']),
    ('kimi', ['--max-attempts', '1', '--no-fallback']),
    ('opencode', ['--max-attempts', '3', '--no-fallback', '--continue-on-length', '2', '--no-retry', '--final-response-only']),
    ('gemini', ['--no-fallback']),
])
def test_build_cmd_uses_supported_inner_budget_flags(launcher, tmp_path, backend, expected):
    plan = launcher.AgentPlan(index=0, backend=backend, requested_model=f'{backend}/example',
                              runner_model='example', runner_path=tmp_path / 'runner.sh')
    cmd = launcher._build_cmd(plan=plan, system=None, prompt=tmp_path / 'prompt', out=tmp_path / 'out',
                              opencode_agent=None, opencode_variant=None, backend_tool_modes={},
                              review_workspace_dir=tmp_path, gemini_cli_home=None)
    for item in expected:
        assert item in cmd
    if '--max-retries' in expected:
        assert cmd[cmd.index('--max-retries') + 1] == '1'
    if '--max-attempts' in expected:
        assert cmd[cmd.index('--max-attempts') + 1] == ('3' if backend == 'opencode' else '1')
    if backend == 'gemini':
        assert '--max-attempts' not in cmd
        assert '--no-proxy-first' not in cmd


def test_flags_are_used_by_actual_subprocess(launcher, monkeypatch, tmp_path):
    primary = runner(tmp_path, 'codex', 'ready')
    code, _, calls = run(launcher, monkeypatch, tmp_path, primary)
    assert code == 0
    args = calls[0]['args']
    assert args[args.index('--max-retries') + 1] == '1'


@pytest.mark.parametrize('backend', ['kimi', 'opencode'])
def test_disabled_deadline_is_propagated_to_inner_runner(launcher, tmp_path, backend):
    plan = launcher.AgentPlan(index=0, backend=backend, requested_model=f'{backend}/example',
                              runner_model='example', runner_path=tmp_path / 'runner.sh')
    cmd = launcher._build_cmd(plan=plan, system=None, prompt=tmp_path / 'prompt', out=tmp_path / 'out',
                              opencode_agent=None, opencode_variant=None, backend_tool_modes={},
                              review_workspace_dir=tmp_path, gemini_cli_home=None, timeout_secs=0)
    assert cmd[cmd.index('--timeout-secs') + 1] == '0'


@pytest.mark.parametrize('provider', ['kimi', 'opencode'])
def test_outer_deadline_allows_real_wrapper_to_stop_cli_descendants(launcher, monkeypatch, tmp_path, provider):
    fixture_path = Path(__file__).resolve().parents[2] / 'opencode-cli-runner/tests/test_delivery_budget.py'
    spec = importlib.util.spec_from_file_location('generic_delivery_fixture', fixture_path)
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    cmd, env, _, log, marker = fixture.setup_invocation(
        tmp_path, provider, 'timeout_child', ['--max-attempts', '1', '--timeout-secs', '10'])
    for key in ('PATH', 'PROBE_CASE', 'PROBE_LOG', 'PROBE_MARKER'):
        monkeypatch.setenv(key, env[key])
    # Start the timeout after the CLI has actually spawned. Otherwise cold
    # interpreter startup can consume 0.7s and never exercise descendant cleanup.
    original_popen = launcher.subprocess.Popen
    def ready_popen(*args, **kwargs):
        proc = original_popen(*args, **kwargs)
        deadline = time.monotonic()+5
        while not log.exists() and proc.poll() is None and time.monotonic()<deadline:
            time.sleep(0.02)
        assert log.exists(), 'generic CLI did not start within the fixture setup budget'
        time.sleep(0.1)  # stub spawns its bounded child immediately after logging
        return proc
    monkeypatch.setattr(launcher.subprocess, 'Popen', ready_popen)
    result = launcher._run_with_timeout(cmd, timeout_secs=0.7)
    assert result['timed_out'] is True
    assert len(log.read_text().splitlines()) == 1
    time.sleep(2.1)
    assert not marker.exists()
