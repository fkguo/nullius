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
 *      keeps the exact result enum and finding categories the script emits;
 *      meta/schemas/quantity_verdict_v1.schema.json keeps every bound input
 *      explicitly identified, versioned, and closed.
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
const SEMANTICS_FILE = 'skills/figure-hygiene/scripts/bin/display_semantics.py';
const SCHEMA_FILE = 'meta/schemas/display_gate_result_v1.schema.json';
const INPUT_SCHEMA_FILE = 'meta/schemas/quantity_verdict_v1.schema.json';
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
  ['versioned closed verdict validation', 'def _validate_quantity_verdict_v1'],
  ['bound-artifact schema identity', 'VERDICT_SCHEMA_ID = "quantity_verdict_v1"'],
  ['schema-invalid falsification label', '"verdict-schema-invalid"'],
  ['gate-fixed accepted outcome (manifest cannot widen acceptance)', 'ACCEPTED_VERDICT = "pass"'],
  ['fixed-outcome comparison in the binding check', 'if outcome != ACCEPTED_VERDICT:'],
  ['closed manifest contract (unsupported fields refused)', '"unexpected-field"'],
  ['overview archival affirmation check', '"overview-not-archived"'],
  ['overview on-disk existence check', '"overview-file-missing"'],
  ['fail-closed payload on usage errors', '"usage-error"'],
  ['protected-input alias refusal', '"out-json-protected-input"'],
  ['deterministic write-failure payload', '"out-json-write-failed"'],
  ['ambiguous input-discovery refusal', '"out-json-input-discovery-failed"'],
  ['single strict JSON reader', 'def _read_json_document'],
  ['recursive duplicate-key decoder', 'object_pairs_hook=_reject_duplicate_json_keys'],
  ['slot relationship guard', 'def _path_conflicts_with_input_slot'],
  ['output-below-input guard', 'canonical_input in canonical_output.parents'],
  ['output-above-input guard', 'canonical_output in canonical_input.parents'],
  ['hard-link alias detection', 'os.path.samefile'],
  ['same-directory temporary output', 'tempfile.mkstemp'],
  ['atomic output replacement', 'os.replace'],
  ['machine-only verdict rule', 'callers must not self-assess'],
  ['final semantics call in the same gate', 'findings.extend(_semantics_module().check('],
  ['source/final/extraction input protection', 'protected.extend(_semantics_module().input_paths('],
]);

requireAll(SEMANTICS_FILE, read(SEMANTICS_FILE), [
  ['reading final visible HTML', '_Cells().finish(path.read_text(encoding="utf-8"))'],
  ['final value-unit refusal', '"value-unit-mismatch"'],
  ['component identity refusal', '"component-identity-missing"'],
  ['component order refusal', '"component-order-mismatch"'],
  ['reversible duplicate refusal', '"duplicate-representation"'],
  ['reader selection refusal', '"display-selection-mismatch"'],
  ['diagnostic purpose refusal', '"diagnostic-in-display"'],
  ['display-token rounding interval', 'printed.as_tuple().exponent / 2'],
  ['noninvertible forward mapping', 'abs(canonical) if kind == "absolute"'],
  ['no-values declaration field', '"prints_values"'],
  ['no-values declaration must be boolean', 'isinstance(prints_values, bool)'],
  ['no-values declaration closed shape', '{"purpose", "prints_values", "surfaces"}'],
  ['no-values declaration refusal on a result table', '"printed-values-undeclared"'],
  ['result-table detection on marked tables', '"data-results" in dict(attrs)'],
  ['result-table guard reads surface bytes, not a declared format', '_carries_result_table(path.read_bytes())'],
  ['result-table guard is encoding-independent', 'data.decode("latin-1")'],
  ['result-table guard tolerates damaged UTF-16', 'data.decode("utf-16", errors="replace")'],
  ['result-table guard survives parser refusal', '_MARKED_TABLE.search(text) is not None'],
  ['no-values declaration keeps the rendered review', 'with_values=False'],
  ['explicit drawn-quantity declaration', '"drawn_quantities"'],
  ['undeclared cell-less quantity refusal', 'no displayed components'],
  ['parser assertion mapped to a finding', 'KeyError, AssertionError) as exc'],
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

const inputSchemaText = read(INPUT_SCHEMA_FILE);
if (inputSchemaText !== null) {
  try {
    const schema = JSON.parse(inputSchemaText);
    const required = ['schema_id', 'schema_version', 'quantities', 'verdict'];
    if (schema?.properties?.schema_id?.const !== 'quantity_verdict_v1') {
      errors.push(`${INPUT_SCHEMA_FILE}: schema_id must remain quantity_verdict_v1`);
    }
    if (schema?.properties?.schema_version?.const !== 1) {
      errors.push(`${INPUT_SCHEMA_FILE}: schema_version must remain integer const 1`);
    }
    if (JSON.stringify([...(schema?.required ?? [])].sort()) !== JSON.stringify([...required].sort())) {
      errors.push(`${INPUT_SCHEMA_FILE}: required fields drifted from ${JSON.stringify(required)}`);
    }
    if (schema?.additionalProperties !== false) {
      errors.push(`${INPUT_SCHEMA_FILE}: bound verdict contract must remain closed`);
    }
    if (schema?.properties?.quantities?.minItems !== 1 || schema?.properties?.quantities?.uniqueItems !== true) {
      errors.push(`${INPUT_SCHEMA_FILE}: quantities must remain non-empty and unique`);
    }
    if (
      JSON.stringify(schema?.$defs?.QuantityVerdictOutcome?.enum ?? []) !==
      JSON.stringify(['pass', 'fail'])
    ) {
      errors.push(`${INPUT_SCHEMA_FILE}: verdict vocabulary drifted from ["pass","fail"]`);
    }
  } catch (e) {
    errors.push(`${INPUT_SCHEMA_FILE}: not parseable as JSON: ${e.message}`);
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
  ['bound verdict schema identity', '`quantity_verdict_v1`'],
  ['same-directory atomic output contract', 'same-directory atomic replacement'],
  ['protected input relationship contract', 'is refused if it aliases, contains, or is contained by the manifest'],
  ['ambiguous discovery persistence refusal', 'no output file is persisted'],
  ['recursive duplicate-key contract', 'rejects duplicate keys recursively'],
  ['fail-closed default', 'fail-closed'],
  ['new-display-new-observable discipline', 'A new display is a new observable.'],
  ['final-display reference routing', 'references/display-semantics.md'],
  ['final-display contract', '`final_display`'],
  ['no-values declaration in prose', '`prints_values: false`'],
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

requireInTestBody('test_final_value_unit_corruption_refused_after_repin', 'final value/unit behavior', [
  '_change_html(tmp_path, block, before, after)',
  '_semantic_result(tmp_path, block, "value-unit-mismatch")',
]);
requireInTestBody('test_unintended_reversible_duplicate_representation_refused', 'representation behavior', [
  '_semantic_result(tmp_path, block, "duplicate-representation")',
]);
requireInTestBody('test_declared_useful_dual_representation_accepted', 'intentional representation positive control', [
  '_semantic_result(tmp_path, block, None)',
]);
requireInTestBody('test_final_component_order_corruption_is_refused', 'component order behavior', [
  '_change_html(tmp_path, block,',
  '_semantic_result(tmp_path, block, "final-cell-order-mismatch")',
]);
requireInTestBody('test_intermediate_cannot_enter_limited_reader_selection', 'reader selection behavior', [
  '_semantic_result(tmp_path, block, "display-selection-mismatch")',
]);
requireInTestBody('test_equivalent_multilingual_final_output_is_accepted', 'translation positive control', [
  '_semantic_result(tmp_path, block, None)',
]);
requireInTestBody('test_continuous_plot_with_declared_no_printed_values_passes', 'no-values positive control', [
  '_curve_result(tmp_path, _curve_bundle(tmp_path), None)',
]);
requireInTestBody('test_no_values_declaration_keeps_the_verdict_binding_requirement', 'no-values binding control', [
  '"missing-binding"',
  'assert payload["result"] == "missing_verdict_binding"',
]);
requireInTestBody('test_no_values_declaration_still_requires_rendered_review', 'no-values review control', [
  '"rendered-review-missing"',
]);
requireInTestBody('test_no_values_declaration_still_requires_main_surface_coverage', 'no-values main-surface control', [
  '"main-surface-not-covered"',
]);
requireInTestBody('test_no_values_declaration_cannot_carry_cell_fields', 'no-values closed-shape control', [
  '{"cells": []}',
  '{"source": {"path": "quantities.json", "sha256": "0" * 64}}',
  '{"selection": ["response_curve"]}',
  '"semantics-malformed"',
]);
requireInTestBody('test_empty_cell_list_is_not_a_no_values_declaration', 'empty-cells negative control', [
  '_semantic_result(tmp_path, block, "semantics-malformed")',
]);
requireInTestBody('test_html_result_table_contradicts_no_values_declaration', 'false no-values declaration control', [
  '"printed-values-undeclared"',
]);
requireInTestBody('test_plotted_curve_beside_a_printed_headline_value_passes', 'unprinted-quantity positive control', [
  '_curve_result(tmp_path, _annotated_curve_bundle(tmp_path), None)',
]);
requireInTestBody('test_printed_headline_value_is_still_checked_beside_a_curve', 'headline value control', [
  '"value-unit-mismatch"',
]);
requireInTestBody('test_quantity_that_prints_any_cell_must_print_all_its_components', 'partial-components negative control', [
  '_semantic_result(tmp_path, block, "component-order-mismatch")',
]);
requireInTestBody('test_no_values_declaration_keeps_the_overview_requirement', 'no-values overview control', [
  '"overview-undeclared"',
  'assert payload["result"] == "missing_overview_figure"',
]);
requireInTestBody('test_no_values_declaration_still_pins_the_final_bytes', 'no-values byte-pin control', [
  '"final-input-mismatch"',
]);
requireInTestBody('test_no_values_surface_cannot_carry_reading_fields', 'no-values surface closed-shape control', [
  '("extraction", {"path": "cells.json", "sha256": "0" * 64})',
  '("format", "extracted")',
  '("labels", {})',
  '("unit_labels", {})',
  '("status_labels", {})',
  '"semantics-malformed"',
]);
requireInTestBody('test_prints_values_must_be_a_boolean', 'declaration-type control', [
  '[0, None]',
  'block["final_display"]["prints_values"] = 1',
  '"semantics-malformed"',
]);
requireInTestBody('test_result_table_guard_reads_bytes_not_a_declared_format', 'content-based guard control', [
  '"figs/page.pdf"',
  '"printed-values-undeclared"',
]);
requireInTestBody('test_binary_rendering_is_accepted_under_no_values_declaration', 'binary surface positive control', [
  '_curve_result(tmp_path, block, None)',
]);
requireInTestBody('test_parser_assertion_on_odd_markup_is_a_finding_not_a_crash', 'parser-assertion control', [
  'monkeypatch.setattr(html.parser.HTMLParser, "feed", _raising_feed)',
  'assert payload["result"] == "verdict_mismatch"',
  'assert "semantics-unreadable" in _kinds(payload)',
]);
requireInTestBody('test_result_table_guard_falls_back_when_the_parser_asserts', 'parser-fallback control', [
  'monkeypatch.setattr(html.parser.HTMLParser, "feed", _raising_feed)',
  'assert semantics._carries_result_table(marked)',
]);
requireInTestBody('test_result_table_guard_is_encoding_independent', 'encoding-independence control', [
  'encode("cp1252")',
  'encode("utf-16")',
  '"printed-values-undeclared"',
]);
requireInTestBody('test_odd_markup_cannot_hide_a_result_table', 'parser-refusal fallback control', [
  '"printed-values-undeclared"',
]);
requireInTestBody('test_odd_markup_without_result_table_is_accepted_under_no_values_declaration', 'odd-markup positive control', [
  '_curve_result(tmp_path, block, None)',
]);
requireInTestBody('test_html_without_result_table_is_accepted_under_no_values_declaration', 'no-values HTML positive control', [
  '_curve_result(tmp_path, block, None)',
]);
requireInTestBody('test_full_form_explicit_prints_values_true_is_accepted', 'explicit full-form control', [
  '_semantic_result(tmp_path, block, None)',
]);
requireInTestBody('test_unprinted_quantity_outside_the_selection_is_still_refused', 'drawn-outside-selection control', [
  '"display-selection-mismatch"',
]);
requireInTestBody('test_absence_of_cells_is_not_a_drawn_declaration', 'undeclared drawn quantity control', [
  'del block["final_display"]["drawn_quantities"]',
  '"component-order-mismatch"',
]);
requireInTestBody('test_drawn_declaration_cannot_name_a_printing_quantity', 'drawn-but-printing control', [
  '"display-selection-mismatch"',
]);
requireInTestBody('test_drawn_declaration_cannot_name_an_unselected_quantity', 'drawn-unselected control', [
  '"display-selection-mismatch"',
]);
requireInTestBody('test_drawn_quantity_without_value_cannot_be_printed', 'valueless-quantity cell control', [
  '"component-identity-missing"',
]);
requireInTestBody('test_empty_drawn_list_is_not_a_declaration', 'empty drawn-list control', [
  '"semantics-malformed"',
]);
requireInTestBody('test_table_row_dropped_by_the_generator_is_still_refused', 'dropped-row control', [
  '_semantic_result(tmp_path, block, "component-order-mismatch")',
]);

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
requireInTestBody('test_verdict_without_schema_identity_fails', 'unversioned-verdict negative control', [
  'assert code == 1',
  '"verdict-schema-invalid"',
]);
requireInTestBody('test_verdict_wrong_schema_version_fails', 'wrong-version negative control', [
  'assert code == 1',
  '"verdict-schema-invalid"',
]);
requireInTestBody('test_verdict_with_extra_field_fails_closed_shape', 'open-verdict negative control', [
  'assert code == 1',
  '"verdict-schema-invalid"',
]);
requireInTestBody('test_duplicate_verdict_key_fails_closed', 'duplicate-verdict negative control', [
  'assert code == 1',
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
requireInTestBody('test_out_json_persists_same_payload', 'out-json round-trip control', [
  'assert proc.returncode == 0',
  'json.loads(out_path.read_text(encoding="utf-8"))',
]);
requireInTestBody('test_out_json_rejects_manifest_alias_without_clobbering', 'manifest-alias negative control', [
  'assert proc.returncode == 2',
  '"out-json-protected-input"',
  'assert manifest.read_bytes() == before',
]);
requireInTestBody('test_out_json_rejects_bound_verdict_alias_without_clobbering', 'verdict-alias negative control', [
  'assert proc.returncode == 2',
  '"out-json-protected-input"',
  'assert verdict_path.read_bytes() == before',
]);
requireInTestBody('test_out_json_rejects_overview_alias_without_clobbering', 'overview-alias negative control', [
  'assert proc.returncode == 2',
  '"out-json-protected-input"',
  'assert overview_path.read_bytes() == before',
]);
requireInTestBody('test_out_json_rejects_existing_hard_link_alias', 'hard-link-alias negative control', [
  'assert proc.returncode == 2',
  '"out-json-protected-input"',
]);
requireInTestBody('test_out_json_rejects_missing_verdict_slot_without_creating_it', 'missing-verdict-slot control', [
  'assert proc.returncode == 2',
  '"out-json-protected-input"',
  'assert not missing_verdict.exists()',
]);
requireInTestBody('test_out_json_rejects_ancestor_of_missing_verdict_slot', 'missing-verdict-ancestor control', [
  'assert proc.returncode == 2',
  '"out-json-protected-input"',
  'assert not ancestor.exists()',
]);
requireInTestBody('test_out_json_rejects_descendant_of_missing_overview_slot', 'missing-overview-descendant control', [
  'assert proc.returncode == 2',
  '"out-json-protected-input"',
  'assert not missing_overview.exists()',
]);
requireInTestBody('test_out_json_directory_failure_emits_deterministic_json', 'write-failure negative control', [
  'assert first.returncode == second.returncode == 2',
  'assert first.stdout == second.stdout',
  '"out-json-write-failed"',
]);
requireInTestBody('test_atomic_writer_uses_same_directory_replace', 'atomic-write control', [
  'assert calls[0][0].parent == target.parent',
  'assert calls[0][1] == target',
]);
requireInTestBody('test_human_output_states_verdict', 'human-summary control', [
  'assert proc.returncode == 0',
  '"display acceptance pass"',
]);
requireInTestBody('test_usage_error_emits_invalid_manifest_payload', 'usage-error payload control', [
  'assert proc.returncode == 2',
  'assert payload["result"] == "invalid_manifest"',
]);
requireInTestBody('test_unreadable_manifest_is_invalid', 'unreadable-manifest control', [
  'assert code == 2',
  'assert payload["result"] == "invalid_manifest"',
]);
requireInTestBody(
  'test_nested_duplicate_manifest_key_suppresses_output_persistence',
  'nested-duplicate and ambiguous-discovery control',
  [
    '"manifest-unreadable"',
    'assert proc.returncode == 2',
    '"out-json-input-discovery-failed"',
    'assert not out_path.exists()',
  ],
);
requireInTestBody('test_result_enum_matches_schema_authority', 'schema-sync assertion', [
  'RESULT_VALUES',
  'CATEGORY_PRIORITY',
]);
requireInTestBody('test_quantity_verdict_schema_matches_runtime_contract', 'input-schema sync assertion', [
  'VERDICT_SCHEMA_ID',
  'VERDICT_SCHEMA_VERSION',
  '_VERDICT_FIELDS',
]);
requireInTestBody('test_generated_quantity_verdict_api_has_schema_specific_symbols', 'generated API collision control', [
  'ast.parse(',
  'assert "quantity_verdict_v1" in aggregate_modules',
  'assert not leaf_wildcard_imports',
  'symtable.symtable(',
  '.is_assigned()',
  '.is_imported()',
  'assert "__all__" not in bound_names',
  'quantity_public_names.isdisjoint({"Verdict", "Quantity"})',
  '_last_exporting_module("Verdict") == "launch_authorization_v1"',
  '_last_exporting_module("QuantityVerdictIdentifier") == "quantity_verdict_v1"',
  '_last_exporting_module("QuantityVerdictOutcome") == "quantity_verdict_v1"',
  '_last_exporting_module("QuantityVerdictV1") == "quantity_verdict_v1"',
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
