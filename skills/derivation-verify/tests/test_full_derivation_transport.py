"""Protocol witnesses for actual gate consumers; mocked semantics are not scientific reviews."""
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
    # (159,040 bytes) without truncation on this capture-free path; the packet copy count is
    # pinned below, and the live-capture path (stream records repeat the output) separately.
    assert verify(CLAIM, run)['converged']
    packet, _ = json.JSONDecoder().raw_decode(seen[0].split('FULL_DERIVATION_RECORDS_JSON:\n', 1)[1])
    assert len(seen[0].encode('utf-8')) <= mb.request_budgets()['context_bytes']  # fits the default window
    assert all(d['derivation'] == original for d in packet)
    assert all(CLAIM['statement'] in d['transport']['request']['prompt'] for d in packet)
    assert all(json.loads(d['transport']['raw_output'])['derivation'] == original for d in packet)


ANCHOR = 'UNIQUE_FINAL_SOURCE_ANCHOR'
LONG_ORIGINAL = 'Begin complete derivation.\n' + '\n'.join(f'Original step {i}: preserve this exact evidence.' for i in range(300)) + '\n' + ANCHOR


def packet_for(raw, lanes=2):
    ds = [mb._execute_derivation(lambda *a: raw, 'claude/opus', mb._DERIVE_SYSTEM, 'neutral raw problem', f'fresh-{i}') for i in range(lanes)]
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
    # Two complete 300-step lanes (14.6 kB each) fit the default window; before this pin the same
    # fixture produced six copies per record and a 190 kB request, refused rather than truncated.
    assert len(prompt.encode('utf-8')) <= mb.request_budgets()['context_bytes']
    # With additional assistant text the complete original output is added once as derivation_context,
    # which is the only extra copy; original_assistant_output stays out (it equals transport.raw_output).
    raw = 'An earlier original premise and necessary step.\n' + json.dumps(verdict(LONG_ORIGINAL))
    ds, prompt, packet = packet_for(raw)
    assert all(mb.valid_derivation_transport(d) for d in ds)
    for record in packet:
        assert copies_per_field(record) == {'derivation': 1, 'derivation_context': 1, 'transport': 1}
        assert record['derivation_context'] == raw == record['transport']['raw_output']
        assert record['additional_assistant_text_present'] is True
        assert 'assessment_source' not in record and 'original_assistant_output' not in record
    assert prompt.count(ANCHOR) == 3 * len(packet)


def test_packet_assembly_adds_no_copy_beyond_captured_records(tmp_path):
    # With live capture on, transport.captured_records carry the stream files verbatim (assistant
    # snapshot, text deltas, result event and its sidecar), so the output is repeated as emitted.
    # Packet assembly must add nothing beyond derivation and transport.raw_output to those copies.
    raw = json.dumps(verdict(LONG_ORIGINAL))
    class Captured:
        def __init__(self):
            self.invocations = {}
        def __call__(self, spec, system, prompt, tag):
            d = tmp_path / tag; d.mkdir()
            out = d / 'out.txt'; out.write_text(raw, encoding='utf-8')
            capture = Path(str(out) + '.attempts') / 'run.current'; capture.mkdir(parents=True)
            events = [{'type': 'stream_event', 'event': {'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': raw[:80]}}},
                      {'type': 'assistant', 'message': {'id': 'm1', 'content': [{'type': 'text', 'text': raw}]}},
                      {'type': 'result', 'subtype': 'success', 'is_error': False, 'result': raw}]
            (capture / 'attempt_1.events.jsonl').write_text('\n'.join(json.dumps(e) for e in events) + '\n', encoding='utf-8')
            (capture / 'attempt_1.events.result.json').write_text(json.dumps(events[-1]), encoding='utf-8')
            self.invocations[tag] = {'exit_code': 0, 'output': str(out)}
            return raw
    run = Captured()
    ds = [mb._execute_derivation(run, 'claude/opus', mb._DERIVE_SYSTEM, 'neutral raw problem', f'captured-{i}') for i in range(2)]
    assert all(mb.valid_derivation_transport(d) for d in ds)
    prompt = mb._compare_prompt('Only raw inputs, no expected answer.', CLAIM, ds, ['host'] * 2)
    packet, _ = json.JSONDecoder().raw_decode(prompt.split('FULL_DERIVATION_RECORDS_JSON:\n', 1)[1])
    for record, d in zip(packet, ds):
        captured = d['transport']['captured_records']
        assert len(captured) == 2 and all(Path(p).name.startswith('attempt_1.events') for p in captured)
        in_captured = sum(text.count(ANCHOR) for text in captured.values())
        assert in_captured == 3  # snapshot, result event, result sidecar (the delta holds only a prefix)
        assert record['transport']['captured_records'] == captured  # verbatim, not rewritten
        assert copies_per_field(record) == {'derivation': 1, 'transport': 1 + in_captured}
        assert not {'assessment_source', 'original_assistant_output', 'derivation_context'} & set(record)
    assert prompt.count(ANCHOR) == len(packet) * (2 + 3)
    # Measured with this minimal capture: about 166 kB for two 14.6 kB lanes (the exact figure
    # depends on the temporary path lengths inside captured_records), above the default
    # 159,040-byte window; about 399 kB with twelve copies per record before this change.
    # Fitting the live-capture path needs a decision on how captured records travel; not asserted.


def test_input_execution_spans_match_packet_transport_encoding_and_decoded_values():
    # The packet encodes transport with sorted keys; a span copied from that encoding, from a decoded
    # transport value, or from the summary is found, while construction still needs the body itself.
    # The summary carries a quote and a newline, so it is JSON-escaped inside raw_output and can
    # only match through the derivation_summary source itself.
    summary = 'Navigation "only"\nsecond line'
    raw = 'Premise line with "quotes" and a tab\t.\n' + json.dumps({**verdict(SUMMARY), 'derivation_summary': summary})
    ds, prompt, packet = packet_for(raw)
    encoded = prompt.split('FULL_DERIVATION_RECORDS_JSON:\n', 1)[1]
    assert json.dumps(ds[0]['transport'], ensure_ascii=False, sort_keys=True) in encoded
    escaped = json.dumps(raw, ensure_ascii=False)[1:-1]  # raw_output exactly as the packet shows it
    assert escaped != raw and escaped in encoded
    base = assessments(ds)
    for span, ok in ((escaped, True), (raw, True), ('neutral raw problem', True), (summary, True), ('not in any lane material', False)):
        aa = json.loads(json.dumps(base))
        for a in aa:
            a['evidence']['input']['source_span'] = span
            a['evidence']['execution']['source_span'] = span
        assert (mb.assessed_indices(ds, aa) == [0, 1]) is ok, span
    aa = json.loads(json.dumps(base))
    for a in aa:
        a['evidence']['construction']['source_span'] = 'neutral raw problem'
    assert mb.assessed_indices(ds, aa) == []


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
