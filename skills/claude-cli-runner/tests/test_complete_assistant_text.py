"""Anonymous transport counterexamples; no provider or scientific acceptance."""
import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/complete_assistant_text.py'
spec = importlib.util.spec_from_file_location('complete_text_fixture', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
AssistantText, CompleteTextError = module.AssistantText, module.CompleteTextError


def snapshot(mid, *blocks):
    return {'type': 'assistant', 'message': {'id': mid, 'content': list(blocks)}}


def text(value):
    return {'type': 'text', 'text': value}


def event(kind, **fields):
    return {'type': 'stream_event', 'event': {'type': kind, **fields}}


def result(body):
    return {'type': 'result', 'subtype': 'success', 'is_error': False, 'result': body}


def stream(records):
    collector = AssistantText()
    for record in records:
        collector.add(record)
    return collector


def test_independently_installed_helpers_have_identical_bytes():
    other = SCRIPT.parents[2] / 'review-swarm/scripts/bin/complete_assistant_text.py'
    assert SCRIPT.read_bytes() == other.read_bytes()


@pytest.mark.parametrize('ending', ['\n', '\r\n'])
def test_complete_order_and_matching_terminal_are_exact(ending, tmp_path):
    early, late = 'EARLY λ' + ending, 'LATE Γ' + ending
    records = [snapshot('one', text(early)), snapshot('tool', {'type': 'tool_use', 'id': 't', 'name': 'x', 'input': {}}),
               snapshot('two', text(late)), result(late)]
    collector = stream(records)
    assert collector.success_text(0) == early + late
    (tmp_path / 'attempt_1.events.jsonl').write_bytes(('\n'.join(json.dumps(r) for r in records)).encode())
    (tmp_path / 'attempt_1.events.result.json').write_text(json.dumps(records[-1]))
    assert module.validate_stream_report(tmp_path, early + late)['terminal'] == 'attempt_1.events.result.json'
    for changed in [late, late + early, early + late + '\n', early + late.replace('Γ', 'Δ')]:
        with pytest.raises(CompleteTextError):
            module.validate_stream_report(tmp_path, changed)
    with pytest.raises(CompleteTextError):
        collector.success_text(1)


@pytest.mark.parametrize('conflict', ['snapshot', 'block-start', 'delta'])
def test_text_to_thinking_refuses_without_changing_prior_text(conflict):
    collector = stream([snapshot('one', text('OBSERVED')), event('message_start', message={'id': 'one'})])
    bad = {'snapshot': snapshot('one', {'type': 'thinking', 'thinking': 'private'}),
           'block-start': event('content_block_start', index=0, content_block={'type': 'thinking'}),
           'delta': event('content_block_delta', index=0, delta={'type': 'thinking_delta', 'thinking': 'private'})}[conflict]
    with pytest.raises(CompleteTextError):
        collector.add(bad)
    assert collector.text() == 'OBSERVED'
    collector.add(event('message_stop'))
    collector.add(result('OBSERVED'))
    with pytest.raises(CompleteTextError):
        collector.success_text(0)


def test_thinking_snapshot_cannot_be_reclassified_as_text():
    collector = stream([snapshot('one', {'type': 'thinking', 'thinking': 'private'})])
    with pytest.raises(CompleteTextError):
        collector.add(snapshot('one', text('private')))
    assert collector.text() == ''


def test_snapshot_and_delta_failure_does_not_mutate_observed_content():
    collector = stream([snapshot('one', text('ABC')), event('message_start', message={'id': 'one'}),
                        event('content_block_start', index=0, content_block=text(''))])
    with pytest.raises(CompleteTextError):
        collector.add(event('content_block_delta', index=0, delta={'type': 'text_delta', 'text': 'X'}))
    assert collector.text() == 'ABC'


def test_repeated_unidentified_deltas_are_real_and_snapshots_do_not_duplicate():
    records = [event('message_start', message={'id': 'one'}), event('content_block_start', index=0, content_block=text(''))]
    same = event('content_block_delta', index=0, delta={'type': 'text_delta', 'text': 'A'})
    records += [same, same, event('content_block_stop', index=0), event('message_stop'), snapshot('one', text('AA')), result('AA')]
    assert stream(records).success_text(0) == 'AA'


def test_identified_replay_is_deduplicated_and_changed_identity_refuses():
    collector = stream([event('message_start', message={'id': 'one'}), event('content_block_start', index=0, content_block=text(''))])
    delta = {**event('content_block_delta', index=0, delta={'type': 'text_delta', 'text': 'A'}), 'uuid': 'same-event'}
    assert collector.add(delta) is True
    assert collector.add(delta) is False
    assert collector.text() == 'A'
    with pytest.raises(CompleteTextError):
        collector.add({**event('content_block_delta', index=0, delta={'type': 'text_delta', 'text': 'B'}), 'uuid': 'same-event'})
    assert collector.text() == 'A'


def test_arbitrary_terminal_suffix_and_content_after_terminal_cannot_pass():
    collector = stream([snapshot('one', text('PREFIX LATE')), result('LATE')])
    with pytest.raises(CompleteTextError):
        collector.success_text(0)
    collector = stream([snapshot('one', text('LATE')), result('LATE')])
    with pytest.raises(CompleteTextError):
        collector.add(snapshot('later', text('EXTRA')))
    assert collector.text() == 'LATE'

@pytest.mark.parametrize('bad',['\ud800','\udfff'])
def test_invalid_utf8_cannot_replace_prior_partial_text(bad):
    collector=stream([snapshot('one',text('KEPT\r\n'))])
    with pytest.raises(CompleteTextError,match='UTF-8'):
        collector.add(snapshot('two',text(bad)))
    assert collector.text()=='KEPT\r\n'


def per_block_stream(answer, *, snapshot_kind='text', stop_reason='end_turn'):
    """Reduced shape of a real Claude Code stream: a thinking block then a text block under one
    message id, each completed block also sent as its own one-block assistant snapshot."""
    signed = {'type': 'thinking', 'thinking': '', 'signature': 'opaque'}
    return [event('message_start', message={'id': 'm1'}),
            event('content_block_start', index=0, content_block={'type': 'thinking', 'thinking': ''}),
            event('content_block_delta', index=0, delta={'type': 'thinking_delta', 'thinking': ''}),
            event('content_block_delta', index=0, delta={'type': 'signature_delta', 'signature': 'opaque'}),
            snapshot('m1', signed), event('content_block_stop', index=0),
            event('content_block_start', index=1, content_block=text('')),
            event('content_block_delta', index=1, delta={'type': 'text_delta', 'text': answer[:5]}),
            event('content_block_delta', index=1, delta={'type': 'text_delta', 'text': answer[5:]}),
            snapshot('m1', {'type': snapshot_kind, 'text': answer} if snapshot_kind == 'text' else signed),
            event('content_block_stop', index=1),
            event('message_delta', delta={'stop_reason': stop_reason}), event('message_stop'),
            {**result(answer), 'stop_reason': stop_reason}]


def test_one_block_snapshots_after_thinking_assemble_the_text_block():
    answer = 'Step 1: expand. Step 2: sum the terms.'
    assert stream(per_block_stream(answer)).success_text(0) == answer


def test_snapshot_kind_disagreeing_with_latest_started_block_still_refuses():
    records = per_block_stream('Step 1: expand.', snapshot_kind='thinking')
    collector = AssistantText()
    with pytest.raises(CompleteTextError, match='content block type changed'):
        for record in records:
            collector.add(record)


def test_snapshot_with_more_blocks_than_started_refuses():
    collector = stream([event('message_start', message={'id': 'm1'}),
                        event('content_block_start', index=0, content_block=text(''))])
    with pytest.raises(CompleteTextError, match='more blocks'):
        collector.add(snapshot('m1', text('A'), text('B')))


def test_full_content_snapshot_still_aligns_from_the_first_block():
    answer = 'Final.'
    records = per_block_stream(answer)[:-3]
    records.insert(-1, snapshot('m1', {'type': 'thinking', 'thinking': '', 'signature': 'opaque'}, text(answer)))
    records += [event('message_delta', delta={'stop_reason': 'end_turn'}), event('message_stop'), result(answer)]
    assert stream(records).success_text(0) == answer


def test_provider_stopped_response_with_continuation_is_not_complete_output():
    stopped = per_block_stream('Step 1: expand. Step 2: su', stop_reason='refusal')[:-1]
    stopped = [r for r in stopped if r.get('type') != 'assistant' or r['message']['content'][0]['type'] != 'text']
    later = [event('message_start', message={'id': 'm2'}), event('content_block_start', index=0, content_block=text('')),
             event('content_block_delta', index=0, delta={'type': 'text_delta', 'text': 'I will not repeat that.'}),
             event('content_block_stop', index=0), event('message_delta', delta={'stop_reason': 'end_turn'}),
             event('message_stop'), result('I will not repeat that.')]
    collector = stream(stopped + later)
    with pytest.raises(CompleteTextError, match='provider safeguard'):
        collector.success_text(0)


def test_two_messages_each_with_one_block_snapshots_align_per_message():
    first, second = 'First message text.', 'Second message text.'
    m1 = [r for r in per_block_stream(first) if r.get('type') != 'result']
    m2 = [json.loads(json.dumps(r).replace('"m1"', '"m2"')) for r in per_block_stream(second) if r.get('type') != 'result']
    assert stream(m1 + m2 + [result(second)]).success_text(0) == first + second


def test_text_snapshot_arriving_before_its_block_deltas_refuses():
    collector = stream([event('message_start', message={'id': 'm1'}),
                        event('content_block_start', index=0, content_block=text('')),
                        event('content_block_delta', index=0, delta={'type': 'text_delta', 'text': 'A'}),
                        event('content_block_stop', index=0),
                        event('content_block_start', index=1, content_block=text(''))])
    with pytest.raises(CompleteTextError, match='precedes'):
        collector.add(snapshot('m1', text('A')))  # late snapshot of block 0 would land on block 1
    assert collector.text() == 'A'
