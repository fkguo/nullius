"""A provider safeguard stop is a recorded refusal of that lane, never a derivation or a family."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/run_multi_backend.py'
spec = importlib.util.spec_from_file_location('provider_refusal_executor', SCRIPT)
mb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mb)

CLAIM = {'id': 'neutral', 'statement': 'Compute the sum of raw integers 17 and 25.',
         'report_format': 'integer', 'method0': 'route label one', 'method1': 'different route label'}
SAFEGUARD = ("API Error: Some Model's safeguards flagged this message (https://example.invalid/policy). "
             "This sometimes happens with safe, normal conversations.\n\nTry rephrasing the request.\n\n"
             "Details: `[reasoning_extraction]`\n\nRequest ID: req_0")
VERDICT = json.dumps({'canonical_answer': '42', 'derivation': 'Step 1: 17 + 25 = 42.', 'derivation_summary': '',
                      'confidence': 'high', 'checkable_form': '42'})


def host_run(model, system, prompt, tag):
    if 'compare' in tag:
        return 'no verdict'
    return SAFEGUARD if model.startswith('claude/') else VERDICT


def test_safeguard_text_from_a_host_runner_is_a_recorded_refusal_not_a_family():
    claims = {'claims': [CLAIM, {**CLAIM, 'id': 'second'}], 'max_iter': 0}
    out = mb.run_gate(claims, pool=['claude/opus', 'codex/some-model'], comparators=['codex/some-model'], run=host_run)
    for row in out['matrix']:
        assert row['families'] == ['codex'] and row['total_derivations'] == 1
        assert not row['converged'] and row['cross_family_confirmations'] == 0
        [refusal] = row['provider_refusals']
        assert refusal['stop_reason'] == 'provider_refusal' and refusal['details'] == ['reasoning_extraction']
        assert refusal['family'] == 'claude' and refusal['model'] == 'claude/opus'
        assert refusal['message'].startswith('API Error:')
    assert [r['claim'] for r in out['provider_refusals']] == ['neutral', 'second']


def stream_lines(stop_reason):
    events = [{'type': 'stream_event', 'event': {'type': 'message_start', 'message': {'id': 'm1'}}},
              {'type': 'stream_event', 'event': {'type': 'message_delta', 'delta': {'stop_reason': stop_reason,
                  **({'stop_details': {'category': 'reasoning_extraction'}} if stop_reason == 'refusal' else {})}}},
              {'type': 'stream_event', 'event': {'type': 'message_stop'}}]
    if stop_reason == 'refusal':  # the CLI continues once after a stop and can still end successfully
        events += [{'type': 'stream_event', 'event': {'type': 'message_start', 'message': {'id': 'm2'}}},
                   {'type': 'stream_event', 'event': {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}}},
                   {'type': 'stream_event', 'event': {'type': 'message_stop'}}]
    events.append({'type': 'result', 'subtype': 'success', 'is_error': False, 'stop_reason': 'end_turn', 'result': VERDICT})
    return '\n'.join(json.dumps(e) for e in events) + '\n'


def adapter_for(tmp_path, monkeypatch, stop_reason):
    def invoke(cmd, **kwargs):
        out = Path(cmd[cmd.index('--backend-output') + 1].split('=', 1)[1])
        out.write_text(VERDICT, encoding='utf-8')
        run_dir = Path(str(out) + '.attempts') / 'run.fixture'
        run_dir.mkdir(parents=True)
        (run_dir / 'attempt_1.events.jsonl').write_text(stream_lines(stop_reason), encoding='utf-8')
        return SimpleNamespace(returncode=0, stdout='', stderr='')
    monkeypatch.setattr(mb.subprocess, 'run', invoke)
    return mb.MultiTaskRunner(runner_path=tmp_path / 'runner.py', work_dir=tmp_path, timeout=10, tools=False, config=None)


def test_stream_refusal_is_recorded_even_when_the_cli_exits_zero(tmp_path, monkeypatch):
    adapter = adapter_for(tmp_path, monkeypatch, 'refusal')
    refusals = []
    assert mb._execute_derivation(adapter.run, 'claude/opus', 'system', 'raw input', 'lane', refusals) is None
    assert refusals == [{'execution_id': 'lane', 'model': 'claude/opus', 'family': 'claude',
                         'stop_reason': 'provider_refusal', 'details': ['reasoning_extraction'], 'message': None}]
    assert adapter.invocations['lane']['provider_stop']['stop_reason'] == 'provider_refusal'


def test_unstopped_stream_with_the_same_output_is_a_derivation(tmp_path, monkeypatch):
    adapter = adapter_for(tmp_path, monkeypatch, 'end_turn')
    refusals = []
    lane = mb._execute_derivation(adapter.run, 'claude/opus', 'system', 'raw input', 'lane', refusals)
    assert lane is not None and lane['canonical_answer'] == '42' and refusals == []
    assert 'provider_stop' not in adapter.invocations['lane']


def test_lane_request_asks_for_the_written_derivation_without_reasoning_extraction_wording():
    assert 'every mathematical step stated explicitly' in mb._DERIVE_SYSTEM
    for phrase in ('original steps', 'no sentence limit', 'truncation'):
        assert phrase not in mb._DERIVE_SYSTEM


def test_refused_runner_lanes_do_not_mark_the_backend_down(tmp_path, monkeypatch):
    adapter = adapter_for(tmp_path, monkeypatch, 'refusal')
    claims = {'claims': [CLAIM], 'max_iter': 0}
    out = mb.run_gate(claims, pool=['claude/opus'], comparators=['claude/opus'], run=adapter.run)
    [row] = out['matrix']
    assert row['total_derivations'] == 0 and row['families'] == []
    assert sorted(r['execution_id'] for r in row['provider_refusals']) == ['neutral/derive0_claude', 'neutral/derive1_claude']
    assert out['unavailable_backends'] == []


def test_a_derivation_that_quotes_the_safeguard_wording_is_still_a_derivation():
    quoted = json.dumps({**json.loads(VERDICT), 'derivation': 'Step 1: 17 + 25 = 42. (An error saying safeguards flagged this message would not apply.)'})
    refusals = []
    lane = mb._execute_derivation(lambda *a: quoted, 'claude/opus', 'system', 'raw input', 'lane', refusals)
    assert lane is not None and refusals == []


def test_a_refused_comparator_is_recorded_as_a_provider_refusal(tmp_path, monkeypatch):
    adapter = adapter_for(tmp_path, monkeypatch, 'refusal')
    lane = {'canonical_answer': '42', 'derivation': 'Step 1.', 'derivation_summary': '', 'confidence': 'high'}
    cmp, judges = mb._compare(CLAIM, 'raw', [lane, lane], ['codex', 'gemini'], ['claude/opus'], adapter.run, tag='neutral/compare0')
    [judge] = cmp['request_capacity']['judges']
    assert judges == 0 and judge['status'] == 'provider_refusal' and judge['details'] == ['reasoning_extraction']


def test_a_host_comparator_returning_the_safeguard_text_is_a_provider_refusal():
    lane = {'canonical_answer': '42', 'derivation': 'Step 1.', 'derivation_summary': '', 'confidence': 'high'}
    cmp, judges = mb._compare(CLAIM, 'raw', [lane, lane], ['codex', 'gemini'], ['claude/opus'],
                              lambda *a: SAFEGUARD, tag='neutral/compare0')
    [judge] = cmp['request_capacity']['judges']
    assert judges == 0 and judge['status'] == 'provider_refusal' and judge['details'] == ['reasoning_extraction']


def test_a_comparator_verdict_quoting_the_safeguard_wording_is_not_a_refusal():
    lane = {'canonical_answer': '42', 'derivation': 'Step 1.', 'derivation_summary': '', 'confidence': 'high'}
    verdict = json.dumps({'majority_answer': '42', 'outliers': 'quoted span: safeguards flagged this message'})
    cmp, _ = mb._compare(CLAIM, 'raw', [lane, lane], ['codex', 'gemini'], ['claude/opus'],
                         lambda *a: verdict, tag='neutral/compare0')
    [judge] = cmp['request_capacity']['judges']
    assert judge['status'] != 'provider_refusal' and 'safeguard' not in judge.get('reason', '')
