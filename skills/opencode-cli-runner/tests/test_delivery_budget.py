"""Generic subprocess witnesses; no provider, credentials, or research inputs."""
from __future__ import annotations

import ast
import json
import os
import signal
import subprocess
import time
from pathlib import Path

import pytest

SKILLS = Path(__file__).resolve().parents[2]


def setup_invocation(tmp_path: Path, provider: str, case: str, extra: list[str]):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    executable = bin_dir / provider
    executable.write_text('''#!/usr/bin/env python3
import json, os, subprocess, sys, time
from pathlib import Path
provider = Path(sys.argv[0]).name
log = Path(os.environ['PROBE_LOG'])
with log.open('a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')
calls = len(log.read_text().splitlines())
case = os.environ['PROBE_CASE']
def text(value):
    message = 'reply-1' if case in ('length_then_wrong_message', 'length_then_replay') else f'reply-{calls}'
    event = {'role':'assistant','content':value} if provider == 'kimi' else {'type':'text','part':{'text':value,'messageID':message}}
    print(json.dumps(event), flush=True)
def error(value):
    event = {'role':'error','content':value} if provider == 'kimi' else {'type':'error','error':{'message':value}}
    print(json.dumps(event), flush=True)
if case == 'blank': text('  ')
elif case == 'nonzero': text('retained partial'); sys.exit(7)
elif case.startswith('length'):
    if case != 'length_reasoning_only' and not (case == 'length_then_blank' and calls > 1):
        final = 'continuation without LF' if case == 'length_then_no_lf' else 'continuation  \\n\\n'
        text('partial' if calls == 1 else final)
    reason = 'stop' if case.startswith('length_then_') and calls > 1 else 'length'
    session = 'foreign-session' if case == 'length_then_foreign' and calls > 1 else 'generic-session'
    if case != 'length_then_no_terminal' or calls == 1:
        message = 'reply-1' if case == 'length_then_replay' else f'reply-{calls}'
        part = {'reason':reason,'messageID':message}
        usage = json.loads(os.environ.get('PROBE_USAGE', '[]'))
        if calls <= len(usage) and usage[calls - 1] is not None:
            part['tokens'] = usage[calls - 1]
        print(json.dumps({'type':'step_finish','sessionID':session,'part':part}))
    if case == 'length_then_trailing_step' and calls > 1:
        print(json.dumps({'type':'step_start','sessionID':session,'part':{'messageID':'unfinished'}}))
elif case == 'fallback':
    if '-m' in sys.argv: error('model not found'); sys.exit(1)
    text('fallback complete')
elif case == 'quota': error('monthly quota exhausted')
elif case == 'permission': error('external_directory auto-rejecting request')
elif case == 'contradictory_error':
    obj = {'role':'assistant','type':'error','content':'failure payload'} if provider == 'kimi' else {'type':'text','part':{'text':'failure payload'}}
    obj['error'] = {'message':'explicit failure'}
    print(json.dumps(obj))
elif case == 'transient': error('connection reset by peer')
elif case == 'timeout_child':
    marker = os.environ['PROBE_MARKER']
    subprocess.Popen([sys.executable,'-c',"import time; from pathlib import Path; time.sleep(2); Path("+repr(marker)+").write_text('late effect')"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    text('before timeout')
    time.sleep(10)
else: text('complete')
''')
    executable.chmod(0o755)
    prompt = tmp_path / "prompt.txt"
    prompt.write_text("Return the generic fixture result.")
    out = tmp_path / "out.txt"
    log = tmp_path / "calls.jsonl"
    marker = tmp_path / "late.txt"
    runner = SKILLS / f"{provider}-cli-runner" / "scripts" / f"run_{provider}.sh"
    env = os.environ.copy()
    env.update(PATH=f"{bin_dir}:{env['PATH']}", PROBE_CASE=case,
               PROBE_LOG=str(log), PROBE_MARKER=str(marker))
    cmd = ["bash", str(runner), "--prompt-file", str(prompt), "--out", str(out),
           "--sleep-secs", "1", *extra]
    return cmd, env, out, log, marker


def run_probe(tmp_path, provider, case, extra):
    cmd, env, out, log, marker = setup_invocation(tmp_path, provider, case, extra)
    proc = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=12)
    calls = log.read_text().splitlines() if log.exists() else []
    return proc, out, calls, marker


@pytest.mark.parametrize("provider", ["kimi", "opencode"])
def test_blank_is_not_completed(tmp_path, provider):
    proc, out, calls, _ = run_probe(tmp_path, provider, "blank", ["--max-attempts", "1"])
    assert proc.returncode != 0
    assert not out.exists()
    assert len(calls) == 1


def test_nonzero_with_text_is_partial(tmp_path):
    proc, out, calls, _ = run_probe(tmp_path, "opencode", "nonzero", ["--max-attempts", "3"])
    assert proc.returncode != 0
    assert not out.exists()
    assert len(calls) == 1  # no automatic redispatch of a partially executed task
    assert "retained partial" in Path(str(out)+".partial").read_text()


@pytest.mark.parametrize("provider", ["kimi", "opencode"])
def test_fallback_consumes_same_call_budget(tmp_path, provider):
    model = "generic/missing" if provider == "opencode" else "generic-missing"
    proc, out, calls, _ = run_probe(tmp_path, provider, "fallback", ["--model", model, "--max-attempts", "1"])
    assert proc.returncode != 0
    assert not out.exists()
    assert len(calls) == 1


def test_final_length_is_partial_and_continuation_consumes_budget(tmp_path):
    proc, out, calls, _ = run_probe(tmp_path, "opencode", "length", ["--max-attempts", "2", "--continue-on-length", "5"])
    assert proc.returncode == 15
    assert not out.exists()
    assert len(calls) == 2
    assert "partial" in Path(str(out)+".partial").read_text()


def test_length_continuation_can_complete_within_budget(tmp_path):
    proc, out, calls, _ = run_probe(tmp_path, "opencode", "length_then_stop", ["--max-attempts", "2"])
    assert proc.returncode == 0, proc.stderr
    assert len(calls) == 2
    assert out.read_text().strip() == "partialcontinuation"


def run_swarm_probe(tmp_path, case, usage=None):
    direct, env, out, log, _ = setup_invocation(tmp_path, "opencode", case, [])
    env["REVIEW_SWARM_NO_AUTO_CONFIG"] = "1"
    launcher = SKILLS / "review-swarm/scripts/bin/run_multi_task.py"
    report_dir = tmp_path / "launcher"
    system = tmp_path / "system.txt"
    system.write_text("This is a generic offline runner fixture.")
    prompt = Path(direct[direct.index("--prompt-file") + 1])
    args = ["python3", str(launcher), "--out-dir", str(report_dir), "--models", "fixture/model", "--system", str(system),
            "--prompt", str(prompt), "--backend-output", f"opencode={out}", "--opencode-runner", direct[1],
            "--max-attempts", "1", "--retry-empty-output", "2"]
    if usage is not None:
        env["PROBE_USAGE"] = json.dumps(usage)
        args += ["--context-tokens", "60000"]
        # The capacity reader uses the launcher meta in the same directory as the report.
        out = report_dir / out.name
        args[args.index("--backend-output") + 1] = f"opencode={out}"
    result = subprocess.run(args, env=env, text=True, capture_output=True, timeout=20)
    meta = report_dir / "meta.json"
    assert meta.is_file(), result.stderr
    agent, = json.loads(meta.read_text())["agents"]
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    return result, agent, calls, out, system.read_text(), prompt.read_text()


@pytest.mark.parametrize("case, success, reason, count", [
    ("length_then_stop", True, None, 2),
    ("length_then_no_lf", True, None, 2),
    ("length_reasoning_only", False, "response_token_limit", 3),
    ("length_then_blank", False, "exit_code_1", 2),
    ("length_then_foreign", False, "exit_code_1", 2),
    ("length_then_no_terminal", False, "exit_code_1", 2),
    ("length_then_wrong_message", False, "exit_code_1", 2),
    ("length_then_replay", False, "exit_code_1", 2),
    ("length_then_trailing_step", False, "exit_code_1", 2),
    ("transient", False, "transient_transport", 1),
])
def test_swarm_seat_uses_bounded_same_session_continuation(tmp_path, case, success, reason, count):
    result, agent, calls, out, _, _ = run_swarm_probe(tmp_path, case)
    assert agent["success"] is success, result.stderr
    assert agent["failure_reason"] == reason
    assert agent["seat_budget"]["runner_invocations"] == 1
    assert len(calls) == count and "-s" not in calls[0]
    for call in calls[1:]:
        assert call[call.index("-s") + 1] == "generic-session"
        assert call[call.index("-m") + 1] == "fixture/model"
    if reason == "response_token_limit":
        assert agent["failure_class"] == "capacity"
    if success:
        expected = b"continuation without LF" if case == "length_then_no_lf" else b"continuation  \n\n"
        assert out.read_bytes() == expected
        observation = json.loads(Path(str(out) + ".runtime-observation.json").read_text())["payload"]
        assert observation["capture"]["complete_output"]["responses"] == count
        assert "continuation_prompt.log" in observation["capture"]["files"]
    else:
        assert not out.exists()


@pytest.mark.parametrize("change, failure", [
    ("valid", None),
    ("cached_and_reasoning", "observed request usage exceeds"),
    ("provider_total", "observed request usage exceeds"),
    ("missing", "no complete per-step token usage"),
])
def test_resumed_opencode_capacity_uses_each_signed_step(tmp_path, monkeypatch, change, failure):
    monkeypatch.syspath_prepend(str(SKILLS / "research-team/scripts/lib"))
    from request_capacity import request_budgets, validate_request_capacity

    first = {"input": 37000, "output": 1200, "reasoning": 3800, "cache": {"read": 8000, "write": 0}}
    final = {"input": 42000, "output": 2000, "reasoning": 1000, "cache": {"read": 7000, "write": 0}}
    if change == "cached_and_reasoning":
        final.update(reasoning=10000, total=59000)
    elif change == "provider_total":
        first["total"] = 60001
    elif change == "missing":
        final = None
    result, agent, _, out, system, prompt = run_swarm_probe(tmp_path, "length_then_stop", [first, final])
    assert agent["success"] is True, result.stderr
    args = (system, prompt, {"exit_code": 0, "output": str(out)}, request_budgets(60000))
    if failure:
        with pytest.raises(ValueError, match=failure):
            validate_request_capacity(*args)
    else:
        proof = validate_request_capacity(*args)
        assert proof["usage_scope"] == "per_call"
        assert [step["window_tokens"] for step in proof["observed_usage"]] == [50000, 52000]
        receipt = Path(agent["capture_receipt"])
        (receipt.parent / "attempt_2.stderr").write_text("mutated capture\n")
        with pytest.raises(ValueError):
            validate_request_capacity(*args)


def test_strict_runner_rejects_replayed_terminal_message(tmp_path):
    proc, out, calls, _ = run_probe(tmp_path, "opencode", "length_then_replay",
                                    ["--no-retry", "--final-response-only"])
    assert proc.returncode != 0
    assert "replayed an earlier terminal message" in proc.stderr
    assert len(calls) == 2
    assert not out.exists()


@pytest.mark.parametrize("provider", ["kimi", "opencode"])
@pytest.mark.parametrize("case", ["quota", "permission"])
def test_permanent_refusal_is_not_retried(tmp_path, provider, case):
    proc, out, calls, _ = run_probe(tmp_path, provider, case, ["--max-attempts", "3"])
    assert proc.returncode != 0
    assert len(calls) == 1


@pytest.mark.parametrize("provider", ["kimi", "opencode"])
def test_deadline_stops_descendants_and_retry(tmp_path, provider):
    proc, out, calls, marker = run_probe(tmp_path, provider, "timeout_child", ["--max-attempts", "3", "--timeout-secs", "1"])
    assert proc.returncode != 0
    assert len(calls) == 1
    time.sleep(2.1)
    assert not marker.exists()


@pytest.mark.parametrize("provider", ["kimi", "opencode"])
def test_backoff_does_not_reset_total_deadline(tmp_path, provider):
    start = time.monotonic()
    proc, out, calls, _ = run_probe(tmp_path, provider, "transient", ["--max-attempts", "3", "--timeout-secs", "1", "--sleep-secs", "5"])
    assert proc.returncode != 0
    assert len(calls) == 1
    assert time.monotonic()-start < 3


@pytest.mark.parametrize("provider", ["kimi", "opencode"])
def test_cancel_stops_descendants(tmp_path, provider):
    cmd, env, out, log, marker = setup_invocation(tmp_path, provider, "timeout_child", ["--max-attempts", "1"])
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic()+3
        while not log.exists() and time.monotonic()<deadline: time.sleep(0.02)
        assert log.exists()
        time.sleep(0.15)
        proc.send_signal(signal.SIGTERM)
        proc.communicate(timeout=3)
        assert proc.returncode != 0
        time.sleep(2.1)
        assert not marker.exists()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate()


def test_helpers_share_supervision_logic_with_declared_timeout_defaults():
    normalized = []
    for provider, default_timeout in [("kimi", 0), ("opencode", 900)]:
        tree = ast.parse((SKILLS / f'{provider}-cli-runner' / 'scripts/process_budget.py').read_text())
        options = [node for node in ast.walk(tree)
                   if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                   and node.func.attr == 'add_argument' and node.args
                   and isinstance(node.args[0], ast.Constant)
                   and node.args[0].value == '--timeout-secs']
        assert len(options) == 1
        defaults = [kw for kw in options[0].keywords if kw.arg == 'default']
        assert len(defaults) == 1 and isinstance(defaults[0].value, ast.Constant)
        assert defaults[0].value.value == default_timeout
        # Provider policy differs; all remaining supervision code must agree.
        defaults[0].value = ast.Constant(value=None)
        normalized.append(ast.dump(tree, include_attributes=False))
    assert normalized[0] == normalized[1]


@pytest.mark.parametrize("provider", ["kimi", "opencode"])
def test_attempt_receipt_retains_route_without_inventing_actual_model(tmp_path, provider):
    model = 'generic/model'
    proc, out, calls, _ = run_probe(tmp_path, provider, 'complete', ['--model',model,'--max-attempts','1'])
    assert proc.returncode == 0, proc.stderr
    receipts = list(Path(str(out)+'.attempts').glob('run.*/budget.json'))
    assert len(receipts) == 1
    receipt = json.loads(receipts[0].read_text())
    assert receipt['status'] == 'completed'
    assert receipt['attempts_used'] == 1
    assert receipt['attempts'][0]['requested_model'] == model
    assert receipt['attempts'][0]['actual_model'] is None
    assert 'complete' in (receipts[0].parent/receipt['attempts'][0]['stdout']).read_text()


def test_kimi_conflicting_headless_flag_is_rejected_before_call(tmp_path):
    proc, out, calls, _ = run_probe(tmp_path, 'kimi', 'complete', ['--yolo'])
    assert proc.returncode == 2
    assert calls == []
    assert 'cannot be combined' in proc.stderr


def test_opencode_explicit_auto_flag_matches_current_help(tmp_path):
    proc, out, calls, _ = run_probe(tmp_path, 'opencode', 'complete', ['--skip-permissions','--max-attempts','1'])
    assert proc.returncode == 0, proc.stderr
    assert '--auto' in json.loads(calls[0])
    assert '--dangerously-skip-permissions' not in json.loads(calls[0])


@pytest.mark.parametrize('provider', ['kimi','opencode'])
def test_failure_cannot_reuse_an_old_completed_output(tmp_path, provider):
    cmd, env, out, log, marker = setup_invocation(tmp_path, provider, 'blank', ['--max-attempts','1'])
    out.write_text('older complete result')
    Path(str(out)+'.partial').write_text('older partial')
    proc = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=5)
    assert proc.returncode != 0
    assert not out.exists()
    assert not Path(str(out)+'.partial').exists()
    roots = list(Path(str(out)+'.attempts').glob('run.*'))
    assert (roots[0]/'previous-output.txt').read_text() == 'older complete result'
    assert (roots[0]/'previous-partial.txt').read_text() == 'older partial'


@pytest.mark.parametrize('provider', ['kimi','opencode'])
def test_output_alias_cannot_destroy_input(tmp_path, provider):
    cmd, env, out, log, marker = setup_invocation(tmp_path, provider, 'complete', ['--max-attempts','1'])
    prompt = Path(cmd[cmd.index('--prompt-file')+1])
    original = prompt.read_bytes()
    out.symlink_to(prompt)
    proc = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=5)
    assert proc.returncode == 2
    assert not log.exists()
    assert prompt.read_bytes() == original


@pytest.mark.parametrize('provider', ['kimi','opencode'])
def test_error_metadata_takes_precedence_over_text_shape(tmp_path, provider):
    proc, out, calls, _ = run_probe(tmp_path, provider, 'contradictory_error', ['--max-attempts','1'])
    assert proc.returncode != 0
    assert not out.exists()
    receipt_path = next(Path(str(out)+'.attempts').glob('run.*/budget.json'))
    assert json.loads(receipt_path.read_text())['status'] == 'failed'


def test_unsupported_cross_process_clock_runtime_stops_before_effects(monkeypatch, tmp_path):
    import importlib.util
    import sys
    path = SKILLS/'kimi-cli-runner/scripts/process_budget.py'
    spec = importlib.util.spec_from_file_location('supervision_runtime',path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(sys,'version_info',(3,9,6))
    monkeypatch.setattr(sys,'argv',[str(path),'init','--state',str(tmp_path/'state')])
    assert module.main() == 2
    assert not (tmp_path/'state').exists()
