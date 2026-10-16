"""Bounded fake-CLI witnesses; no account/config/provider access."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / 'scripts/run_claude.sh'

FAKE = r'''import json, os, subprocess, sys, time
from pathlib import Path
sys.stdin.read()
if os.environ.get('SYSTEM_ARG_PATH'):
    Path(os.environ['SYSTEM_ARG_PATH']).write_bytes(sys.argv[sys.argv.index('--system-prompt')+1].encode())
mode = os.environ['CAPTURE_CASE']
Path(os.environ['STARTED']).write_text(str(os.getpid()))
def emit(obj):
    print(json.dumps(obj), flush=True)
blocks = set()
answer = ''
final_text = '{"verdict":"PASS","blocking_issues":[],"summary":"done"}'
def delta(text, thinking=False, uuid=None):
    global answer
    index = 1 if thinking else 0
    if not blocks:
        emit({'type':'stream_event','event':{'type':'message_start','message':{'id':'body'}}})
    if index not in blocks:
        emit({'type':'stream_event','event':{'type':'content_block_start','index':index,
              'content_block':{'type':'thinking' if thinking else 'text','text':''} }})
        blocks.add(index)
    if not thinking:
        answer += text
    obj = {'type':'stream_event', 'event':{'type':'content_block_delta', 'index':index,
         'delta':{'type':'thinking_delta','thinking':text} if thinking else {'type':'text_delta','text':text}}}
    if uuid is not None:
        obj['uuid'] = uuid
    emit(obj)
def result():
    if blocks:
        for index in sorted(blocks):
            emit({'type':'stream_event','event':{'type':'content_block_stop','index':index}})
        emit({'type':'stream_event','event':{'type':'message_stop'}})
    if answer != final_text and answer:
        emit({'type':'assistant','message':{'id':'final','content':[{'type':'text','text':final_text}]}})
    emit({'type':'result', 'subtype':'success', 'is_error':False, 'session_id':'fake-session',
          'result':final_text})
if mode == 'buffered':
    time.sleep(.6)
    sys.stdout.write('legacy stdout\n')
    sys.stderr.write('legacy stderr\n')
    sys.exit(0)
if mode == 'transient':
    print('fetch failed: connection reset by peer', file=sys.stderr, flush=True)
    sys.exit(1)
if mode in ('hung', 'partial_child'):
    subprocess.Popen([sys.executable, '-c', 'import time; from pathlib import Path; time.sleep(1.3); Path('+repr(os.environ['MARKER'])+').write_text("orphan")'])
if mode == 'hung':
    time.sleep(30)
emit({'type':'system','subtype':'init','model':'named-one'})
if mode == 'healthy':
    for i in range(6):
        delta(final_text[i*len(final_text)//6:(i+1)*len(final_text)//6])
        delta('PRIVATE_REASONING_'+str(i), thinking=True)
        time.sleep(.1)
    result()
elif mode == 'hard_progress':
    for i in range(100):
        delta('token'+str(i))
        time.sleep(.05)
    result()
elif mode == 'duplicates':
    for i in range(100):
        delta('same', uuid='duplicate-event')
        emit({'type':'system','subtype':'heartbeat'})
        time.sleep(.03)
elif mode in ('distinct_repeated_text','unidentified_repeated_text'):
    for i in range(6):
        delta('same', uuid='event-'+str(i) if mode=='distinct_repeated_text' else None)
        time.sleep(.1)
    result()
elif mode == 'same_id_replays':
    for i in range(100):
        delta('same', uuid='replayed-event')
        time.sleep(.03)
elif mode == 'quota_error':
    emit({'type':'error','error':{'type':'quota_exhausted', 'message':"You've reached your usage limit for this billing cycle"}})
    sys.exit(1)
elif mode == 'quota_body':
    delta('The error reference says: reached your usage limit for this billing cycle.')
    result()
elif mode == 'transient_once':
    state = Path(os.environ['MARKER'])
    if not state.exists():
        state.write_text('failed-once')
        emit({'type':'error','error':{'message':'connection reset by peer'}})
        sys.exit(1)
    delta('recovered')
    result()
elif mode == 'stall':
    delta('visible partial')
    time.sleep(30)
elif mode == 'degraded':
    delta('visible partial')
    print('unsupported transport line', flush=True)
    time.sleep(30)
elif mode == 'degraded_json':
    delta('visible partial')
    emit({'type':'unsupported_transport', 'payload':'opaque'})
    time.sleep(30)
elif mode == 'silent_stream':
    time.sleep(.6)
    result()
elif mode == 'incomplete':
    delta('{"verdict":"PASS","blocking_issues":[],"summary":"looks finished"}')
elif mode == 'terminal_then_hang':
    delta('partial')
    result()
    time.sleep(30)
elif mode == 'error_result':
    delta('partial')
    emit({'type':'result', 'subtype':'error_during_execution', 'is_error':True, 'result':'bad'})
elif mode == 'partial_child':
    delta('interrupted body')
    time.sleep(30)
'''


def setup(tmp_path, case, extra=()):
    bindir = tmp_path / 'bin'
    bindir.mkdir(exist_ok=True)
    cli = bindir / 'claude'
    cli.write_text('#!'+sys.executable+'\n'+FAKE)
    cli.chmod(0o755)
    prompt, system = tmp_path / 'prompt', tmp_path / 'system'
    prompt.write_text('Review the input.')
    system.write_text('Return a completed verdict.')
    out = tmp_path / 'answer'
    env = os.environ.copy()
    env.update(PATH=str(bindir)+os.pathsep+env.get('PATH',''), CAPTURE_CASE=case,
               STARTED=str(tmp_path/'started'), MARKER=str(tmp_path/'marker'),
               http_proxy='http://127.0.0.1:7890', https_proxy='http://127.0.0.1:7890',
               HTTP_PROXY='http://127.0.0.1:7890', HTTPS_PROXY='http://127.0.0.1:7890')
    cmd = ['bash',str(RUNNER),'--prompt-file',str(prompt),'--system-prompt-file',str(system),
           '--out',str(out),'--max-retries','1','--expected-secs','.1', *extra]
    return cmd, env, out


def receipt(out):
    directories = list(Path(str(out)+'.attempts').glob('run.*'))
    assert len(directories) == 1
    root = directories[0]
    return root, json.loads((root/'budget.json').read_text())


def progress(out):
    root, budget = receipt(out)
    return json.loads((root/budget['attempts'][-1]['progress']).read_text())


def run(tmp_path, case, extra=()):
    cmd, env, out = setup(tmp_path, case, extra)
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=8)
    return proc, out


def wait_started(tmp_path, proc):
    deadline = time.monotonic()+3
    while not (tmp_path/'started').exists() and proc.poll() is None and time.monotonic()<deadline:
        time.sleep(.02)
    assert (tmp_path/'started').exists(), 'fake CLI did not launch'


def test_healthy_generation_continues_beyond_soft_estimate(tmp_path):
    proc, out = run(tmp_path, 'healthy', ['--live-capture','--inactivity-secs','.2','--inactivity-grace-secs','.2'])
    assert proc.returncode == 0, proc.stderr
    assert json.loads(out.read_text())['verdict'] == 'PASS'
    state = progress(out)
    assert state['expected_duration_exceeded'] is True
    assert state['advancing_events'] == 12
    assert state['reported_model'] == 'named-one'
    root, budget = receipt(out)
    assert budget['hard_budget_secs'] is None
    assert list(root.glob('*.result.json'))
    assert 'PRIVATE_REASONING' not in json.dumps(state)+proc.stdout+proc.stderr
    assert 'PRIVATE_REASONING' not in Path(str(out)+'.partial').read_text()
    assert 'PRIVATE_REASONING' in (root/'attempt_1.events.jsonl').read_text()


def test_duplicate_events_and_heartbeats_do_not_advance(tmp_path):
    proc, out = run(tmp_path, 'duplicates', ['--live-capture','--inactivity-secs','.15','--inactivity-grace-secs','.15'])
    assert proc.returncode == 69, proc.stderr
    state = progress(out)
    assert state['event_count'] > 5
    assert state['advancing_events'] == 1
    assert state['answer_chars'] == 4
    assert state['termination_reason'] == 'confirmed_inactivity'
    assert Path(str(out)+'.partial').read_text() == 'same'
    assert not out.exists()


@pytest.mark.parametrize('case', ['distinct_repeated_text','unidentified_repeated_text'])
def test_distinct_event_ids_advance_even_when_text_repeats(tmp_path, case):
    proc, out = run(tmp_path, case, ['--live-capture','--inactivity-secs','.15','--inactivity-grace-secs','.15'])
    assert proc.returncode == 0, proc.stderr
    assert progress(out)['advancing_events'] == 6
    assert progress(out)['answer_chars'] == 24


def test_same_event_id_replays_do_not_reset_inactivity(tmp_path):
    proc, out = run(tmp_path, 'same_id_replays', ['--live-capture','--inactivity-secs','.15','--inactivity-grace-secs','.15'])
    assert proc.returncode == 69, proc.stderr
    assert progress(out)['advancing_events'] == 1
    assert not out.exists()


def test_typed_stdout_quota_error_stops_after_one_attempt(tmp_path):
    proc, out = run(tmp_path, 'quota_error', ['--live-capture','--max-retries','3','--sleep-secs','0'])
    assert proc.returncode == 1, proc.stderr
    assert 'deterministic' in proc.stderr
    assert receipt(out)[1]['attempts_used'] == 1
    assert not out.exists()


def test_quota_words_in_answer_are_not_a_typed_error(tmp_path):
    proc, out = run(tmp_path, 'quota_body', ['--live-capture'])
    assert proc.returncode == 0, proc.stderr
    assert receipt(out)[1]['attempts_used'] == 1
    assert all(p.read_text() == '' for p in receipt(out)[0].glob('*.error.log'))


def test_typed_transient_error_can_retry_to_completion(tmp_path):
    proc, out = run(tmp_path, 'transient_once', ['--live-capture','--max-retries','2','--sleep-secs','0'])
    assert proc.returncode == 0, proc.stderr
    assert receipt(out)[1]['attempts_used'] == 2
    assert out.exists()


def test_cancel_during_backoff_is_immediate_and_starts_no_retry(tmp_path):
    cmd, env, out = setup(tmp_path, 'transient', ['--max-retries','2','--sleep-secs','20'])
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        wait_started(tmp_path, proc)
        deadline = time.monotonic()+3
        while receipt(out)[1]['attempts'][-1]['status'] == 'running' and time.monotonic()<deadline:
            time.sleep(.02)
        time.sleep(.15)
        assert proc.poll() is None
        start = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        stdout, stderr = proc.communicate(timeout=3)
        assert time.monotonic()-start < 3
        assert proc.returncode == 143, stdout+stderr
        assert receipt(out)[1]['status'] == 'cancelled'
        assert receipt(out)[1]['attempts_used'] == 1
        assert not out.exists()
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.communicate(timeout=3)


def test_observable_stall_needs_diagnostic_and_grace(tmp_path):
    proc, out = run(tmp_path, 'stall', ['--live-capture','--inactivity-secs','.15','--inactivity-grace-secs','.2'])
    assert proc.returncode == 69
    state = progress(out)
    assert state['elapsed_secs'] >= .35
    assert state['capture_health'] == 'observable'
    assert state['inactivity_diagnostics'][0]['process_status'] == 'running'
    assert state['inactivity_diagnostics'][0]['provider_status'] == 'unknown'
    assert not out.exists()


def test_silent_reasoning_stream_has_unknown_progress_and_is_not_stalled(tmp_path):
    proc, out = run(tmp_path, 'silent_stream', ['--live-capture','--inactivity-secs','.1','--inactivity-grace-secs','.1'])
    assert proc.returncode == 0
    assert progress(out)['capture_health'] == 'unknown'
    assert progress(out)['termination_reason'] is None


def test_buffered_unknown_transport_preserves_default_output_bytes(tmp_path):
    proc, out = run(tmp_path, 'buffered', ['--inactivity-secs','.1','--inactivity-grace-secs','.1'])
    assert proc.returncode == 0
    assert out.read_text() == 'legacy stdout\nlegacy stderr\n'
    assert progress(out)['capture_health'] == 'unknown'
    assert progress(out)['termination_reason'] is None


def test_explicit_hard_budget_stops_advancing_generation(tmp_path):
    proc, out = run(tmp_path, 'hard_progress', ['--live-capture','--timeout-secs','.6'])
    assert proc.returncode == 124
    assert progress(out)['advancing_events'] >= 4
    assert progress(out)['termination_reason'] == 'hard_budget_exhausted'
    assert Path(str(out)+'.partial').stat().st_size > 0
    assert not out.exists()


@pytest.mark.parametrize('case', ['degraded','degraded_json'])
def test_degraded_capture_cannot_trigger_inactivity_kill(tmp_path, case):
    proc, out = run(tmp_path, case, ['--live-capture','--inactivity-secs','.1','--inactivity-grace-secs','.1','--timeout-secs','.6'])
    assert proc.returncode == 124
    assert progress(out)['capture_health'] == 'degraded'
    assert progress(out)['termination_reason'] == 'hard_budget_exhausted'


@pytest.mark.parametrize('case', ['hung','partial_child'])
def test_default_no_hard_cap_user_cancel_cleans_group_and_retains_evidence(tmp_path, case):
    extra = ['--inactivity-secs','.1','--inactivity-grace-secs','.1'] if case == 'hung' else ['--live-capture']
    cmd, env, out = setup(tmp_path, case, extra)
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        wait_started(tmp_path, proc)
        time.sleep(.4)
        assert proc.poll() is None
        root, budget = receipt(out)
        assert budget['deadline_monotonic'] is None
        assert (root/'attempt_1.events.jsonl').exists()
        if case == 'partial_child':
            assert Path(str(out)+'.partial').read_text() == 'interrupted body'
        proc.send_signal(signal.SIGTERM)
        stdout, stderr = proc.communicate(timeout=3)
        assert proc.returncode == 143, stdout+stderr
        assert not out.exists()
        assert receipt(out)[1]['status'] == 'cancelled'
        time.sleep(1.0)
        assert not (tmp_path/'marker').exists(), 'descendant survived cancellation'
        if case == 'partial_child':
            assert Path(str(out)+'.partial').read_text() == 'interrupted body'
            assert (root/'attempt_1.events.jsonl').stat().st_size > 0
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.communicate(timeout=3)


@pytest.mark.parametrize('case', ['incomplete','error_result'])
def test_partial_or_error_result_is_never_completed(tmp_path, case):
    proc, out = run(tmp_path, case, ['--live-capture'])
    assert proc.returncode == 65
    assert not out.exists()
    assert Path(str(out)+'.partial').read_text()
    assert receipt(out)[1]['status'] == 'failed'


def test_terminal_event_without_successful_cli_exit_is_not_completed(tmp_path):
    proc, out = run(tmp_path, 'terminal_then_hang', ['--live-capture','--timeout-secs','.5'])
    assert proc.returncode == 124
    assert progress(out)['complete_result_seen'] is True
    assert not out.exists()


def test_live_capture_does_not_mirror_private_events_into_ambient_legacy_logs(tmp_path):
    cmd, env, out = setup(tmp_path, 'healthy', ['--live-capture'])
    ambient = tmp_path / 'peer-visible-log'
    env['RESEARCH_TEAM_ATTEMPT_LOG_DIR'] = str(ambient)
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=8)
    assert proc.returncode == 0
    assert list(ambient.glob('*')) == []
    root, _ = receipt(out)
    assert 'PRIVATE_REASONING' in (root/'attempt_1.events.jsonl').read_text()

@pytest.mark.parametrize('ending',['\n','\r\n','\n\n'])
def test_actual_system_prompt_argv_preserves_original_terminal_newlines(tmp_path,ending):
    cmd,env,out=setup(tmp_path,'silent_stream',['--live-capture'])
    original=('Neutral original system λ'+ending).encode()
    (tmp_path/'system').write_bytes(original)
    captured=tmp_path/'actual-system-argv';env['SYSTEM_ARG_PATH']=str(captured)
    proc=subprocess.run(cmd,env=env,capture_output=True,text=True,timeout=8)
    assert proc.returncode==0,proc.stderr
    assert captured.read_bytes()==original
