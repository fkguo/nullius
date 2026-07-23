/** Python authority anchors for the literature coverage anti-drift lock. */

export const literatureCoveragePythonAnchors = [
  ['skills/research-team/scripts/lib/literature_identity.py', [
    'validate_canonical_identity', 'provider:<namespace>:<record>', 'archived_keys',
    'Display URLs never join identities',
  ]],
  ['skills/research-team/scripts/lib/literature_identity_keys.py', [
    'canonicalize_stable_locator', 'normalize_doi', 'PROVIDER_ID_RE',
  ]],
  ['skills/research-team/scripts/lib/literature_artifact_refs.py', [
    'resolve_pinned_project_json', 'must be project://<project-relative path>#sha256',
    'pin does not match exact artifact bytes',
  ]],
  ['skills/research-team/scripts/lib/literature_identity_provenance.py', [
    'citation-triangulation provider blocks', 'does not establish canonical identity aliases',
    'Return every archived DOI/provider key only when validation succeeds', '_record_keys',
  ]],
  ['skills/research-team/scripts/lib/literature_coverage.py', [
    'validate_bounded_provider_accounting', 'execution_bounds.max_requests',
    'request_log must record each bounded page or cursor request',
    'request_log returned counts must sum to returned_count',
    'every declared query must have request_log coverage', "must end with continuation='exhausted'",
    'known total_count must be fully returned before saturation',
  ]],
  ['skills/research-team/scripts/gates/check_literature_trace.py', [
    '_validate_candidate_ledger', '_validate_bibliography_reconciliation',
    '_validate_method_family_audit', 'unresolved identity must remain disposition',
    'merge aliases into one normalized candidate record', 'canonical_identity',
    'references_artifact_ref', 'identity.title does not match canonical candidate metadata',
    'bibliography_candidate_screening', 'not completion evidence',
    'core-disposition candidate(s) absent from selected_core_ids',
    'must describe the method, not only title/year metadata',
    'references_extracted must equal the raw references manifest count',
    'bibliography discovery claims do not match the pinned raw manifest',
    'bibliography discovery source_id', 'raw_text is required',
    "evidence_basis must be 'source_text'", 'validate_bounded_provider_accounting',
    'method_features must record at least one', "must be true when final_status='saturated'",
  ]],
  ['skills/research-team/scripts/bin/generate_demo_milestone.py', [
    '"demo:method-note"', '"references_checked": True', '"citations_checked": True',
    '"evidence_basis": "source_text"', 'demo_source_identity.json',
  ]],
  ['skills/research-team/scripts/bin/literature_fetch.py', [
    '--max-requests', '--max-records', '--request-log-json',
    'queried provider coverage requires positive',
  ]],
  ['skills/idea-posterior/scripts/validate_close_prior_gate.py', [
    '_validate_coverage_closure', '_is_nonnegative_int',
    'saturated survey requires bibliography_reconciliation.status=reconciled',
    'saturated survey requires method_family_audit.status=audited',
    'source-text method evidence for every audited core source',
    'validate_bound_coverage_closure', 'project_root is required to resolve and recompute',
  ]],
  ['skills/idea-posterior/scripts/literature_ledger_contract.py', [
    'must pin the same combined ledger', 'validate_candidate_pool', 'validate_bibliography',
    'validate_method_audit', 'final_status does not match recomputed coverage closure',
  ]],
  ['skills/idea-posterior/scripts/literature_ledger_primitives.py', [
    'resolve_pinned_project_json', 'validate_canonical_identity',
    'does not match detailed ledger value', 'validate_bounded_provider_accounting',
  ]],
  ['skills/idea-posterior/scripts/literature_candidate_contract.py', [
    'bibliography_claims', 'is not a selected core source', 'canonical identity', 'merge aliases',
  ]],
  ['skills/idea-posterior/scripts/literature_bibliography_contract.py', [
    'bibliography discovery claims do not match the pinned raw manifest',
    'candidate_ids do not match the candidate bibliography discovery claims',
    'references_artifact_ref',
  ]],
  ['skills/idea-posterior/scripts/literature_method_contract.py', [
    'bibliography_candidate_screening', 'does not cover exactly the reconciled candidates',
    'source_text',
  ]],
  ['skills/idea-posterior/scripts/literature_ledger_completion.py', [
    'core identity set differs from detailed ledger', 'bounded reference and citation checks',
  ]],
  ['skills/research-team/tests/test_literature_trace_gate.py', [
    'test_gate_deduplicates_doi_and_provider_keys_from_pinned_provider_records',
    'test_gate_rejects_bibliography_discovery_missing_from_pinned_manifest',
  ]],
  ['skills/idea-posterior/tests/test_close_prior_gate.py', [
    'test_bound_coverage_deduplicates_doi_and_provider_keys_from_pinned_records',
    'test_bound_coverage_rejects_bibliography_discovery_missing_from_pinned_manifest',
  ]],
  ['skills/idea-posterior/scripts/posterior_writeback.py', [
    'project_root=project_root', 'literature-ledger references resolve against the project root',
  ]],
];
