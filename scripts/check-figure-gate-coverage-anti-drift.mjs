#!/usr/bin/env node

/**
 * Display-acceptance gate anti-drift CI check (2026-W29 N1).
 *
 * The display-surface-equals-acceptance-surface discipline ("before a figure
 * or table becomes durable or outward-facing, every plotted quantity must be
 * bound to a verification-gate verdict and an all-component human-review
 * overview figure must be archived; the verdict is computed by the gate
 * script, fail-closed, never by the caller") is enforced by
 * skills/figure-hygiene/scripts/bin/check_display_acceptance.py and
 * documented in the figure-hygiene skill. A discipline that lives only in
 * prose erodes silently; this lock fails the build when any leg of the
 * contract is removed, renamed, or softened:
 *
 *   1. GATE SUBSTANCE. The gate script still carries the falsification
 *      labels (missing_verdict_binding, verdict_mismatch,
 *      missing_overview_figure, invalid_manifest), still reads the required
 *      manifest fields (plotted_quantities, verdict_bindings,
 *      overview_figure), still pins verdict artifacts by SHA-256, and still
 *      demands the artifact cover the bound quantity.
 *
 *   2. SCHEMA AUTHORITY. meta/schemas/display_gate_result_v1.schema.json
 *      keeps the exact result enum and finding categories the script emits.
 *
 *   3. PROSE. figure-hygiene SKILL.md still documents the display_acceptance
 *      block, its required fields, the machine-only-verdict rule, and the
 *      fail-closed default.
 *
 *   4. TESTS + CI WIRING. The behavior tests (including every negative
 *      control) still exist and CI still runs both the tests and this lock.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GATE_FILE = 'skills/figure-hygiene/scripts/bin/check_display_acceptance.py';
const SCHEMA_FILE = 'meta/schemas/display_gate_result_v1.schema.json';
const SKILL_FILE = 'skills/figure-hygiene/SKILL.md';
const TESTS_FILE = 'skills/figure-hygiene/tests/test_display_acceptance_gate.py';
const CI_FILE = '.github/workflows/ci.yml';

const EXPECTED_RESULT_ENUM = [
  'pass',
  'missing_verdict_binding',
  'verdict_mismatch',
  'missing_overview_figure',
  'invalid_manifest',
];

const errors = [];

function read(relPath) {
  const abs = path.join(repoRoot, relPath);
  if (!existsSync(abs)) {
    errors.push(`file missing: ${relPath}`);
    return null;
  }
  return readFileSync(abs, 'utf-8');
}

function requireAll(relPath, text, needles) {
  if (text === null) return;
  for (const [label, needle] of needles) {
    if (!text.includes(needle)) {
      errors.push(`${relPath}: missing ${label}: expected to find ${JSON.stringify(needle)}`);
    }
  }
}

// 1. Gate substance.
requireAll(GATE_FILE, read(GATE_FILE), [
  ['missing-binding falsification label', '"missing_verdict_binding"'],
  ['verdict-mismatch falsification label', '"verdict_mismatch"'],
  ['missing-overview falsification label', '"missing_overview_figure"'],
  ['invalid-manifest fail-closed label', '"invalid_manifest"'],
  ['declared-denominator manifest field', '"plotted_quantities"'],
  ['verdict-binding manifest field', '"verdict_bindings"'],
  ['overview-figure manifest field', '"overview_figure"'],
  ['byte-pinning of bound verdict artifacts', 'verdict_sha256'],
  ['hash recomputation over artifact bytes', 'def _sha256_file'],
  ['quantity-coverage demand on the artifact', '"quantity-not-covered"'],
  ['accepted-outcome demand on the artifact', '"verdict-not-accepted"'],
  ['gate-fixed accepted outcome (manifest cannot widen acceptance)', 'ACCEPTED_VERDICT = "pass"'],
  ['fixed-outcome comparison in the binding check', 'if outcome != ACCEPTED_VERDICT:'],
  ['closed manifest contract (unsupported fields refused)', '"unexpected-field"'],
  ['overview archival affirmation check', '"overview-not-archived"'],
  ['overview on-disk existence check', '"overview-file-missing"'],
  ['fail-closed payload on usage errors', '"usage-error"'],
  ['machine-only verdict rule', 'callers must not self-assess'],
]);

// 2. Schema authority: enums must match the script exactly.
const schemaText = read(SCHEMA_FILE);
if (schemaText !== null) {
  let resultEnum = [];
  let categoryEnum = [];
  try {
    const schema = JSON.parse(schemaText);
    resultEnum = schema?.properties?.result?.enum ?? [];
    categoryEnum = schema?.$defs?.DisplayGateFinding?.properties?.category?.enum ?? [];
  } catch (e) {
    errors.push(`${SCHEMA_FILE}: not parseable as JSON: ${e.message}`);
  }
  if (JSON.stringify(resultEnum) !== JSON.stringify(EXPECTED_RESULT_ENUM)) {
    errors.push(
      `${SCHEMA_FILE}: result enum drifted: got ${JSON.stringify(resultEnum)}, ` +
      `expected ${JSON.stringify(EXPECTED_RESULT_ENUM)} — the gate's emitted verdict would ` +
      'no longer validate, or a falsification label was silently dropped.',
    );
  }
  const expectedCategories = EXPECTED_RESULT_ENUM.filter((v) => v !== 'pass');
  if (JSON.stringify([...categoryEnum].sort()) !== JSON.stringify([...expectedCategories].sort())) {
    errors.push(
      `${SCHEMA_FILE}: finding category enum drifted: got ${JSON.stringify(categoryEnum)}, ` +
      `expected the non-pass results ${JSON.stringify(expectedCategories)}.`,
    );
  }
}

// 3. Prose.
requireAll(SKILL_FILE, read(SKILL_FILE), [
  ['display-acceptance section heading', '## Display Acceptance Gate'],
  ['display_acceptance manifest block', '"display_acceptance"'],
  ['declared-denominator field in prose', '`plotted_quantities`'],
  ['verdict-binding field in prose', '`verdict_bindings`'],
  ['overview-figure field in prose', '`overview_figure`'],
  ['gate invocation', 'check_display_acceptance.py'],
  ['machine-only verdict rule', 'the caller must not self-assess'],
  ['gate-fixed acceptance prose', 'the manifest cannot widen acceptance'],
  ['fail-closed default', 'fail-closed'],
  ['new-display-new-observable discipline', 'A new display is a new observable.'],
]);

// 4. Tests: the negative controls must keep asserting failure, not merely
// exist as names. Each control's OWN body must still demand its exit code,
// its falsification label, and its finding kind — a shared string elsewhere
// in the file must not satisfy another control's pin, so the needles are
// checked inside the named top-level function body, not globally.
const testsText = read(TESTS_FILE);
const testBodies = {};
if (testsText !== null) {
  for (const chunk of testsText.split(/^(?=def )/m)) {
    const m = chunk.match(/^def (\w+)/);
    if (m) testBodies[m[1]] = chunk;
  }
}

function requireInTestBody(name, label, needles) {
  if (testsText === null) return;
  const body = testBodies[name];
  if (body === undefined) {
    errors.push(`${TESTS_FILE}: missing ${label}: expected top-level function ${name}`);
    return;
  }
  for (const needle of needles) {
    if (!body.includes(needle)) {
      errors.push(
        `${TESTS_FILE}: ${label} (${name}) no longer asserts ${JSON.stringify(needle)} in its own body`,
      );
    }
  }
}

requireInTestBody('test_full_bundle_passes', 'positive control', [
  'assert code == 0',
  'assert payload["result"] == "pass"',
]);
requireInTestBody('test_missing_verdict_binding_fails', 'missing-binding negative control', [
  'assert code == 1',
  'assert payload["result"] == "missing_verdict_binding"',
  '"missing-binding"',
]);
requireInTestBody('test_display_acceptance_block_absent_fails', 'undeclared-block negative control', [
  'assert code == 1',
  'assert payload["result"] == "missing_verdict_binding"',
  '"display-acceptance-missing"',
]);
requireInTestBody('test_empty_plotted_quantities_fails', 'empty-denominator negative control', [
  'assert code == 1',
  'assert payload["result"] == "missing_verdict_binding"',
  '"plotted-quantities-undeclared"',
]);
requireInTestBody('test_verdict_hash_mismatch_fails', 'tampered-verdict negative control', [
  'assert code == 1',
  'assert payload["result"] == "verdict_mismatch"',
  '"verdict-hash-mismatch"',
]);
requireInTestBody('test_verdict_not_covering_quantity_fails', 'wrong-quantity negative control', [
  'assert code == 1',
  'assert payload["result"] == "verdict_mismatch"',
  '"quantity-not-covered"',
]);
requireInTestBody('test_failing_verdict_outcome_fails', 'failing-outcome negative control', [
  'assert code == 1',
  'assert payload["result"] == "verdict_mismatch"',
  '"verdict-not-accepted"',
]);
requireInTestBody('test_caller_cannot_widen_accepted_verdicts', 'caller-widening negative control', [
  'assert code == 1',
  '"unexpected-field"',
  '"verdict-not-accepted"',
]);
requireInTestBody('test_unexpected_block_field_fails', 'closed-contract negative control', [
  'assert code == 1',
  '"unexpected-field"',
]);
requireInTestBody('test_binding_unknown_quantity_fails', 'unknown-quantity binding negative control', [
  'assert code == 1',
  'assert payload["result"] == "verdict_mismatch"',
  '"binding-unknown-quantity"',
]);
requireInTestBody('test_duplicate_binding_fails', 'duplicate-binding negative control', [
  'assert code == 1',
  '"duplicate-binding"',
]);
requireInTestBody('test_duplicate_plotted_quantity_fails', 'duplicate-quantity negative control', [
  'assert code == 1',
  '"duplicate-plotted-quantity"',
]);
requireInTestBody('test_unreadable_verdict_artifact_fails', 'unreadable-verdict negative control', [
  'assert code == 1',
  'assert payload["result"] == "verdict_mismatch"',
  '"verdict-unreadable"',
]);
requireInTestBody('test_missing_overview_figure_file_fails', 'missing-overview negative control', [
  'assert code == 1',
  'assert payload["result"] == "missing_overview_figure"',
  '"overview-file-missing"',
]);
requireInTestBody('test_overview_not_archived_fails', 'unarchived-overview negative control', [
  'assert code == 1',
  'assert payload["result"] == "missing_overview_figure"',
  '"overview-not-archived"',
]);
requireInTestBody('test_overview_undeclared_fails', 'undeclared-overview negative control', [
  'assert code == 1',
  'assert payload["result"] == "missing_overview_figure"',
  '"overview-undeclared"',
]);
requireInTestBody('test_overview_hash_pinned_passes', 'overview-hash positive control', [
  'assert code == 0',
  'assert payload["result"] == "pass"',
]);
requireInTestBody('test_overview_hash_mismatch_fails', 'overview-hash-mismatch negative control', [
  'assert code == 1',
  '"overview-hash-mismatch"',
]);
requireInTestBody('test_overview_hash_malformed_fails', 'overview-hash-malformed negative control', [
  'assert code == 1',
  '"overview-hash-malformed"',
]);
requireInTestBody('test_binding_priority_over_overview', 'deterministic roll-up control', [
  'assert payload["result"] == "missing_verdict_binding"',
]);
requireInTestBody('test_binding_not_object_fails', 'malformed-binding negative control', [
  'assert code == 1',
  '"binding-malformed"',
]);
requireInTestBody('test_verdict_artifact_not_found_fails', 'dead-reference negative control', [
  'assert code == 1',
  'assert payload["result"] == "missing_verdict_binding"',
  '"verdict-not-found"',
]);
requireInTestBody('test_empty_display_acceptance_block_fails', 'empty-block negative control', [
  'assert code == 1',
  '"plotted-quantities-undeclared"',
  '"overview-undeclared"',
]);
requireInTestBody('test_usage_error_emits_invalid_manifest_payload', 'usage-error payload control', [
  'assert proc.returncode == 2',
  'assert payload["result"] == "invalid_manifest"',
]);
requireInTestBody('test_unreadable_manifest_is_invalid', 'unreadable-manifest control', [
  'assert code == 2',
  'assert payload["result"] == "invalid_manifest"',
]);
requireInTestBody('test_result_enum_matches_schema_authority', 'schema-sync assertion', [
  'RESULT_VALUES',
  'CATEGORY_PRIORITY',
]);
requireInTestBody('_assert_payload_matches_schema', 'structural payload validator', [
  'if payload["result"] != "pass":',
  'assert payload["findings"]',
]);
requireInTestBody('test_failing_payload_satisfies_schema_and_explains_itself', 'failing-payload structural control', [
  '_assert_payload_matches_schema(payload)',
]);

// CI wiring: both the behavior tests and this lock must actually run.
requireAll(CI_FILE, read(CI_FILE), [
  ['behavior-test step', 'skills/figure-hygiene/tests/test_display_acceptance_gate.py'],
  ['anti-drift lock step', 'scripts/check-figure-gate-coverage-anti-drift.mjs'],
]);

if (errors.length > 0) {
  process.stderr.write('[figure-gate-coverage-drift] anti-drift check failed:\n\n');
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.stderr.write(
    '\nThe display-surface-equals-acceptance-surface discipline is load-bearing: restore the ' +
    'contract (gate labels, schema enums, SKILL.md prose, behavior tests, CI wiring) rather ' +
    'than softening this check.\n',
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    '[ok] display-acceptance gate contract intact: gate substance, schema enums, SKILL.md ' +
    'discipline, behavior tests, and CI wiring all present.\n',
  );
}
