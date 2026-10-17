"""Read-coverage witnesses: a long lane counts only when every frozen byte was returned to the comparator.

The comparator is an offline stand-in that goes through the actual runtime capture observation: its
capture stream holds each Read call and the tool result returned to it, exactly where the Claude CLI
runner writes them. Mocked semantics are not scientific reviews.
"""
import hashlib
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

import pytest

from assessment_fixture import SUMMARY, assessments

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/run_multi_backend.py'
spec = importlib.util.spec_from_file_location('read_coverage_executor', SCRIPT)
mb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mb)
import read_coverage
import runtime_capture_observation as runtime
import run_multi_task
import test_full_derivation_transport as real_shape

CLAIM = {'id': 'neutral', 'statement': 'Compute the sum of raw integers 17 and 25.', 'report_format': 'integer'}
AXES = ('input', 'execution', 'construction', 'applicability', 'diagnostic')
FILES = 'FULL_DERIVATION_RECORDS_FILES:\n'
LONG_TOOL_OUTPUT = 'sample 000: residual of the rearranged identity is exactly zero\n' * 4000


def long_lanes(tmp_path, count=2):
    """Lanes shaped like real Claude live captures, each with a long tool output (about 260 kB) so that
    one lane's own material is larger than the default window."""
    raw = json.dumps(real_shape.verdict(real_shape.LONG_ORIGINAL))
    saved, real_shape.TOOL_OUTPUT = real_shape.TOOL_OUTPUT, LONG_TOOL_OUTPUT
    try:
        run = real_shape.LiveCapture(tmp_path / 'lanes', raw, tool=True)
        (tmp_path / 'lanes').mkdir()
        ds = [mb._execute_derivation(run, 'claude/opus', mb._DERIVE_SYSTEM, 'neutral raw problem', f'fresh-{i}') for i in range(count)]
    finally:
        real_shape.TOOL_OUTPUT = saved
    assert all(mb.valid_derivation_transport(d) for d in ds)
    return ds


def numbered(lines, start):
    return '\n'.join(f'{start + k}\t{line}' for k, line in enumerate(lines))


class ReadingComparator:
    """Writes each comparator request, its report and its live capture through the actual runtime
    capture observation. Frozen-file requests are answered after Read calls whose results return the
    files' numbered lines, as the Claude CLI Read tool does; `mutation` alters what the capture shows."""

    def __init__(self, root, mutation=None, budgets=None):
        self.root, self.mutation = root, mutation
        self.invocations, self.request_budgets, self.work_dir = {}, budgets or mb.request_budgets(), root / 'records'
        self.prompts = {}

    def __call__(self, spec, system, prompt, tag):
        return self._call(system, prompt, tag, None)

    def run_reading(self, spec, system, prompt, tag, material_dir):
        return self._call(system, prompt, tag, Path(material_dir))

    def _reply(self, prompt, entries):
        if 'independence_assessments' in prompt and 'Provide independence_assessments' in prompt:
            return {'independence_assessments': assessments(entries)}
        if 'Provide method_risk_assessments' in prompt:
            return {'method_risk_assessments': []}
        return {'majority_answer': '42', 'majority_size': 2, 'majority_indices': [0, 1], 'all_equivalent': True,
                'adjudicated_matches_majority': True, 'correct_answer_adjudicated': '42', 'outliers': 'none'}

    def _call(self, system, prompt, tag, material_dir):
        self.prompts[tag] = prompt
        d = self.root / 'calls' / tag.replace('/', '__'); d.mkdir(parents=True)
        events, entries, final_id = [], [], 'msg_final'
        usage = {'input_tokens': 3, 'cache_creation_input_tokens': 9000, 'cache_read_input_tokens': 60000, 'output_tokens': 40}

        def call(message_id, blocks, call_usage=usage):
            events.append({'type': 'stream_event', 'event': {'type': 'message_start', 'message': {'id': message_id, 'content': []}}})
            events.extend({'type': 'assistant', 'message': {'id': message_id, 'content': [b]}} for b in blocks)
            delta = {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use' if blocks[0]['type'] == 'tool_use' else 'end_turn'}, 'usage': call_usage}
            if self.mutation == 'context-edit' and message_id == final_id:
                delta['context_management'] = {'applied_edits': [{'type': 'clear_tool_uses', 'cleared_input_tokens': 9000}]}
            events.append({'type': 'stream_event', 'event': delta})
            events.append({'type': 'stream_event', 'event': {'type': 'message_stop'}})

        def tool_result(tool_id, content):
            events.append({'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': tool_id, 'content': content}]}})

        if material_dir is not None:
            parts = re.findall(r'^  (/\S+\.txt) \(sha256', prompt.split(FILES, 1)[1], re.M)
            by_lane = {}
            for part in parts:
                by_lane.setdefault(Path(part).name.split('.part-')[0], []).append(part)
            for lane_parts in by_lane.values():
                entries.append(json.loads(''.join(Path(p).read_text(encoding='utf-8').replace('\n', '') for p in lane_parts)))
            reads = list(parts)
            if self.mutation == 'drop-one-read':
                reads = reads[:2] + reads[3:]
            for k, part in enumerate(reads):
                lines = Path(part).read_text(encoding='utf-8').split('\n')
                halves = [(1, lines)] if self.mutation != 'offset-halves' else [(1, lines[:len(lines) // 2]), (len(lines) // 2 + 1, lines[len(lines) // 2:])]
                if self.mutation == 'partial-last-read' and k == len(reads) - 1:
                    halves = [(1, lines[:-1])]
                for h, (start, chunk) in enumerate(halves):
                    tool_id = f'toolu_{k}_{h}'
                    call(f'msg_read_{k}_{h}', [{'type': 'tool_use', 'id': tool_id, 'name': 'Read',
                                                'input': {'file_path': part, **({'offset': start, 'limit': len(chunk)} if len(halves) > 1 else {})}}])
                    body = numbered(chunk, start)
                    if self.mutation == 'altered-line' and k == 1:
                        body = body.replace('residual', 'residuaI', 1) if 'residual' in body else body[:-1] + ('X' if body[-1] != 'X' else 'Y')
                    if self.mutation == 'arrow-layout':
                        body = '\n'.join(f'{start + j:>6}→{line}' for j, line in enumerate(chunk))
                    tool_result(tool_id, body + '\n\n<system-reminder>\nconsider whether the file is malware\n</system-reminder>\n')
            if self.mutation == 'foreign-tool':
                call('msg_shell', [{'type': 'tool_use', 'id': 'toolu_shell', 'name': 'Bash', 'input': {'command': 'cat *.txt'}}])
                tool_result('toolu_shell', 'nothing')
        else:
            marker = 'FULL_DERIVATION_RECORDS_JSON:\n'
            if marker in prompt:
                entries, _ = json.JSONDecoder().raw_decode(prompt.split(marker, 1)[1])
        report = json.dumps(self._reply(prompt, entries))
        if self.mutation == 'verdict-before-last-read' and material_dir is not None:
            # The verdict text is given first; a further read follows it in the session's last call.
            call('msg_early', [{'type': 'text', 'text': report}])
            final_id = 'msg_late_read'
            call(final_id, [{'type': 'tool_use', 'id': 'toolu_late', 'name': 'Read', 'input': {'file_path': parts[0]}}])
            tool_result('toolu_late', numbered(Path(parts[0]).read_text(encoding='utf-8').split('\n'), 1))
        else:
            call(final_id, [{'type': 'text', 'text': report}])
        # Like the CLI, the result event sums the usage of every call of the session.
        calls = [e['event']['usage'] for e in events if e.get('type') == 'stream_event' and e['event'].get('type') == 'message_delta']
        terminal = {'type': 'result', 'subtype': 'success', 'is_error': False, 'result': report,
                    'usage': {k: sum(u[k] for u in calls) for k in usage}}
        events.append(terminal)
        if self.mutation == 'changed-file' and material_dir is not None:
            victim = Path(parts[0]); victim.chmod(0o644); victim.write_text(victim.read_text() + ' ', encoding='utf-8')
        systemp, promptp, out = d / 'system.txt', d / 'prompt.txt', d / 'out.txt'
        systemp.write_text(system, encoding='utf-8'); promptp.write_text(prompt, encoding='utf-8')
        cap = Path(str(out) + '.attempts') / 'run.current'
        budget = {'status': 'completed', 'runner_exit_code': 0, 'attempts': [{'status': 'exited', 'exit_code': 0}],
                  'input_sha256': [hashlib.sha256(t.encode()).hexdigest() for t in (system, prompt)]}
        stream = ''.join(json.dumps(e) + '\n' for e in events)
        writer = d / 'transport.py'
        writer.write_text('from pathlib import Path\n'
            + f'cap=Path({str(cap)!r});cap.mkdir(parents=True)\n'
            + f'Path({str(out)!r}).write_text({report!r})\n'
            + f'(cap/"budget.json").write_text({json.dumps(budget)!r})\n'
            + f'(cap/"attempt_1.events.jsonl").write_text({stream!r})\n'
            + f'(cap/"attempt_1.events.result.json").write_text({json.dumps(terminal)!r})\n', encoding='utf-8')
        cmd = [sys.executable, str(writer), '--system-prompt-file', str(systemp), '--prompt-file', str(promptp), '--out', str(out)]
        old = Path.cwd()
        try:
            if material_dir is not None:
                os.chdir(material_dir)  # the comparator's working directory is the frozen material
            process = run_multi_task._run_with_timeout(cmd, timeout_secs=10, context_tokens=self.request_budgets['context_tokens'])
        finally:
            os.chdir(old)
        (d / 'meta.json').write_text(json.dumps({'agents': [{'success': True, 'out': str(out), 'capture_receipt': str(cap / 'budget.json')}]}))
        self.invocations[tag] = {'exit_code': process['exit_code'], 'output': str(out)}
        return report


def compare(tmp_path, monkeypatch, mutation=None, ds=None):
    monkeypatch.setattr(runtime, '_authority_dir', lambda: tmp_path / 'host-authority')
    ds = ds or long_lanes(tmp_path)
    run = ReadingComparator(tmp_path, mutation)
    cmp, n_ok = mb._compare(CLAIM, 'Only raw inputs, no expected answer.', ds, ['host'] * len(ds), ['claude/opus'], run, tag='compare')
    return ds, cmp, n_ok, run


def lane_requests(cmp):
    return [r for r in cmp['request_capacity']['judges'][0]['requests'] if r['kind'] == 'lane']


def test_per_lane_requests_each_carry_one_complete_lane(tmp_path, monkeypatch):
    # Lanes small enough for one request travel inline, each in its own request, complete and alone;
    # the joint request carries canonical answers only.
    raw = json.dumps({'canonical_answer': '42', 'derivation': SUMMARY, 'checkable_form': '42', 'confidence': 'high'})
    ds = [mb._execute_derivation(lambda *a: raw, 'claude/offline', 'neutral', 'raw operands', f'small-{i}') for i in range(3)]
    ds_, cmp, n_ok, run = compare(tmp_path, monkeypatch, ds=ds)
    assert n_ok == 1 and mb.claim_status(cmp, ds, ['host'] * 3)[0]
    lanes = lane_requests(cmp)
    assert [r['lanes'] for r in lanes] == [[0], [1], [2]] and all(r['carried'] == 'inline' for r in lanes)
    for r in lanes:
        prompt = run.prompts[r['tag']]
        entries, _ = json.JSONDecoder().raw_decode(prompt.split('FULL_DERIVATION_RECORDS_JSON:\n', 1)[1])
        i = r['lanes'][0]
        expected = mb._lane_entry(ds[i], 'host', i)
        assert entries == [expected] and mb._encoded([expected]) in prompt
        assert all(ds[k]['execution_id'] not in prompt for k in range(3) if k != i)
    joint = run.prompts['compare_j0_claude']
    assert 'FULL_DERIVATION_RECORDS' not in joint and all(d['execution_id'] not in joint for d in ds)


def test_lane_larger_than_the_window_is_read_in_chunks_and_passes_only_with_full_coverage(tmp_path, monkeypatch):
    ds, cmp, n_ok, run = compare(tmp_path, monkeypatch)
    window = mb.request_budgets()['context_bytes']
    for i, d in enumerate(ds):
        inline = mb._assess_prompt('Only raw inputs, no expected answer.', CLAIM, mb._lane_entry(d, 'host', i))
        assert len(inline.encode('utf-8')) > window  # this lane alone does not fit one request
    assert n_ok == 1 and mb.claim_status(cmp, ds, ['host', 'host'])[0] and cmp['accepted_indices'] == [0, 1]
    for r in lane_requests(cmp):
        assert r['carried'] == 'files' and r['status'] == 'completed'
        files = r['read_coverage']['files']
        assert len(files) >= 3 and all(f['covered_bytes'] == f['size'] and not f['missing_byte_ranges'] for f in files)
        # Each model call of the reading session fits the window; their sum, which the result event
        # reports, does not, so the window is judged per call.
        calls = r['capacity']['observed_usage']
        assert len(calls) >= 4 and all(u['input_tokens'] + u['output_tokens'] <= mb.request_budgets()['context_tokens'] for u in calls)
        assert sum(u['input_tokens'] + u['output_tokens'] for u in calls) > mb.request_budgets()['context_tokens']
        assert r['capacity']['usage_scope'] == 'per_call'
        # The frozen parts, joined line by line, are exactly the lane entry an inline request would carry.
        i = r['lanes'][0]
        joined = ''.join(Path(f['path']).read_text(encoding='utf-8').replace('\n', '') for f in files)
        assert joined == mb._encoded(mb._lane_entry(ds[i], 'host', i))
        assert all(len(Path(f['path']).read_bytes()) <= read_coverage.PART_BYTES for f in files)
        assert all(not os.access(f['path'], os.W_OK) for f in files)
    # Reading a part in two offset/limit halves, or in the older numbered layout, covers it the same way.
    for mutation in ('offset-halves', 'arrow-layout'):
        sub = tmp_path / mutation; sub.mkdir()
        _, cmp2, n2, _ = compare(sub, monkeypatch, mutation, ds=long_lanes(sub))
        assert n2 == 1 and cmp2['majority_indices'] == [0, 1] and len(cmp2['independence_assessments']) == 2, mutation


REFUSED = {
    'drop-one-read': 'some bytes of the frozen material were never returned to the comparator',
    'partial-last-read': 'some bytes of the frozen material were never returned to the comparator',
    'altered-line': 'a returned line differs from the frozen bytes',
    'foreign-tool': 'comparator used tools outside the read-only set: Bash',
    'context-edit': 'earlier tool results were edited out of the comparator context',
    'verdict-before-last-read': 'the verdict was not given in a final message after the last read',
    'changed-file': 'frozen material changed',
}


@pytest.mark.parametrize('mutation', sorted(REFUSED))
def test_incomplete_or_unfaithful_reads_are_refused(tmp_path, monkeypatch, mutation):
    # Mutations of the comparator's capture: one dropped read, one read missing the last line, a
    # returned line differing from the frozen bytes, a non-read-only tool, a context edit removing
    # earlier results, a verdict given before the last read, frozen bytes changed after freezing.
    ds, cmp, n_ok, run = compare(tmp_path, monkeypatch, mutation)
    assert not mb.claim_status(cmp, ds, ['host', 'host'])[0] and cmp['accepted_indices'] == []
    lanes = lane_requests(cmp)
    assert all(r['status'] == 'unavailable' and r['reason'].startswith(read_coverage.NOT_READ) for r in lanes)
    assert all(REFUSED[mutation] in r['reason'] for r in lanes), [r['reason'] for r in lanes]
    assert cmp['independence_assessments'] == []
    if mutation in ('drop-one-read', 'partial-last-read'):
        missing = [m for r in lanes for f in r['read_coverage']['files'] for m in f['missing_byte_ranges']]
        assert missing and all(b > a for a, b in missing)


def test_a_runner_or_comparator_that_cannot_show_reads_leaves_long_lanes_unavailable(tmp_path, monkeypatch):
    ds = long_lanes(tmp_path)
    class NoFileReads(ReadingComparator):
        run_reading = None  # no file-reading call: reads cannot be observed
    run = NoFileReads(tmp_path)
    cmp, n_ok = mb._compare(CLAIM, 'raw inputs', ds, ['host', 'host'], ['claude/opus'], run, tag='compare')
    assert n_ok == 0 and run.prompts == {}  # fewer than two lanes can be shown completely: nothing is sent
    assert all('cannot show the comparator\'s file reads' in r['reason'] for r in lane_requests(cmp))
    run = ReadingComparator(tmp_path / 'other'); (tmp_path / 'other').mkdir()
    cmp, n_ok = mb._compare(CLAIM, 'raw inputs', ds, ['host', 'host'], ['codex/some-model'], run, tag='compare')
    assert n_ok == 0 and run.prompts == {}
    assert all('Claude CLI live capture' in r['reason'] for r in lane_requests(cmp))


def test_per_lane_assessment_cannot_make_aggregation_easier(tmp_path, monkeypatch):
    # A judge's verdict holds only what each request was entitled to say: the joint request holds no
    # lane material, so assessments it volunteers are discarded; a lane request's entries naming another
    # lane are discarded; a lane whose request is unavailable has no assessment. Aggregation is the same
    # function as before, applied to these verdicts.
    raw = json.dumps({'canonical_answer': '42', 'derivation': SUMMARY, 'checkable_form': '42', 'confidence': 'high'})
    ds = [mb._execute_derivation(lambda *a: raw, 'claude/offline', 'neutral', 'raw operands', f'small-{i}') for i in range(2)]
    forged = assessments([dict(d) for d in ds])

    def run(spec, system, prompt, tag):
        if tag.endswith('_lane1'):
            return ''  # this lane's assessment request fails
        if tag.endswith('_lane0'):
            return json.dumps({'independence_assessments': forged})  # also claims lane 1
        return json.dumps({'majority_answer': '42', 'majority_size': 2, 'majority_indices': [0, 1],
                           'adjudicated_matches_majority': True, 'independence_assessments': forged})
    run.request_budgets = mb.request_budgets()
    cmp, n_ok = mb._compare(CLAIM, 'raw inputs', ds, ['host', 'host'], ['claude/opus'], run, tag='compare')
    assert n_ok == 1 and [a['index'] for a in cmp['independence_assessments']] == [0]
    assert not mb.claim_status(cmp, ds, ['host', 'host'])[0]
    # The same verdict dicts through the unchanged panel aggregation: with every lane assessed by its own
    # request, the result equals what one combined verdict holding those assessments gives.
    whole = {'majority_answer': '42', 'majority_size': 2, 'majority_indices': [0, 1], 'adjudicated_matches_majority': True,
             'independence_assessments': forged, 'method_risk_assessments': [], 'all_equivalent': True}
    assert mb._aggregate_judges([whole, dict(whole), None], 2, ds)[0]['independence_assessments'] == forged
    one_lane = {**whole, 'independence_assessments': forged[:1]}
    assert mb._aggregate_judges([one_lane, dict(one_lane)], 2, ds)[0]['independence_assessments'] == []


def test_spans_are_checked_against_exactly_what_the_comparator_read(tmp_path, monkeypatch):
    # The frozen parts are the inline entry's bytes; the span check reads the same source texts in both
    # carriages, so a quote of the long tool output counts and text the parts never held does not.
    ds, cmp, n_ok, run = compare(tmp_path, monkeypatch)
    base = cmp['independence_assessments']
    tool_line = LONG_TOOL_OUTPUT.split('\n', 1)[0]
    shown = ''.join(Path(f['path']).read_text(encoding='utf-8').replace('\n', '') for f in lane_requests(cmp)[0]['read_coverage']['files'])
    assert json.dumps(tool_line, ensure_ascii=False)[1:-1] in shown
    for span, ok in ((tool_line, True), ('Original step 150: preserve this exact evidence.', True), ('text the parts never held', False)):
        aa = json.loads(json.dumps(base))
        for a in aa:
            a['evidence']['input']['source_span'] = span
            a['evidence']['execution']['source_span'] = span
        assert (mb.assessed_indices(ds, aa) == [0, 1]) is ok, span
