#!/usr/bin/env python3
"""Check bound, mechanical literature evidence coverage after workflow execution.

This check establishes file availability, declared coverage and structural
contracts. It does not establish that sources were understood or claims are true.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path


IDENTITY_FIELDS = ('check_id', 'run_id', 'workflow_id', 'plan_sha256', 'outputs_sha256')


def project_path(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or value.startswith('/') or '\\' in value:
        raise ValueError(f'{label} must be a project-relative path')
    if any(part in {'', '.', '..'} for part in value.split('/')):
        raise ValueError(f'{label} must be canonical and stay inside the project')
    return value


def evaluate(envelope: dict) -> dict:
    result = {'schema_version': 1, **{key: envelope.get(key, '') for key in IDENTITY_FIELDS},
              'status': 'unavailable', 'summary': '', 'findings': [], 'inputs': []}
    tracker = None
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'lib'))
        from workflow_literature_reads import ObservedProjectReads, ObservedNote, EvidenceMissing, EvidenceInvalid, require_matching_candidate_pool
        from literature_artifact_refs import observed_project_reads
        from literature_identity_keys import canonicalize_stable_locator
        from literature_identity_provenance import _load_citation_contract
        from check_literature_trace import _validate_saturation, _count_nonempty_rows
        from check_knowledge_layers import _validate_literature_note, _extract_bullet_field

        if envelope.get('schema_version') != 1 or not all(isinstance(envelope.get(k), str) and envelope[k] for k in IDENTITY_FIELDS):
            raise RuntimeError('malformed workflow acceptance request identity')
        requirements = envelope.get('requirements')
        if not isinstance(requirements, dict):
            raise RuntimeError('missing literature acceptance requirements')
        if requirements.get('workflow_binding_required') is not True or requirements.get('source_first_reading_required') is not True:
            raise RuntimeError('required literature binding policy is unavailable')
        providers = requirements.get('providers_expected')
        if not isinstance(providers, list) or set(providers) != {'inspire', 'arxiv', 'openalex', 'web'} or len(providers) != 4:
            raise RuntimeError('malformed expected literature provider requirements')
        if _load_citation_contract() is None:
            raise RuntimeError('citation-triangulation checker dependency is unavailable')
        tracker = ObservedProjectReads(Path(envelope['project_root']))
        errors: list[str] = []
        missing: list[str] = []
        trace_path = project_path(requirements.get('trace_path'), 'trace_path')
        saturation_path = project_path(requirements.get('saturation_path'), 'saturation_path')
        trace = tracker.read(trace_path).decode('utf-8')
        if _count_nonempty_rows(trace, path=tracker.root / trace_path)[0] < 1:
            missing.append('literature trace has no recorded query rows')
        saturation = json.loads(tracker.read(saturation_path))
        if not isinstance(saturation, dict):
            raise EvidenceInvalid('literature saturation must be a JSON object')
        if saturation.get('run_id') != envelope['run_id']:
            errors.append('saturation.run_id does not match the workflow execution')
        binding = {key: envelope[key] for key in ('workflow_id', 'plan_sha256', 'outputs_sha256')}
        if saturation.get('workflow_binding') != binding:
            errors.append('saturation.workflow_binding must match current workflow, plan and outputs digests')
        if saturation.get('final_status') != 'saturated':
            missing.append('literature coverage is not saturated')
        recorded_providers = saturation.get('providers')
        if not isinstance(recorded_providers, dict):
            errors.append('providers must be an object')
        else:
            for provider in providers:
                if provider not in recorded_providers:
                    missing.append(f'required provider coverage entry is missing: {provider}')
        with observed_project_reads(tracker.read):
            errors.extend(_validate_saturation(saturation, project_root=tracker.root,
                          require_reading_evidence=True, project_stage='development'))
        pool = saturation.get('candidate_pool')
        if not isinstance(pool, dict):
            raise EvidenceInvalid('candidate_pool must be an object')
        artifact = project_path(pool.get('artifact'), 'candidate_pool.artifact')
        archive = tracker.read(artifact)
        if not archive.strip():
            missing.append('candidate pool artifact is empty')
        else:
            require_matching_candidate_pool(archive, pool.get('candidates'))
        core = pool.get('selected_core_ids')
        if not isinstance(core, list) or not core or not all(isinstance(p, str) and p for p in core):
            errors.append('selected_core_ids must identify non-empty core papers')
            core = []
        reading = saturation.get('source_first_reading')
        entries = reading.get('notes') if isinstance(reading, dict) else None
        if not isinstance(entries, list):
            missing.append('source_first_reading.notes must contain bound note/source entries')
            entries = []
        covered: set[str] = set()
        note_owners: dict[str, str] = {}
        candidates = {item['id']: item for item in pool.get('candidates', [])
                      if isinstance(item, dict) and isinstance(item.get('id'), str)}
        for index, entry in enumerate(entries):
            label = f'source_first_reading.notes[{index}]'
            if not isinstance(entry, dict) or not isinstance(entry.get('paper_id'), str) or not entry['paper_id']:
                errors.append(f'{label} must bind paper_id, note_path, source_path and source_sha256')
                continue
            paper = entry['paper_id']
            if paper in covered:
                errors.append(f'duplicate reading evidence for {paper}')
                continue
            note_path = project_path(entry.get('note_path'), f'{label}.note_path')
            source_path = project_path(entry.get('source_path'), f'{label}.source_path')
            if note_path in note_owners and note_owners[note_path] != paper:
                errors.append(f'{label}: one note_path cannot identify different papers')
            note_owners[note_path] = paper
            digest = entry.get('source_sha256')
            if not isinstance(digest, str) or not re.fullmatch(r'(?:sha256:)?[0-9a-f]{64}', digest):
                errors.append(f'{label}.source_sha256 must pin exact full-text source bytes')
                continue
            source = tracker.read(source_path)
            if not source.strip():
                missing.append(f'{label}: original full-text source is empty')
            if hashlib.sha256(source).hexdigest() != digest.removeprefix('sha256:'):
                errors.append(f'{label}: source_sha256 does not match original source bytes')
            note = tracker.read(note_path)
            errors.extend(_validate_literature_note(ObservedNote(note_path, note), require_reading_evidence=True))
            head = '\n'.join(note.decode('utf-8').splitlines()[:200])
            note_ids = re.findall(r'^[ \t]*Paper ID:[ \t]*(.*)$', head, flags=re.MULTILINE | re.IGNORECASE)
            candidate_identity = candidates.get(paper, {}).get('canonical_identity', {})
            # _validate_saturation above verifies the archived provenance for all
            # canonical IDs and aliases before any acceptance can be passed.
            if not isinstance(candidate_identity, dict):
                candidate_identity = {}
            aliases = candidate_identity.get('aliases', [])
            aliases = aliases if isinstance(aliases, list) else []
            keys = {canonicalize_stable_locator(value) for value in
                    [candidate_identity.get('canonical_id'), *aliases]}
            keys.discard(None)
            if len(note_ids) != 1 or canonicalize_stable_locator(note_ids[0]) not in keys:
                errors.append(f'{label}: note must declare one Paper ID matching the candidate canonical identity or validated alias')
            source_form = (_extract_bullet_field(head, 'Source form actually read') or '').lower()
            if source_form not in {'latex_source', 'full_text_pdf', 'available_full_text'}:
                errors.append(f'{label}: source-first reading requires original full text, got {source_form!r}')
            if note_path == source_path:
                errors.append(f'{label}: reading note cannot substitute for original full-text source')
            covered.add(paper)
        for paper in sorted(set(core) - covered):
            missing.append(f'selected core paper has no source-first reading evidence: {paper}')
        result['inputs'] = tracker.finish()
        result['findings'] = errors + missing
        result['status'] = 'failed' if errors else ('incomplete' if missing else 'passed')
    except Exception as exc:
        # Imports/runtime problems are unavailable; evidence errors retain their
        # distinction. No config/exploration switch can turn a refusal into pass.
        name = type(exc).__name__
        result['status'] = ('incomplete' if name == 'EvidenceMissing' else
                            'failed' if name in {'EvidenceInvalid', 'ValueError', 'JSONDecodeError', 'UnicodeDecodeError'} else 'unavailable')
        result['findings'].append(str(exc))
        if tracker is not None:
            result['inputs'] = [{'path': p, 'sha256': d} for p, (d, _) in sorted(tracker.observed.items())]
    result['summary'] = ('Mechanical literature evidence coverage passed; semantic/scientific review remains separate.'
                         if result['status'] == 'passed' else f"Literature evidence coverage {result['status']}.")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        envelope = json.loads(args.request.read_bytes())
        if not isinstance(envelope, dict):
            envelope = {}
        result = evaluate(envelope)
    except Exception as exc:
        result = {'schema_version': 1, **{k: '' for k in IDENTITY_FIELDS}, 'status': 'unavailable',
                  'summary': 'Literature checker request unavailable.', 'findings': [str(exc)], 'inputs': []}
    temporary = args.output.with_name(args.output.name + f'.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, args.output)
    return 0 if result['status'] == 'passed' else (2 if result['status'] == 'unavailable' else 1)


if __name__ == '__main__':
    raise SystemExit(main())
