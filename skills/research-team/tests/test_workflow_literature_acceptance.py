"""Adversarial workflow adapter checks using only synthetic exact-byte inputs."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
GATE = ROOT / 'skills/research-team/scripts/gates/check_workflow_literature.py'
sys.path.insert(0, str(Path(__file__).parent))
from test_literature_trace_gate import _write_project, _write_trace, _write_saturation, _saturated_doc
from test_knowledge_layers_gate import _reading_ready_note


def fixture(root: Path) -> dict:
    root = root.resolve()
    _write_project(root, stage='exploration')
    _write_trace(root)
    # Disabled project flags must not bypass an explicitly required workflow check.
    (root / 'research_team_config.json').write_text(json.dumps({'features': {'literature_trace_gate': False}}))
    data = _saturated_doc()
    data['workflow_binding'] = {'workflow_id': 'literature_gap_analysis', 'plan_sha256': 'a' * 64,
                                'outputs_sha256': 'b' * 64}
    source = root / 'sources/original.tex'
    source.parent.mkdir()
    source.write_text('\\section{Method}\nA full-text source fixture.\n')
    note = root / 'knowledge_base/literature/core.md'
    note.parent.mkdir()
    note.write_text('Paper ID: provider:catalog:core-1\n' + _reading_ready_note().replace('full_text_pdf', 'latex_source'))
    data['source_first_reading']['notes'] = [{'paper_id': 'provider:catalog:core-1',
        'note_path': note.relative_to(root).as_posix(), 'source_path': source.relative_to(root).as_posix(),
        'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest()}]
    _write_saturation(root, data)
    pool = root / data['candidate_pool']['artifact']
    pool.parent.mkdir(parents=True, exist_ok=True)
    pool.write_text(json.dumps(data['candidate_pool']['candidates']) + '\n')
    return data


def run(root: Path) -> tuple[subprocess.CompletedProcess, dict]:
    request = {'schema_version': 1, 'project_root': str(root.resolve()), 'run_id': 'RUN-1',
        'workflow_id': 'literature_gap_analysis', 'plan_sha256': 'a' * 64, 'outputs_sha256': 'b' * 64,
        'check_id': 'literature_evidence_coverage', 'requirements': {
            'saturation_path': 'knowledge_base/methodology_traces/literature_saturation.json',
            'trace_path': 'knowledge_base/methodology_traces/literature_queries.md',
            'providers_expected': ['inspire', 'arxiv', 'openalex', 'web'],
            'workflow_binding_required': True, 'source_first_reading_required': True}}
    req = root / 'request.json'
    output = root / 'result.json'
    req.write_text(json.dumps(request))
    proc = subprocess.run([sys.executable, str(GATE), '--request', str(req), '--output', str(output)],
                          capture_output=True, text=True)
    return proc, json.loads(output.read_text())


def save(root: Path, data: dict) -> None:
    (root / 'knowledge_base/methodology_traces/literature_saturation.json').write_text(json.dumps(data))


def test_complete_coverage_binds_all_nested_reads_and_ignores_skip_flags(tmp_path: Path):
    fixture(tmp_path)
    proc, result = run(tmp_path)
    assert proc.returncode == 0, result
    assert result['status'] == 'passed'
    assert 'semantic/scientific review remains separate' in result['summary']
    inputs = {item['path']: item['sha256'] for item in result['inputs']}
    expected = {'knowledge_base/methodology_traces/literature_saturation.json',
        'knowledge_base/methodology_traces/literature_queries.md', 'artifacts/literature/candidates.jsonl',
        'artifacts/identity/candidate-0.json', 'artifacts/identity/candidate-1.json',
        'artifacts/literature/catalog-core-1-bibliography.json', 'knowledge_base/literature/core.md',
        'sources/original.tex'}
    assert set(inputs) == expected
    assert all(hashlib.sha256((tmp_path / path).read_bytes()).hexdigest() == digest for path, digest in inputs.items())
    assert result['plan_sha256'] == 'a' * 64 and result['outputs_sha256'] == 'b' * 64


@pytest.mark.parametrize('change', ['binding', 'source_pin', 'abstract_only', 'unavailable', 'other', 'provider', 'coverage', 'core', 'empty_pool', 'legacy_notes'])
def test_refuses_incomplete_or_contradictory_evidence(tmp_path: Path, change: str):
    data = fixture(tmp_path)
    if change == 'binding': data['workflow_binding']['outputs_sha256'] = 'c' * 64
    elif change == 'source_pin': data['source_first_reading']['notes'][0]['source_sha256'] = 'c' * 64
    elif change in {'abstract_only', 'unavailable', 'other'}:
        note = tmp_path / 'knowledge_base/literature/core.md'
        note.write_text(note.read_text().replace('latex_source', change))
    elif change == 'provider': del data['providers']['web']
    elif change == 'coverage': data['final_status'] = 'coverage_incomplete'
    elif change == 'core': data['source_first_reading']['notes'] = []
    elif change == 'empty_pool': (tmp_path / data['candidate_pool']['artifact']).write_bytes(b'')
    elif change == 'legacy_notes': data['source_first_reading']['notes'] = ['knowledge_base/literature/core.md']
    save(tmp_path, data)
    proc, result = run(tmp_path)
    assert proc.returncode == 1, result
    assert result['status'] in {'failed', 'incomplete'}


@pytest.mark.parametrize('target', ['sources/original.tex', 'artifacts/identity/candidate-0.json',
    'artifacts/literature/catalog-core-1-bibliography.json'])
def test_missing_nested_inputs_are_incomplete(tmp_path: Path, target: str):
    fixture(tmp_path)
    (tmp_path / target).unlink()
    proc, result = run(tmp_path)
    assert proc.returncode == 1
    assert result['status'] == 'incomplete', result


@pytest.mark.parametrize('target', ['sources/original.tex', 'artifacts/identity/candidate-0.json'])
def test_symlink_aliases_cannot_satisfy_byte_binding(tmp_path: Path, target: str):
    fixture(tmp_path)
    path = tmp_path / target
    actual = path.with_name('actual-' + path.name)
    path.rename(actual)
    path.symlink_to(actual.name)
    proc, result = run(tmp_path)
    assert proc.returncode == 1 and result['status'] == 'failed', result


def test_observed_reads_reject_replacement_and_reset_context(tmp_path: Path):
    sys.path.insert(0, str(ROOT / 'skills/research-team/scripts/lib'))
    from workflow_literature_reads import ObservedProjectReads, EvidenceInvalid
    from literature_artifact_refs import observed_project_reads, resolve_pinned_project_json
    path = tmp_path / 'data.json'
    path.write_text('{}')
    tracker = ObservedProjectReads(tmp_path.resolve())
    tracker.read(path)
    replacement = tmp_path / 'replacement.json'
    replacement.write_text('{}')
    replacement.replace(path)
    with pytest.raises(EvidenceInvalid): tracker.finish()
    ref = f'project://data.json#sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}'
    with pytest.raises(RuntimeError):
        with observed_project_reads(lambda _: (_ for _ in ()).throw(RuntimeError('observer'))):
            resolve_pinned_project_json(ref, tmp_path, 'record', [])
    errors = []
    assert resolve_pinned_project_json(ref, tmp_path, 'record', errors)[0] == {}
    assert errors == []


def test_missing_source_form_is_failed_not_a_runtime_outage(tmp_path: Path):
    fixture(tmp_path)
    note = tmp_path / 'knowledge_base/literature/core.md'
    note.write_text(note.read_text().replace('- Source form actually read: latex_source\n', ''))
    proc, result = run(tmp_path)
    assert proc.returncode == 1 and result['status'] == 'failed', result


def test_missing_citation_runtime_is_unavailable_even_with_evidence(tmp_path: Path, monkeypatch):
    fixture(tmp_path)
    run(tmp_path)
    sys.path.insert(0, str(GATE.parent))
    import check_workflow_literature
    import literature_identity_provenance
    monkeypatch.setattr(literature_identity_provenance, '_load_citation_contract', lambda: None)
    request = json.loads((tmp_path / 'request.json').read_text())
    result = check_workflow_literature.evaluate(request)
    assert result['status'] == 'unavailable'
    assert 'dependency is unavailable' in result['findings'][0]


@pytest.mark.parametrize('paper_id', ['', 'provider:catalog:unrelated', 'not-a-stable-locator'])
def test_note_identity_is_intrinsic_not_entry_label(tmp_path: Path, paper_id: str):
    fixture(tmp_path)
    note = tmp_path / 'knowledge_base/literature/core.md'
    text = note.read_text()
    text = text.replace('Paper ID: provider:catalog:core-1\n', f'Paper ID: {paper_id}\n' if paper_id else '')
    note.write_text(text)
    proc, result = run(tmp_path)
    assert proc.returncode == 1 and result['status'] == 'failed', result
    assert any('Paper ID' in item for item in result['findings'])


def test_note_identity_accepts_provenance_validated_alias(tmp_path: Path):
    fixture(tmp_path)
    note = tmp_path / 'knowledge_base/literature/core.md'
    note.write_text(note.read_text().replace('Paper ID: provider:catalog:core-1', 'Paper ID: provider:registry:record-1'))
    proc, result = run(tmp_path)
    assert proc.returncode == 0 and result['status'] == 'passed', result


def test_one_note_path_cannot_be_relabelled_for_another_paper(tmp_path: Path):
    data = fixture(tmp_path)
    second = dict(data['source_first_reading']['notes'][0], paper_id='doi:10.1000/example')
    data['source_first_reading']['notes'].append(second)
    save(tmp_path, data)
    proc, result = run(tmp_path)
    assert proc.returncode == 1 and result['status'] == 'failed', result
    assert any('one note_path' in item for item in result['findings'])


@pytest.mark.parametrize('change', ['unrelated', 'missing', 'extra', 'duplicate', 'malformed', 'mismatched_field', 'object_wrapper'])
def test_candidate_archive_must_equal_inline_ledger(tmp_path: Path, change: str):
    data = fixture(tmp_path)
    pool = tmp_path / data['candidate_pool']['artifact']
    records = json.loads(pool.read_text())
    if change == 'unrelated': records = [{'id': 'provider:catalog:unrelated'}]
    elif change == 'missing': records.pop()
    elif change == 'extra': records.append({'id': 'provider:catalog:extra'})
    elif change == 'duplicate': records.append(records[0])
    elif change == 'mismatched_field': records[0]['rationale'] = 'unrelated disposition rationale'
    elif change == 'object_wrapper': records = {'candidates': records}
    pool.write_text('arbitrary nonempty data' if change == 'malformed' else json.dumps(records))
    proc, result = run(tmp_path)
    assert proc.returncode == 1 and result['status'] == 'failed', result


def test_candidate_archive_accepts_jsonl_and_semantic_object_order(tmp_path: Path):
    data = fixture(tmp_path)
    pool = tmp_path / data['candidate_pool']['artifact']
    records = json.loads(pool.read_text())
    pool.write_text('\n'.join(json.dumps(dict(reversed(list(item.items())))) for item in reversed(records)) + '\n')
    proc, result = run(tmp_path)
    assert proc.returncode == 0 and result['status'] == 'passed', result


@pytest.mark.parametrize('payload', ['[{"id":"one","id":"two"}]', '[{"id":"one","value":NaN}]'])
def test_candidate_archive_rejects_ambiguous_or_non_json_values(tmp_path: Path, payload: str):
    data = fixture(tmp_path)
    (tmp_path / data['candidate_pool']['artifact']).write_text(payload)
    proc, result = run(tmp_path)
    assert proc.returncode == 1 and result['status'] == 'failed', result
