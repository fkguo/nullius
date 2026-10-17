"""Protocol witnesses for actual gate consumers; mocked semantics are not scientific reviews."""
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

from assessment_fixture import SUMMARY, assessed_comparison, assessments, transport_for

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/run_multi_backend.py'
spec = importlib.util.spec_from_file_location('full_derivation_executor', SCRIPT)
mb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mb)

CLAIM = {'id': 'neutral', 'statement': 'Compute the sum of raw integers 17 and 25.',
         'report_format': 'integer', 'method0': 'route label one', 'method1': 'different route label'}


def verdict(derivation=SUMMARY):
    return {'canonical_answer': '42', 'derivation': derivation, 'derivation_summary': 'Navigation only',
            'confidence': 'high', 'checkable_form': '42'}


def runner(*, missing_steps=False, risk=None, failed=False):
    def run(model, system, prompt, tag):
        if failed:
            run.invocations[tag] = {'exit_code': 9}
        if 'compare' in tag:
            payload = {'majority_answer': '42', 'majority_size': 2, 'majority_indices': [0, 1],
                       'adjudicated_matches_majority': True}
            parsed = assessed_comparison(payload, prompt)
            if risk is not None:
                ds, _ = json.JSONDecoder().raw_decode(prompt.split('FULL_DERIVATION_RECORDS_JSON:\n', 1)[1])
                parsed['method_risk_assessments'] = [{'indices': [0, 1], 'addresses_shared_failure': risk, 'methods_distinct': risk,
                    'risk': 'Both use the same addition rule; a shared operand-transcription error must be independently diagnosed.',
                    'method_analysis': 'The frozen actual derivations show whether separate raw-operand checks address that failure; hint wording is irrelevant.',
                    'evidence': [{'index': i, 'source_span': d['derivation'],
                                 'reason': 'The actual lane steps, rather than its requested route name, determine what shared failure is addressed.'}
                                 for i, d in enumerate(ds)]}]
            return json.dumps(parsed)
        out = verdict()
        if missing_steps:
            out.pop('derivation')
            out['derivation_summary'] = 'I am fresh and independent; all checks passed.'
        return json.dumps(out)
    if failed:
        run.invocations = {}
    return run


def verify(c=CLAIM, run=None):
    return mb.verify_claim(c, ctx='Only raw inputs, no expected answer.', pool=['claude/opus'],
        comparators=['claude/opus'], max_iter=0, run=run or runner())


def test_different_hints_do_not_satisfy_explicit_shared_failure_risk():
    c = {**CLAIM, 'requires_method_diversity': True,
         'method_diversity_risk': 'Shared arithmetic rule with no independent operand-transcription diagnostic.'}
    for risk in (None, False, 'true'):
        row = verify(c, runner(risk=risk))
        assert not row['converged'] and row['independent_confirmations'] == 0
        assert row['method_risk_satisfied'] is False
    assert verify(CLAIM)['converged']  # base same-method/same-family allowance remains


def test_actual_pair_risk_assessment_is_the_consumed_condition():
    row = verify({**CLAIM, 'requires_method_diversity': True}, runner(risk=True))
    assert row['converged'] and row['method_risk_satisfied']
    assert row['independence_evidence']['method_diversity'] == ['exact arithmetic']
    assert row['independence_evidence']['method_hints'] == ['route label one', 'different route label']


def test_missing_original_steps_cannot_be_replaced_by_freshness_summary():
    assert verify(CLAIM, runner(missing_steps=True))['independent_confirmations'] == 0


def test_failed_actual_invocation_cannot_be_overridden_by_valid_json():
    row = verify(CLAIM, runner(failed=True))
    assert not row['converged'] and row['independent_confirmations'] == 0


def test_bare_native_provenance_names_do_not_count():
    lanes = [{**verdict(), 'family': 'host', 'execution_id': f'author-name-{i}', 'method': 'fresh'} for i in range(2)]
    row = mb.verify_claim({**CLAIM, 'native_derivations': lanes}, ctx='raw inputs', pool=[],
                         comparators=['claude/opus'], max_iter=0, run=runner())
    assert not row['converged'] and row['independent_confirmations'] == 0


def test_complete_original_material_and_observed_requests_are_not_truncated():
    original = 'Begin complete derivation.\n' + '\n'.join(f'Original step {i}: preserve this exact evidence.' for i in range(300)) + '\nUNIQUE_FINAL_SOURCE_ANCHOR'
    seen = []
    def run(model, system, prompt, tag):
        if 'compare' in tag:
            seen.append(prompt)
            report = assessed_comparison({'majority_answer':'42', 'majority_size': 2, 'majority_indices': [0, 1],
                'adjudicated_matches_majority': True}, prompt)
            # Complete transport is tested in the request; exact evidence spans
            # need not repeat the whole long source in every output field.
            for a in report['independence_assessments']:
                for e in a['evidence'].values(): e['source_span'] = original[:200]
            return json.dumps(report)
        return json.dumps(verdict(original))
    # Two complete 14.6 kB lanes must pass the comparator under the DEFAULT byte window
    # (159,040 bytes) without truncation on this capture-free path; each lane's text appears
    # twice (derivation, transport.raw_output), pinned below together with the live-capture path.
    assert verify(CLAIM, run)['converged']
    packet, _ = json.JSONDecoder().raw_decode(seen[0].split('FULL_DERIVATION_RECORDS_JSON:\n', 1)[1])
    assert len(seen[0].encode('utf-8')) <= mb.request_budgets()['context_bytes']
    assert all(d['derivation'] == original for d in packet)
    assert all(CLAIM['statement'] in d['transport']['request']['prompt'] for d in packet)
    assert all(json.loads(d['transport']['raw_output'])['derivation'] == original for d in packet)


ANCHOR = 'UNIQUE_FINAL_SOURCE_ANCHOR'
LONG_ORIGINAL = 'Begin complete derivation.\n' + '\n'.join(f'Original step {i}: preserve this exact evidence.' for i in range(300)) + '\n' + ANCHOR


def packet_for(raw, lanes=2, run=None):
    run = run or (lambda *a: raw)
    ds = [mb._execute_derivation(run, 'claude/opus', mb._DERIVE_SYSTEM, 'neutral raw problem', f'fresh-{i}') for i in range(lanes)]
    prompt = mb._compare_prompt('Only raw inputs, no expected answer.', CLAIM, ds, ['host'] * lanes)
    packet, _ = json.JSONDecoder().raw_decode(prompt.split('FULL_DERIVATION_RECORDS_JSON:\n', 1)[1])
    return ds, prompt, packet


def copies_per_field(record):
    return {key: json.dumps(value, ensure_ascii=False).count(ANCHOR) for key, value in record.items() if ANCHOR in json.dumps(value, ensure_ascii=False)}


def test_comparator_packet_repeats_lane_text_only_inside_transport():
    # Without additional assistant text the lane text appears exactly twice per record:
    # the structured derivation field and the complete observed transport.raw_output.
    ds, prompt, packet = packet_for(json.dumps(verdict(LONG_ORIGINAL)))
    assert all(mb.valid_derivation_transport(d) for d in ds)
    for record in packet:
        assert copies_per_field(record) == {'derivation': 1, 'transport': 1}
        assert not {'assessment_source', 'original_assistant_output', 'derivation_context'} & set(record)
        assert record['additional_assistant_text_present'] is False
    assert prompt.count(ANCHOR) == 2 * len(packet)
    # Two complete 300-step lanes (14.6 kB each) fit the default window. The same fixture gave six
    # copies per record and 190 kB after 755a64dd added duplicates, four copies and 130 kB after
    # c41fe396 removed the byte-identical ones, and two copies and 66 kB once assessment_source went.
    assert len(prompt.encode('utf-8')) <= mb.request_budgets()['context_bytes']
    # With additional assistant text the complete original output travels once as derivation_context
    # and the packet's transport names it (raw_output_given_as) instead of repeating the bytes.
    raw = 'An earlier original premise and necessary step.\n' + json.dumps(verdict(LONG_ORIGINAL))
    ds, prompt, packet = packet_for(raw)
    assert all(mb.valid_derivation_transport(d) for d in ds)
    for record in packet:
        assert copies_per_field(record) == {'derivation': 1, 'derivation_context': 1}
        assert record['derivation_context'] == raw and record['transport']['raw_output_given_as'] == 'derivation_context'
        assert record['additional_assistant_text_present'] is True
        assert 'assessment_source' not in record and 'original_assistant_output' not in record
    assert prompt.count(ANCHOR) == 2 * len(packet)


SESSION = '00000000-0000-4000-8000-000000000000'


def live_stream(raw, *, tool=False, alter_delta=False, extra=False):
    """Events shaped like a real Claude CLI live capture of a 12 kB lane, reduced to generic content.
    The real capture had 972 events and 348 kB: an init event, 76 thinking-token counters, 77 thinking
    deltas with no text, a 34 kB thinking signature sent as a delta and repeated in the snapshot,
    805 text deltas of about 15 characters, the text snapshot and the result event. With tool=True a
    tool_use block and its tool_result are added; alter_delta changes one byte of one text delta; extra
    adds content a stream can carry besides the output: a tool list in init, a compaction record, a
    synthetic user message, an orphan delta, a malformed line and result errors and denials."""
    ids = iter(range(10 ** 6))
    def env(event, display=False):
        event.update(session_id=SESSION, parent_tool_use_id=None, uuid=f'{next(ids):08x}-0000-4000-8000-000000000000')
        if display:
            event['thinking_display'] = 'updates'
        return event
    def stream(inner, display=False):
        return env({'type': 'stream_event', 'event': inner}, display)
    signature = ''
    while len(signature) < 34000:
        signature += hashlib.sha256(signature.encode()).hexdigest()
    usage = {'input_tokens': 2, 'cache_creation_input_tokens': 11410, 'output_tokens': 8, 'service_tier': 'standard'}
    message = {'model': 'some-model', 'id': 'msg_generic', 'type': 'message', 'role': 'assistant', 'stop_reason': None, 'usage': usage}
    events = [env({'type': 'system', 'subtype': 'init', 'cwd': '/work', 'tools': [], 'mcp_servers': [], 'model': 'some-model',
                   'slash_commands': [f'generic-skill-{i}' for i in range(200)], 'apiKeySource': 'none',
                   **({'tools': ['WebSearch', 'Bash']} if extra else {})}),
              env({'type': 'system', 'subtype': 'status', 'status': 'requesting'}),
              stream({'type': 'message_start', 'message': {**message, 'content': []}}),
              stream({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'thinking', 'thinking': '', 'signature': ''}}, True)]
    for k in range(77):
        events.append(env({'type': 'system', 'subtype': 'thinking_tokens', 'estimated_tokens': 50 * (k + 1), 'estimated_tokens_delta': 50}))
        events.append(stream({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'thinking_delta', 'thinking': '', 'estimated_tokens': 50 * (k + 1)}}, True))
    events += [stream({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'signature_delta', 'signature': signature}}),
               env({'type': 'assistant', 'message': {**message, 'content': [{'type': 'thinking', 'thinking': '', 'signature': signature}]}, 'request_id': 'req_generic'}),
               stream({'type': 'content_block_stop', 'index': 0}),
               stream({'type': 'content_block_start', 'index': 1, 'content_block': {'type': 'text', 'text': ''}})]
    pieces = [raw[i:i + 15] for i in range(0, len(raw), 15)]
    if alter_delta:
        pieces[3] = pieces[3][:-1] + ('X' if pieces[3][-1] != 'X' else 'Y')
    events += [stream({'type': 'content_block_delta', 'index': 1, 'delta': {'type': 'text_delta', 'text': piece}}) for piece in pieces]
    events += [env({'type': 'assistant', 'message': {**message, 'content': [{'type': 'text', 'text': raw}]}, 'request_id': 'req_generic'}),
               stream({'type': 'content_block_stop', 'index': 1})]
    if tool:
        events += [env({'type': 'assistant', 'message': {**message, 'content': [{'type': 'tool_use', 'id': 'toolu_generic', 'name': 'Bash', 'input': {'command': 'python3 check.py'}}]}}),
                   env({'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'toolu_generic', 'content': TOOL_OUTPUT}]}})]
    if extra:
        events += [env({'type': 'system', 'subtype': 'compact_boundary', 'compact_metadata': {'trigger': 'auto', 'pre_tokens': 150000}}),
                   env({'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': SYNTHETIC}]}, 'isSynthetic': True}),
                   env({'type': 'assistant', 'message': {**message, 'content': [{'type': 'text', 'text': PARTIAL}]}}),
                   env({'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': raw}]}}),
                   stream({'type': 'content_block_delta', 'index': 7, 'delta': {'type': 'text_delta', 'text': 'orphan fragment'}}),
                   '{"type": "stream_event", truncated line']
    events += [stream({'type': 'message_delta', 'delta': {'stop_reason': 'max_tokens' if extra else 'end_turn'}, 'usage': usage}),
               stream({'type': 'message_stop'}),
               {'type': 'rate_limit_event', 'rate_limit_info': {'status': 'allowed'}, 'session_id': SESSION, 'uuid': 'ffffffff-0000-4000-8000-000000000000'},
               {'type': 'result', 'subtype': 'success', 'is_error': False, 'duration_ms': 148000, 'num_turns': 1, 'result': raw,
                'stop_reason': 'end_turn', 'session_id': SESSION, 'total_cost_usd': 0.5, 'usage': usage, 'uuid': 'eeeeeeee-0000-4000-8000-000000000000',
                'modelUsage': {'some-model': {'inputTokens': 2, 'outputTokens': 17887, 'costUSD': 0.5}},
                **({'errors': ['tool denied'], 'permission_denials': [{'tool_name': 'WebSearch'}]} if extra else {})}]
    return events, signature


SYNTHETIC = 'Original step 7: preserve this exact evidence.'  # occurs inside the lane output
PARTIAL = 'Original step 9: preserve this exact evidence.'    # an assistant text that is only part of the output
TOOL_OUTPUT = 'check.py: residual of the rearranged identity is exactly zero for all 64 sampled points'


class LiveCapture:
    """Runner adapter that writes the stream and its terminal sidecar where the CLI runner puts them."""
    def __init__(self, root, raw, sidecar=None, **shape):
        self.root, self.raw, self.sidecar, self.shape, self.invocations, self.signature = root, raw, sidecar, shape, {}, None
    def __call__(self, spec, system, prompt, tag):
        d = self.root / tag; d.mkdir()
        out = d / 'out.txt'; out.write_text(self.raw, encoding='utf-8')
        capture = Path(str(out) + '.attempts') / 'run.current'; capture.mkdir(parents=True)
        events, self.signature = live_stream(self.raw, **self.shape)
        (capture / 'attempt_1.events.jsonl').write_text(''.join((e if isinstance(e, str) else json.dumps(e, separators=(',', ':'))) + '\n' for e in events), encoding='utf-8')
        sidecar = json.dumps(events[-1], indent=2) + '\n'
        (capture / 'attempt_1.events.result.json').write_text(self.sidecar(sidecar) if self.sidecar else sidecar, encoding='utf-8')
        (capture / 'attempt_1.events.progress.json').write_text(json.dumps({'capture_health': 'observable', 'event_count': len(events)}, indent=2) + '\n', encoding='utf-8')
        self.invocations[tag] = {'exit_code': 0, 'output': str(out)}
        return self.raw


def carried(d, record, suffix):
    path = next(p for p in d['transport']['captured_records'] if p.endswith(suffix))
    return path, record['transport']['captured_records'][path]


def text_values(blocks):
    return [b['block'][f] for b in blocks if isinstance(b.get('block'), dict) for f in ('text', 'result') if f in b['block']]


def test_live_capture_stream_is_carried_as_content_blocks_and_two_lanes_fit(tmp_path):
    # A live stream repeats the output in its snapshot, deltas, result event and sidecar, and wraps
    # every delta in an event envelope: one realistic stream alone is larger than the default window.
    # The packet shows its content; every text value of the lane's own output is a reference to
    # transport.raw_output, proven equal to it at assembly, the sidecar goes by reference as the
    # re-serialized terminal event, and event bookkeeping and the thinking signature are not shown.
    raw = json.dumps(verdict(LONG_ORIGINAL))
    run = LiveCapture(tmp_path, raw)
    ds, prompt, packet = packet_for(raw, run=run)
    assert all(mb.valid_derivation_transport(d) for d in ds)
    for record, d in zip(packet, ds):
        refs = {ref['path']: ref for ref in d['transport']['artifact_refs']}
        path, stream = carried(d, record, '.events.jsonl')
        assert len(d['transport']['captured_records'][path].encode('utf-8')) > mb.request_budgets()['context_bytes']
        assert stream['carried'] == 'content_blocks' and stream['ref'] == refs[path] and set(refs[path]) == {'path', 'sha256', 'size'}
        values = text_values(stream['blocks'])
        assert len(values) == 3  # streamed text, text snapshot, terminal result
        for value in values:
            assert value == {'equals': 'transport.raw_output', 'sha256': hashlib.sha256(raw.encode()).hexdigest()}
        assert not any(b['block'].get('type') == 'thinking' for b in stream['blocks'] if 'block' in b)
        path, sidecar = carried(d, record, '.events.result.json')
        assert sidecar == {'carried': 'by_reference', 'ref': refs[path],
                           'proven': 'bytes equal the terminal event of attempt_1.events.jsonl written with indent 2'}
        path, progress = carried(d, record, '.events.progress.json')
        assert progress == {'carried': 'inline', 'content': d['transport']['captured_records'][path]}
        assert copies_per_field(record) == {'derivation': 1, 'transport': 1}
    assert prompt.count(ANCHOR) == 2 * len(packet)
    assert run.signature not in prompt and SESSION not in prompt and '-0000-4000-8000-' not in prompt
    # Two complete 14.6 kB lanes with realistic live capture fit the default window, with margin.
    assert mb.validate_request_bytes(mb._COMPARE_SYSTEM, prompt, mb.request_budgets()) <= 0.6 * mb.request_budgets()['context_bytes']



def test_stream_view_omits_only_bookkeeping_and_references_only_the_lanes_own_output(tmp_path):
    # Everything a stream holds besides ids, timing/usage/cost counters, status/token/rate-limit events,
    # stream markers, empty thinking and signatures stays visible: the tool list and model of the lane,
    # a compaction record, stop reasons, result errors and permission denials, which models served it,
    # a synthetic user message and an assistant text that is only part of the output (both verbatim
    # although their text occurs inside the lane output), a user message that repeats the whole output
    # (verbatim: only the lane's own messages are referenced), an orphan delta and a malformed line.
    raw = json.dumps(verdict(LONG_ORIGINAL))
    run = LiveCapture(tmp_path, raw, extra=True)
    ds, prompt, packet = packet_for(raw, run=run)
    assert SYNTHETIC in raw
    for record, d in zip(packet, ds):
        _, stream = carried(d, record, '.events.jsonl')
        blocks = stream['blocks']
        init = next(b['event_fields'] for b in blocks if b.get('event_fields', {}).get('subtype') == 'init')
        assert init['tools'] == ['WebSearch', 'Bash'] and init['model'] == 'some-model'
        assert any(b.get('event_fields', {}).get('subtype') == 'compact_boundary' for b in blocks)
        assert {'source': 'stream', 'message_delta': {'stop_reason': 'max_tokens'}} in blocks
        assert {'source': 'user', 'block': {'type': 'text', 'text': SYNTHETIC}} in blocks
        assert {'source': 'user', 'event_fields': {'isSynthetic': True}} in blocks
        assert {'source': 'assistant', 'block': {'type': 'text', 'text': PARTIAL}} in blocks  # part of a field is not equality
        assert {'source': 'user', 'block': {'type': 'text', 'text': raw}} in blocks  # user text is never the lane's output
        assert {'source': 'unrecognized_line', 'line': '{"type": "stream_event", truncated line'} in blocks
        assert any(b['source'] == 'unrecognized_line' and 'orphan fragment' in b['line'] for b in blocks)
        result = next(b['block'] for b in blocks if b['source'] == 'result')
        assert result['errors'] == ['tool denied'] and result['permission_denials'] == [{'tool_name': 'WebSearch'}]
        assert result['modelUsage'] == {'some-model': {}} and result['num_turns'] == 1
        assert not {'session_id', 'uuid', 'usage', 'total_cost_usd', 'duration_ms'} & set(result)
        assert not any(b.get('event_fields', {}).get('subtype') in ('status', 'thinking_tokens') for b in blocks)
    # The unrecognized orphan delta line keeps its envelope verbatim; recognized events show none.
    assert run.signature not in prompt and prompt.count(SESSION) == len(packet)


def test_captured_content_not_proven_equal_to_a_shipped_field_stays_inline(tmp_path):
    # One altered byte in one text delta: the streamed text no longer equals a shipped field and is
    # shown verbatim, while the snapshot and result text keep their references. Tool use
    # and tool results are content the packet does not otherwise hold and stay verbatim. A sidecar
    # that differs from the terminal event by one byte, or whose reference does not identify the
    # captured bytes, stays inline.
    raw = json.dumps(verdict(LONG_ORIGINAL))
    altered = lambda text: text.replace('"num_turns": 1', '"num_turns": 2')
    ds, prompt, packet = packet_for(raw, run=LiveCapture(tmp_path, raw, sidecar=altered, tool=True, alter_delta=True))
    assert all(mb.valid_derivation_transport(d) for d in ds)
    for record, d in zip(packet, ds):
        _, stream = carried(d, record, '.events.jsonl')
        assert stream['carried'] == 'content_blocks'
        streamed, snapshot, result = text_values(stream['blocks'])
        assert isinstance(streamed, str) and streamed != raw and len(streamed) == len(raw)
        assert isinstance(snapshot, dict) and isinstance(result, dict)
        blocks = [b['block'] for b in stream['blocks'] if 'block' in b]
        assert {'type': 'tool_use', 'id': 'toolu_generic', 'name': 'Bash', 'input': {'command': 'python3 check.py'}} in blocks
        assert {'type': 'tool_result', 'tool_use_id': 'toolu_generic', 'content': TOOL_OUTPUT} in blocks
        path, sidecar = carried(d, record, '.events.result.json')
        assert sidecar == {'carried': 'inline', 'content': d['transport']['captured_records'][path]}
        # raw_output, the altered streamed text and the altered sidecar's result field
        assert copies_per_field(record) == {'derivation': 1, 'transport': 3}
    # A reference that does not identify the captured bytes proves nothing: the record stays inline.
    d = ds[0]
    path = next(p for p in d['transport']['captured_records'] if p.endswith('.events.jsonl'))
    stale = {**d, 'transport': {**d['transport'], 'artifact_refs': [
        {**ref, 'sha256': '0' * 64} if ref['path'] == path else ref for ref in d['transport']['artifact_refs']]}}
    assert mb.packet_transport(stale)['captured_records'][path] == {'carried': 'inline', 'content': d['transport']['captured_records'][path]}


def test_captured_text_is_referenced_only_to_a_field_spans_can_quote(tmp_path):
    # With additional assistant text the raw output is the context and the structured derivation is
    # not an input/execution source, so a captured record equal only to the derivation stays inline,
    # while one equal to the raw output goes by reference to derivation_context.
    raw = 'Working notes before the JSON.\n' + json.dumps(verdict(LONG_ORIGINAL))
    ds, _, _ = packet_for(raw, run=LiveCapture(tmp_path, raw), lanes=1)
    d = ds[0]
    extra = {}
    for name, text in (('derivation-copy.log', d['derivation']), ('raw-copy.log', raw)):
        path = tmp_path / name; path.write_text(text, encoding='utf-8')
        extra[str(path)] = {'path': str(path), 'sha256': hashlib.sha256(text.encode()).hexdigest(), 'size': len(text.encode())}
    transport = {**d['transport'], 'captured_records': {**d['transport']['captured_records'], **{p: Path(p).read_text() for p in extra}},
                 'artifact_refs': d['transport']['artifact_refs'] + list(extra.values())}
    shown = mb.packet_transport(mb.observe_runtime_derivation({**d, 'transport': transport}))['captured_records']
    derivation_copy, raw_copy = (shown[p] for p in extra)
    assert derivation_copy == {'carried': 'inline', 'content': d['derivation']}
    assert raw_copy == {'carried': 'by_reference', 'ref': extra[next(p for p in extra if p.endswith('raw-copy.log'))], 'proven': 'bytes equal derivation_context'}


def test_live_capture_request_above_the_window_is_refused_not_truncated(tmp_path):
    # Carriage changes what is shown, never the capacity rule: a request whose inline captured
    # content exceeds the window is refused before the comparator runs, and nothing is cut.
    raw = json.dumps(verdict(LONG_ORIGINAL))
    global TOOL_OUTPUT
    saved, TOOL_OUTPUT = TOOL_OUTPUT, 'log line kept verbatim\n' * 4000
    try:
        ds, prompt, packet = packet_for(raw, run=LiveCapture(tmp_path, raw, tool=True))
    finally:
        TOOL_OUTPUT = saved
    assert all('log line kept verbatim\n' * 4000 in json.dumps(r, ensure_ascii=False) or 'log line kept verbatim\\n' * 4000 in json.dumps(r, ensure_ascii=False) for r in packet)
    called = []
    run = lambda *a: called.append(a) or ''
    cmp, n_ok = mb._compare(CLAIM, 'Only raw inputs, no expected answer.', ds, ['host'] * len(ds), ['claude/opus'], run, tag='compare')
    assert n_ok == 0 and called == [] and not cmp['majority_indices']
    assert cmp['request_capacity']['judges'][0]['reason'] == 'unavailable: complete original request exceeds configured byte budget; no truncation'


def test_input_execution_spans_quote_captured_content_only_as_the_packet_shows_it(tmp_path):
    # Captured text carried by reference is quoted through the shipped field it equals; content kept
    # inline is quoted through the inline block; bookkeeping the packet does not show, and text in no
    # lane material, are refused.
    raw = json.dumps(verdict(LONG_ORIGINAL))
    run = LiveCapture(tmp_path, raw, tool=True, alter_delta=True)
    ds, prompt, packet = packet_for(raw, run=run)
    pieces = [raw[i:i + 15] for i in range(0, len(raw), 15)]
    altered_piece = pieces[3][:-1] + ('X' if pieces[3][-1] != 'X' else 'Y')
    base = assessments(ds)
    for span, ok in (('Original step 150: preserve this exact evidence.', True),   # by reference, via raw_output
                     (TOOL_OUTPUT, True),                                          # inline tool_result block
                     ('"stop_reason": "end_turn"', True),                          # result field as encoded
                     (pieces[2] + altered_piece, True),                            # inline altered streamed text
                     (run.signature[:64], False),                                  # thinking signature, not shown
                     (SESSION, False),                                             # event envelope, not shown
                     ('not in any lane material', False)):
        aa = json.loads(json.dumps(base))
        for a in aa:
            a['evidence']['input']['source_span'] = span
            a['evidence']['execution']['source_span'] = span
        assert (mb.assessed_indices(ds, aa) == [0, 1]) is ok, span


def test_input_execution_spans_match_packet_transport_encoding_and_decoded_values():
    # The packet encodes transport with sorted keys, byte-identical to the text the check uses; a span
    # copied from that encoding, from a decoded transport value, or from the summary is found for
    # input/execution, while construction still needs the body itself.
    # The summary carries a quote and a newline, so it is JSON-escaped inside raw_output and can
    # only match through the derivation_summary source itself.
    summary = 'Navigation "only"\nsecond line'
    raw = json.dumps({**verdict(SUMMARY), 'derivation_summary': summary})
    ds, prompt, packet = packet_for(raw)
    encoded = prompt.split('FULL_DERIVATION_RECORDS_JSON:\n', 1)[1]
    shown = json.dumps(mb.packet_transport(ds[0]), ensure_ascii=False, sort_keys=True)
    assert shown in encoded and shown == json.dumps(packet[0]['transport'], ensure_ascii=False, sort_keys=True)
    escaped = json.dumps(raw, ensure_ascii=False)[1:-1]  # raw_output exactly as the packet shows it
    assert escaped != raw and escaped in shown
    base = assessments(ds)
    for span, ok in ((escaped[:60], True), (raw, True), ('neutral raw problem', True), (summary, True), ('not in any lane material', False)):
        aa = json.loads(json.dumps(base))
        for a in aa:
            a['evidence']['input']['source_span'] = span
            a['evidence']['execution']['source_span'] = span
        assert (mb.assessed_indices(ds, aa) == [0, 1]) is ok, span
    aa = json.loads(json.dumps(base))
    for a in aa:
        a['evidence']['construction']['source_span'] = 'neutral raw problem'
    assert mb.assessed_indices(ds, aa) == []
    # With additional assistant text the packet's transport carries the raw_output_given_as marker in
    # place of raw_output; that encoding is what the check compares against, and the raw output itself
    # stays quotable as the lane's context.
    raw = 'Working notes before the JSON.\n' + raw
    ds, prompt, packet = packet_for(raw)
    shown = json.dumps(mb.packet_transport(ds[0]), ensure_ascii=False, sort_keys=True)
    assert shown in prompt and '"raw_output_given_as": "derivation_context"' in shown and '"raw_output"' not in shown
    base = assessments(ds)
    for span, ok in (('"raw_output_given_as": "derivation_context"', True), (json.dumps(raw, ensure_ascii=False)[1:-1][:80], True), (raw, True), ('Working notes before the JSON.', True), (summary, True), ('not in any lane material', False)):
        aa = json.loads(json.dumps(base))
        for a in aa:
            a['evidence']['input']['source_span'] = span
            a['evidence']['execution']['source_span'] = span
        assert (mb.assessed_indices(ds, aa) == [0, 1]) is ok, span



def test_complete_original_output_with_text_outside_json_is_not_truncated():
    original = 'Begin complete derivation.\n' + '\n'.join(f'Original step {i}: preserve this exact evidence.' for i in range(300)) + '\nUNIQUE_FINAL_SOURCE_ANCHOR'
    early = 'Working notes before the JSON: the operands are the raw integers 17 and 25.\n'
    raw = early + json.dumps(verdict(original))
    seen = []
    def run(model, system, prompt, tag):
        if 'compare' in tag:
            seen.append(prompt)
            report = assessed_comparison({'majority_answer':'42', 'majority_size': 2, 'majority_indices': [0, 1],
                'adjudicated_matches_majority': True}, prompt)
            for a in report['independence_assessments']:
                for e in a['evidence'].values(): e['source_span'] = early.strip()
            return json.dumps(report)
        return raw
    assert verify(CLAIM, run)['converged']
    packet, _ = json.JSONDecoder().raw_decode(seen[0].split('FULL_DERIVATION_RECORDS_JSON:\n', 1)[1])
    assert all(d['derivation'] == original and d['derivation_context'] == raw for d in packet)
    assert all(CLAIM['statement'] in d['transport']['request']['prompt'] for d in packet)



MULTILINE_STEPS = 'Begin complete derivation.\nStep A: the raw operands are "17" and "25".\nStep B: 17 + 25 = 42 — exact integer sum.'
PREFIX = 'Working notes before the JSON: raw operands only.\n'


def prefixed_lane_runner(spans, *, risk=False, derivation=MULTILINE_STEPS, raw=None):
    """Lane output holds text outside its JSON object; the examiner quotes the given spans."""
    raw = raw or PREFIX + json.dumps(verdict(derivation))
    def run(model, system, prompt, tag):
        if 'compare' in tag:
            report = assessed_comparison({'majority_answer': '42', 'majority_size': 2, 'majority_indices': [0, 1],
                'adjudicated_matches_majority': True}, prompt)
            for a in report['independence_assessments']:
                for axis, e in a['evidence'].items(): e['source_span'] = spans[axis]
            if risk:
                report['method_risk_assessments'] = [{'indices': [0, 1], 'addresses_shared_failure': True, 'methods_distinct': True,
                    'risk': 'A shared operand-transcription error must be independently diagnosed by each lane.',
                    'method_analysis': 'Each lane restates the raw operands before summing, so a transcription slip is visible.',
                    'evidence': [{'index': i, 'source_span': spans['construction'],
                                  'reason': 'The quoted steps show the operands restated from the raw input before the sum.'} for i in (0, 1)]}]
            return json.dumps(report)
        return raw
    return run


def test_multiline_quote_of_structured_derivation_counts_when_output_holds_text_outside_json():
    # In the raw output the derivation is JSON-quoted (escaped newlines, quotes, non-ASCII);
    # a faithful quote of the readable field is still a quote of the original lane material.
    span = MULTILINE_STEPS.split('\n', 1)[1]
    assert span not in PREFIX + json.dumps(verdict(MULTILINE_STEPS))
    row = verify(CLAIM, prefixed_lane_runner({axis: span for axis in ('input', 'execution', 'construction', 'applicability', 'diagnostic')}))
    assert row['converged'] and row['independent_confirmations'] == 2
    row = verify({**CLAIM, 'requires_method_diversity': True},
                 prefixed_lane_runner({axis: span for axis in ('input', 'execution', 'construction', 'applicability', 'diagnostic')}, risk=True))
    assert row['converged'] and row['method_risk_satisfied']
    prefix_only = {axis: PREFIX.strip() for axis in ('input', 'execution', 'construction', 'applicability', 'diagnostic')}
    assert verify(CLAIM, prefixed_lane_runner(prefix_only))['converged']


def test_quotes_outside_original_lane_material_still_refuse_when_output_holds_text_outside_json():
    span = MULTILINE_STEPS.split('\n', 1)[1]
    for axis in ('construction', 'applicability', 'diagnostic'):
        for bad in (CLAIM['statement'], span.replace('42', '43')):
            spans = {a: span for a in ('input', 'execution', 'construction', 'applicability', 'diagnostic')}
            spans[axis] = bad
            row = verify(CLAIM, prefixed_lane_runner(spans))
            assert not row['converged'] and row['independent_confirmations'] == 0, (axis, bad)
    for bad in (CLAIM['statement'], span.replace('42', '43')):
        row = verify({**CLAIM, 'requires_method_diversity': True}, _risk_with_span(span, bad))
        assert not row['converged'] and not row['method_risk_satisfied'], bad




BODY_AXES = ('construction', 'applicability', 'diagnostic')
ALL_AXES = ('input', 'execution') + BODY_AXES


def test_selected_json_fields_other_than_derivation_cannot_supply_body_quotes():
    obj = json.dumps(verdict(MULTILINE_STEPS))
    step = MULTILINE_STEPS.split('\n', 1)[1]
    closing = 'Closing remark: exact integers, no rounding.'
    outputs = {'prefix': PREFIX + obj, 'trailing': obj + '\n' + closing,
               'repeated copy': PREFIX + obj + '\nRepeated:\n' + obj}
    # The navigation summary, other fields of the selected object, or a quote running into it never count.
    refused = ('Navigation only', '"confidence": "high"', '"canonical_answer": "42"', PREFIX + '{"canonical_answer"')
    for name, raw in outputs.items():
        for bad in refused:
            for axis in BODY_AXES:
                spans = {a: step for a in ALL_AXES}
                spans[axis] = bad
                row = verify(CLAIM, prefixed_lane_runner(spans, raw=raw))
                assert not row['converged'] and row['independent_confirmations'] == 0, (name, bad, axis)
        risk = verify({**CLAIM, 'requires_method_diversity': True}, _risk_with_span(step, 'Navigation only', raw=raw))
        assert not risk['converged'] and not risk['method_risk_satisfied'], name
        # Steps outside the object and the structured derivation as read still count.
        outside = PREFIX.strip() if name != 'trailing' else closing
        for good in (outside, step):
            row = verify(CLAIM, prefixed_lane_runner({a: good for a in ALL_AXES}, raw=raw))
            assert row['converged'] and row['independent_confirmations'] == 2, (name, good)
        risk = verify({**CLAIM, 'requires_method_diversity': True}, _risk_with_span(step, outside, raw=raw))
        assert risk['converged'] and risk['method_risk_satisfied'], name
    # Text on the two sides of the object is never joined into a quote that the output does not contain.
    raw = PREFIX + obj + '\n' + closing
    stitched = PREFIX + '\n' + closing
    assert stitched not in raw
    for axis in BODY_AXES:
        spans = {a: step for a in ALL_AXES}
        spans[axis] = stitched
        row = verify(CLAIM, prefixed_lane_runner(spans, raw=raw))
        assert not row['converged'] and row['independent_confirmations'] == 0, axis



def test_other_answer_shaped_json_objects_cannot_supply_body_quotes():
    final = verdict(MULTILINE_STEPS)
    step = MULTILINE_STEPS.split('\n', 1)[1]
    draft = json.dumps({**final, 'confidence': 'low', 'derivation_summary': 'Draft navigation summary.'})
    cases = {
        'draft before final': (PREFIX + draft + '\n' + json.dumps(final), ['Draft navigation summary.', '"confidence": "low"']),
        'wrapper with summary': (PREFIX + json.dumps({'derivation_summary': 'Wrapper navigation summary.', 'payload': final}),
                                 ['Wrapper navigation summary.', '"payload"']),
        'stray summary object': (PREFIX + json.dumps({'derivation_summary': 'Stray summary object.'}) + '\n' + json.dumps(final),
                                 ['Stray summary object.']),
        'answer-only draft, fenced final': (
            PREFIX + json.dumps({'canonical_answer': '42', 'derivation': 'Draft-only step text.', 'confidence': 'low'})
            + '\n```json\n' + json.dumps(final) + '\n```', ['Draft-only step text.', '"confidence": "low"']),
    }
    for name, (raw, refused) in cases.items():
        for bad in refused:
            for axis in BODY_AXES:
                spans = {a: step for a in ALL_AXES}
                spans[axis] = bad
                row = verify(CLAIM, prefixed_lane_runner(spans, raw=raw))
                assert not row['converged'] and row['independent_confirmations'] == 0, (name, bad, axis)
            risk = verify({**CLAIM, 'requires_method_diversity': True}, _risk_with_span(step, bad, raw=raw))
            assert not risk['converged'] and not risk['method_risk_satisfied'], (name, bad)
        # Text outside every answer-shaped object and the structured derivation still count,
        # also when the selected object sits inside an excluded wrapper.
        for good in (PREFIX.strip(), step):
            row = verify(CLAIM, prefixed_lane_runner({a: good for a in ALL_AXES}, raw=raw))
            assert row['converged'] and row['independent_confirmations'] == 2, (name, good)
    # A wrapper without either key is other assistant text, not an answer object.
    raw = PREFIX + json.dumps({'note': 'Wrapper note without answer keys.', 'result': final})
    row = verify(CLAIM, prefixed_lane_runner({a: 'Wrapper note without answer keys.' for a in ALL_AXES}, raw=raw))
    assert row['converged'] and row['independent_confirmations'] == 2
    row = verify(CLAIM, prefixed_lane_runner({a: 'Navigation only' for a in ALL_AXES}, raw=raw))
    assert not row['converged']


def test_input_and_execution_keep_the_complete_transport_closure():
    step = MULTILINE_STEPS.split('\n', 1)[1]
    for axis in ('input', 'execution'):
        spans = {a: step for a in ALL_AXES}
        spans[axis] = 'Navigation only'
        row = verify(CLAIM, prefixed_lane_runner(spans))
        assert row['converged'] and row['independent_confirmations'] == 2, axis


def test_crlf_prose_outside_json_matches_a_quote_written_with_plain_newlines():
    prose = 'Working notes, line one: operands 17 and 25.\r\nWorking notes, line two: exact sum.\r\n'
    raw = prose + json.dumps(verdict(MULTILINE_STEPS))
    quote = 'Working notes, line one: operands 17 and 25.\nWorking notes, line two: exact sum.'
    def runner_with(evidence_quote, risk_quote):
        def run(model, system, prompt, tag):
            if 'compare' in tag:
                report = assessed_comparison({'majority_answer': '42', 'majority_size': 2, 'majority_indices': [0, 1],
                    'adjudicated_matches_majority': True}, prompt)
                for a in report['independence_assessments']:
                    for e in a['evidence'].values(): e['source_span'] = evidence_quote
                report['method_risk_assessments'] = [{'indices': [0, 1], 'addresses_shared_failure': True, 'methods_distinct': True,
                    'risk': 'A shared operand-transcription error must be independently diagnosed by each lane.',
                    'method_analysis': 'Each lane restates the raw operands before summing, so a transcription slip is visible.',
                    'evidence': [{'index': i, 'source_span': risk_quote,
                                  'reason': 'The quoted notes show the operands restated from the raw input before the sum.'} for i in (0, 1)]}]
                return json.dumps(report)
            return raw
        return run
    assert quote not in raw
    assert verify(CLAIM, runner_with(quote, quote))['converged']
    row = verify({**CLAIM, 'requires_method_diversity': True}, runner_with(quote, quote))
    assert row['converged'] and row['method_risk_satisfied']
    row = verify({**CLAIM, 'requires_method_diversity': True}, runner_with(quote, quote.replace('line two', 'line  two')))
    assert not row['converged'] and not row['method_risk_satisfied']


def test_navigation_summary_alone_cannot_supply_derivation_quotes():
    # Without text outside the JSON object, the summary is outside the derivation body.
    summary_only = 'Navigation only'
    for axis in ('construction', 'applicability', 'diagnostic'):
        run = runner()
        def summary_quote(model, system, prompt, tag, axis=axis):
            text = run(model, system, prompt, tag)
            if 'compare' in tag:
                record = json.loads(text)
                for a in record['independence_assessments']: a['evidence'][axis]['source_span'] = summary_only
                return json.dumps(record)
            return text
        row = verify(CLAIM, summary_quote)
        assert not row['converged'] and row['independent_confirmations'] == 0, axis
    risk_run = runner(risk=True)
    def summary_risk(model, system, prompt, tag):
        text = risk_run(model, system, prompt, tag)
        if 'compare' in tag:
            record = json.loads(text)
            for e in record['method_risk_assessments'][0]['evidence']: e['source_span'] = summary_only
            return json.dumps(record)
        return text
    row = verify({**CLAIM, 'requires_method_diversity': True}, summary_risk)
    assert not row['converged'] and not row['method_risk_satisfied']


def _risk_with_span(span, bad, raw=None):
    run = prefixed_lane_runner({a: span for a in ('input', 'execution', 'construction', 'applicability', 'diagnostic')}, risk=True, raw=raw)
    def wrapped(model, system, prompt, tag):
        text = run(model, system, prompt, tag)
        if 'compare' in tag:
            record = json.loads(text)
            for e in record['method_risk_assessments'][0]['evidence']: e['source_span'] = bad
            return json.dumps(record)
        return text
    return wrapped


def test_structured_derivation_differing_from_original_output_cannot_supply_quotes():
    span = MULTILINE_STEPS.split('\n', 1)[1]
    raw = PREFIX + json.dumps(verdict(MULTILINE_STEPS))
    ds = [mb._execute_derivation(lambda *a: raw, 'claude/opus', mb._DERIVE_SYSTEM, 'neutral raw problem', f'fresh-{i}') for i in range(2)]
    run = prefixed_lane_runner({a: span for a in ('input', 'execution', 'construction', 'applicability', 'diagnostic')})
    cmp, _ = mb._compare(CLAIM, 'raw inputs', ds, ['host', 'host'], ['claude/opus'], run, tag='compare')
    assert mb.claim_status(cmp, ds, ['host', 'host'])[0]
    injected = 'Injected step absent from the original output.'
    for d in ds: d['derivation'] += '\n' + injected
    for a in cmp['independence_assessments']:
        for e in a['evidence'].values(): e['source_span'] = injected
    cmp['assessment_input_sha256'] = mb.hashlib.sha256(json.dumps(ds, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    assert not mb.claim_status(cmp, ds, ['host', 'host'])[0]


def test_stale_complete_lane_material_invalidates_bound_comparison():
    run = runner()
    ds = [mb._execute_derivation(run, 'claude/opus', mb._DERIVE_SYSTEM, 'neutral raw problem', f'fresh-{i}') for i in range(2)]
    cmp, _ = mb._compare(CLAIM, 'raw inputs', ds, ['host', 'host'], ['claude/opus'], run, tag='compare')
    assert mb.claim_status(cmp, ds, ['host', 'host'])[0]
    ds[1]['derivation'] += '\nChanged original step.'
    ds[1]['transport'] = transport_for('42', ds[1]['derivation'], ds[1]['execution_id'])
    assert not mb.claim_status(cmp, ds, ['host', 'host'])[0]
    assert not mb.decide_converged(cmp, ['host', 'host'], derivations=ds)


def test_symbolic_agreement_does_not_override_actual_adjudicator_veto():
    pytest.importorskip("sympy")  # the CAS verification path abstains without sympy
    run = runner()
    def veto(model, system, prompt, tag):
        result = run(model, system, prompt, tag)
        if 'compare' in tag:
            record = json.loads(result)
            record['adjudicated_matches_majority'] = False
            record['correct_answer_adjudicated'] = 'Independent re-evaluation disagrees with the supplied answer.'
            return json.dumps(record)
        return result
    row = verify(CLAIM, veto)
    assert row['verification'] == 'cas'
    assert not row['converged'] and row['independent_confirmations'] == 0


def test_non_symbolic_agreement_does_not_publish_vetoed_confirmations():
    run = runner()
    def veto(model, system, prompt, tag):
        result = json.loads(run(model, system, prompt, tag))
        if 'compare' in tag:
            result['adjudicated_matches_majority'] = False
        else:
            result['checkable_form'] = ''
        return json.dumps(result)
    row = verify(CLAIM, veto)
    assert row['verification'] == 'llm'
    assert not row['converged'] and row['independent_confirmations'] == 0
    assert row['cross_family_confirmations'] == 0


def test_same_actual_method_remains_refused_under_explicit_distinct_method_risk():
    run = runner(risk=True)
    def same_method(model, system, prompt, tag):
        result = run(model, system, prompt, tag)
        if 'compare' in tag:
            record = json.loads(result)
            # The examiner says risk diagnostics exist but actual mechanisms are still the same.
            record['method_risk_assessments'][0]['methods_distinct'] = False
            return json.dumps(record)
        return result
    row = verify({**CLAIM, 'requires_method_diversity': True}, same_method)
    assert not row['converged'] and not row['method_risk_satisfied']


def test_self_filled_external_native_transport_and_observation_flags_do_not_count():
    external = []
    for i in range(2):
        d = {**verdict(), 'family': 'host', 'execution_id': f'external-{i}', 'method': 'exact addition',
             'observed': True, 'runtime_observed': True, '_observation_authority': True,
             'transport': transport_for('42', SUMMARY, f'external-{i}')}
        d['transport'].update(artifact_refs=[], observation_origin='runtime', observed=True)
        external.append(d)
        parsed = mb.parse_native_derivation(d)
        assert parsed['transport'] is None
        assert 'observed' not in parsed and 'runtime_observed' not in parsed and '_observation_authority' not in parsed
    calls = []
    def no_actual_derivation(model, system, prompt, tag):
        calls.append(tag)
        return None
    row = mb.verify_claim({**CLAIM, 'native_derivations': external}, ctx='Neutral raw inputs only.', pool=[],
                         comparators=['claude/opus'], max_iter=0, run=no_actual_derivation)
    assert not row['converged'] and row['independent_confirmations'] == 0
    assert row['native_seeded'] == 0 and len(row['native_unavailable']) == 2
    assert row['independence_evidence']['accepted_evidence_indices'] == []


def test_serialized_runtime_observation_cannot_be_replayed_as_actual_invocation():
    ds = [mb._execute_derivation(runner(), 'claude/opus', 'Observed actual host callback',
                                'Neutral raw inputs, no answer.', f'live-{i}') for i in range(2)]
    aa = assessments(ds)
    cmp = {'majority_answer': ds[0]['canonical_answer'], 'majority_indices': [0,1], 'majority_size': 2, 'adjudicated_matches_majority': True, 'independence_assessments': aa}
    cmp['assessment_input_sha256'] = mb.hashlib.sha256(json.dumps(ds, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    assert mb.claim_status(cmp, ds, ['host','host'])[0]
    serialized = json.loads(json.dumps(ds))
    assert not mb.claim_status(cmp, serialized, ['host','host'])[0]


def test_self_reported_plain_transport_does_not_count_even_with_examiners_true_flags():
    ds = [{**verdict(), 'execution_id': f'author-{i}', 'transport': transport_for('42', SUMMARY, f'author-{i}')} for i in range(2)]
    aa = [{'index': i, 'input_independent': True, 'execution_independent': True, 'construction_independent': True,
           'method_applicable': True, 'diagnostic': True, 'unresolved_defects': [],
           'evidence': {k: {'source_span': SUMMARY, 'reason': 'Examiner assertion alone cannot invent an actual original invocation.'}
                        for k in ('input','execution','construction','applicability','diagnostic')}} for i in range(2)]
    cmp = {'majority_answer': ds[0]['canonical_answer'], 'majority_indices': [0,1], 'majority_size': 2, 'adjudicated_matches_majority': True, 'independence_assessments': aa}
    cmp['assessment_input_sha256'] = mb.hashlib.sha256(json.dumps(ds, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    assert not mb.claim_status(cmp, ds, ['host','host'])[0]


def source_anchor_runner(axis):
    source_run = runner()
    def run(model, system, prompt, tag):
        text = source_run(model, system, prompt, tag)
        if 'compare' in tag:
            record = json.loads(text)
            for assessment in record['independence_assessments']:
                assessment['evidence'][axis]['source_span'] = CLAIM['statement']
            return json.dumps(record)
        return text
    return run


def test_construction_applicability_diagnostic_cannot_anchor_only_request_metadata():
    for axis in ('construction','applicability','diagnostic'):
        row = verify(CLAIM, source_anchor_runner(axis))
        assert not row['converged'] and row['independent_confirmations'] == 0, axis


def test_input_execution_may_anchor_actual_full_transport():
    for axis in ('input','execution'):
        row = verify(CLAIM, source_anchor_runner(axis))
        assert row['converged'] and row['independent_confirmations'] == 2, axis


def test_method_risk_evidence_must_anchor_actual_derivation_bodies():
    source_run = runner(risk=True)
    def metadata_risk(model, system, prompt, tag):
        text = source_run(model, system, prompt, tag)
        if 'compare' in tag:
            record = json.loads(text)
            for e in record['method_risk_assessments'][0]['evidence']:
                e['source_span'] = CLAIM['statement']
            return json.dumps(record)
        return text
    row = verify({**CLAIM, 'requires_method_diversity': True}, metadata_risk)
    assert not row['converged'] and not row['method_risk_satisfied']


def test_each_actual_runner_call_uses_fresh_durable_directory(monkeypatch, tmp_path):
    from types import SimpleNamespace
    def invoke(cmd, **kwargs):
        out = Path(cmd[cmd.index('--backend-output') + 1].split('=', 1)[1])
        out.write_text(json.dumps(verdict()), encoding='utf-8')
        (out.parent / 'meta.json').write_text('{"current":true}', encoding='utf-8')
        return SimpleNamespace(returncode=0, stdout='', stderr='')
    monkeypatch.setattr(mb.subprocess, 'run', invoke)
    adapter = mb.MultiTaskRunner(runner_path=tmp_path / 'runner.py', work_dir=tmp_path, timeout=10, tools=False, config=None)
    first = mb._execute_derivation(adapter.run, 'claude/opus', 'neutral system', 'raw input', 'same-tag')
    first_dir = Path(first['transport']['invocation']['work_dir'])
    second = mb._execute_derivation(adapter.run, 'claude/opus', 'neutral system', 'raw input', 'same-tag')
    second_dir = Path(second['transport']['invocation']['work_dir'])
    assert first_dir != second_dir and first_dir.is_dir() and second_dir.is_dir()
    assert all(Path(ref['path']).is_file() for ref in first['transport']['artifact_refs'])
    assert any(Path(ref['path']).name == 'meta.json' for ref in second['transport']['artifact_refs'])
    assert mb.valid_derivation_transport(first) and mb.valid_derivation_transport(second)


def test_cli_default_records_persist_beside_requested_output(monkeypatch, tmp_path):
    claims = tmp_path / 'claims.json'
    claims.write_text('{"claims":[]}', encoding='utf-8')
    output = tmp_path / 'matrix.json'
    monkeypatch.setattr(mb, 'load_agents_file', lambda _: (None, 'none', None))
    monkeypatch.setattr(mb, '_resolve_runner', lambda _: tmp_path / 'runner.py')
    seen = []
    def gate(spec, **kwargs):
        work = kwargs['run'].__self__.work_dir
        work.joinpath('original-receipt.txt').write_text('unchanged invocation', encoding='utf-8')
        seen.append(work)
        return {'converged':0, 'total_claims':0}
    monkeypatch.setattr(mb, 'run_gate', gate)
    assert mb.main(['--claims', str(claims), '--out', str(output), '--backends', 'claude/opus']) == 0
    assert seen == [tmp_path / 'matrix.json.derivation-records']
    assert seen[0].joinpath('original-receipt.txt').read_text() == 'unchanged invocation'
    assert output.is_file()


def test_cas_cannot_publish_an_inconclusive_or_different_cluster():
    base = runner()
    for indices, answer in (([], '(no cluster)'), ([0], '7'), ([0, 1], '7')):
        def run(model, system, prompt, tag):
            raw = json.loads(base(model, system, prompt, tag))
            if 'compare' in tag:
                raw.update(majority_indices=indices, majority_size=len(indices), majority_answer=answer,
                    adjudicated_matches_majority=True)
            return json.dumps(raw)
        row = verify(CLAIM, run)
        assert not row['converged'] and row['independent_confirmations'] == 0


def test_two_eligible_confirmations_survive_third_uneligible_agreeing_candidate():
    run = runner()
    ds = [mb._execute_derivation(run, 'claude/opus', mb._DERIVE_SYSTEM, 'neutral raw problem', f'fresh-{i}') for i in range(3)]
    cmp, _ = mb._compare(CLAIM, 'raw inputs', ds, ['host'] * 3, ['claude/opus'], run, tag='compare')
    cmp.update(majority_indices=[0, 1, 2], majority_size=3)
    cmp['independence_assessments'][2]['construction_independent'] = False
    assert mb.claim_status(cmp, ds, ['host'] * 3)[0]
    assert cmp['accepted_indices'] == [0, 1]
    cmp['majority_size'] = 2
    assert not mb.claim_status(cmp, ds, ['host'] * 3)[0]


def test_source_eligible_candidates_are_not_published_as_accepted_after_risk_veto():
    row = verify({**CLAIM, 'requires_method_diversity': True}, runner(risk=False))
    assert not row['converged'] and row['independent_confirmations'] == 0
    assert row['independence_evidence']['accepted_evidence_indices'] == []
    assert row['source_eligible_indices'] == [0, 1]
