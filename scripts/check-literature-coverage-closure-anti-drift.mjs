#!/usr/bin/env node

/**
 * Literature coverage-closure anti-drift lock.
 *
 * Search-round convergence cannot stand in for bibliography reconciliation,
 * candidate disposition, or method-family coverage. Keep the executable gate,
 * shared survey receipt, workflow handoff, templates, and public skill wording
 * wired to the same fail-closed contract.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_FLAGS = [
  'candidate_disposition_ledger_required',
  'bibliography_reconciliation_required',
  'stable_identity_resolution_required',
  'unresolved_candidates_are_coverage_debt',
  'method_family_audit_required',
  'method_description_evidence_required',
  'bounded_bibliography_traversal_required',
];

const failures = [];

function read(relativePath) {
  try {
    return readFileSync(path.join(repoRoot, relativePath), 'utf8');
  } catch (error) {
    failures.push(`${relativePath}: cannot read (${error instanceof Error ? error.message : String(error)})`);
    return '';
  }
}

const anchoredFiles = new Map([
  ['packages/shared/src/literature-survey.ts', [
    'BibliographyReconciliationSummary',
    'MethodFamilyAuditSummary',
    'assessCoverageClosure',
    'core-source bibliographies are not fully reconciled',
    'method-family coverage has not been audited',
    'lacks source-text method evidence',
  ]],
  ['skills/research-team/scripts/gates/check_literature_trace.py', [
    '_validate_candidate_ledger',
    '_validate_bibliography_reconciliation',
    '_validate_method_family_audit',
    'unresolved identity must remain disposition',
    'merge aliases into one normalized candidate record',
    'core-disposition candidate(s) absent from selected_core_ids',
    'must describe the method, not only title/year metadata',
    'references_artifact does not exist',
    'references_extracted must equal the raw references manifest count',
    'raw_text is required',
    "evidence_basis must be 'source_text'",
    'method_features must record at least one',
    "must be true when final_status='saturated'",
  ]],
  ['skills/research-team/assets/literature_saturation_template.json', [
    '"candidates": []',
    '"bibliography_reconciliation"',
    '"method_family_audit"',
  ]],
  ['skills/research-team/scripts/bin/generate_demo_milestone.py', [
    '"demo:method-note"',
    '"references_checked": True',
    '"citations_checked": True',
    '"evidence_basis": "source_text"',
  ]],
  ['skills/idea-posterior/scripts/validate_close_prior_gate.py', [
    '_validate_coverage_closure',
    '_is_nonnegative_int',
    'saturated survey requires bibliography_reconciliation.status=reconciled',
    'saturated survey requires method_family_audit.status=audited',
    'source-text method evidence for every audited core source',
  ]],
  ['skills/idea-posterior/SKILL.md', [
    'Snowball convergence is not sufficient by itself',
    'unresolved identities remain coverage debt',
  ]],
  ['skills/deep-literature-review/SKILL.md', [
    'Reconcile every core-source bibliography before saturation',
    'Audit method-family gaps from source text, not title/year queries',
    'does not recursively walk',
    'an unbounded graph in one step',
  ]],
  ['skills/literature-graph-builder/references/graph-ready-contract.md', [
    'reconciled upstream ledgers',
    'title/year similarity is not sufficient evidence',
  ]],
  ['packages/literature-workflows/src/types.ts', REQUIRED_FLAGS],
  ['packages/orchestrator/src/state-manager.ts', REQUIRED_FLAGS],
  ['meta/schemas/workflow_recipe_v1.schema.json', REQUIRED_FLAGS],
]);

for (const [relativePath, anchors] of anchoredFiles) {
  const content = read(relativePath);
  for (const anchor of anchors) {
    if (!content.includes(anchor)) failures.push(`${relativePath}: missing contract anchor ${JSON.stringify(anchor)}`);
  }
}

for (const relativePath of [
  'packages/literature-workflows/recipes/literature_landscape.json',
  'packages/literature-workflows/recipes/literature_gap_analysis.json',
  'packages/literature-workflows/recipes/literature_to_evidence.json',
]) {
  let recipe;
  try {
    recipe = JSON.parse(read(relativePath));
  } catch (error) {
    failures.push(`${relativePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  let contractCount = 0;
  for (const step of recipe.steps ?? []) {
    const contract = step?.consumer_hints?.literature_saturation_contract;
    if (!contract) continue;
    contractCount += 1;
    for (const flag of REQUIRED_FLAGS) {
      if (contract[flag] !== true) failures.push(`${relativePath}:${step.id}: ${flag} must remain true`);
    }
  }
  if (contractCount === 0) failures.push(`${relativePath}: no literature_saturation_contract found`);
}

if (failures.length > 0) {
  process.stderr.write('[literature-coverage-closure-drift] anti-drift check failed:\n\n');
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write('[literature-coverage-closure-drift] anti-drift check passed.\n');
