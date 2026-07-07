#!/usr/bin/env node

/**
 * literature-to-package anti-drift CI check.
 *
 * The literature-to-package pipeline discipline (7 phases, each closed by a
 * deterministic fail-closed gate; the caller never self-judges; ports never
 * count as independent; tolerances must be diagnostic; waivers must be
 * explicit) is enforced by the skill's gate executor and documented in its
 * contract. A discipline that lives only in prose erodes silently; this lock
 * fails the build when any leg is removed or renamed:
 *
 *   1. GATE SUBSTANCE. scripts/gates/check_phase.py still declares all seven
 *      phases, carries the load-bearing falsification labels, and emits the
 *      literature_to_package_gate_result_v1 verdict.
 *
 *   2. CONTRACT. references/contract.md still documents every phase artifact
 *      schema id and the honesty invariants.
 *
 *   3. SKILL PROSE. SKILL.md still names the composed skills (this skill is
 *      an orchestration layer, not a re-implementation) and the
 *      trace-divergence-not-majority discipline.
 *
 *   4. TESTS. The behavior tests still assert the load-bearing labels (a
 *      stubbed checker returning no findings cannot survive tests that demand
 *      FAIL verdicts), and CI runs them.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKILL = 'skills/literature-to-package';
const GATE_FILE = `${SKILL}/scripts/gates/check_phase.py`;
const CONTRACT_FILE = `${SKILL}/references/contract.md`;
const SKILL_FILE = `${SKILL}/SKILL.md`;
const TESTS_FILE = `${SKILL}/tests/test_phase_gates.py`;
const SMOKE_FILE = `${SKILL}/scripts/dev/run_smoke.sh`;
const CI_FILE = '.github/workflows/ci.yml';

const PHASES = [
  'survey', 'extraction', 'skeleton', 'reimplementation',
  'reference-check', 'composite-gates', 'closeout',
];

const GATE_LABELS = [
  'ABSENCE_PROMOTED_TO_NOVELTY',
  'ORIGINALITY_WITHOUT_STRONGEST_PRIOR',
  'MEMORY_CITED_AS_SOURCE',
  'MISSING_VERBATIM',
  'MISSING_LOCATOR',
  'MISSING_UNITS',
  'ABSOLUTE_PATH_IN_PACKAGE',
  'EXCLUSION_COVERS_ROOT',
  'PATH_ESCAPES_PACKAGE_ROOT',
  'MISSING_SOURCE_DIRS',
  'UNTRACED_LEDGER_ITEM',
  'UNTRACED_PACKAGE_FILE',
  'EXPORT_DOC_UNANCHORED',
  'EXPORT_TEST_UNANCHORED',
  'EXPORT_NOT_IN_SOURCE',
  'EXPORT_NOT_IN_LEDGER',
  'PORT_CLAIMED_INDEPENDENT',
  'INSUFFICIENT_INDEPENDENT_IMPLEMENTATIONS',
  'IMPLEMENTATION_COUPLING',
  'REFERENCE_CODE_COUPLING',
  'SPEC_REFERENCES_SOURCE_CODE',
  'REVIEW_NOT_APPROVED',
  'REVIEW_VERDICT_UNRECOGNIZED',
  'VALUE_MISMATCH',
  'NON_DIAGNOSTIC_TOLERANCE',
  'ERROR_SCALE_INFLATED',
  'SINGLE_REPRESENTATION',
  'REFERENCE_IN_RUNTIME_DEPS',
  'GATE_NOT_PASSED',
  'SILENT_WAIVER',
  'UNEXECUTED_README_EXAMPLE',
  'SCRUB_LEXICON_HIT',
  'UNRESOLVED_TRACEABILITY',
  'SCAN_INCOMPLETE',
];

const ARTIFACT_SCHEMAS = [
  'survey_decision_v1',
  'extraction_manifest_v1',
  'skeleton_manifest_v1',
  'independence_manifest_v1',
  'reference_check_v1',
  'composite_gates_v1',
  'closeout_v1',
  'literature_to_package_gate_result_v1',
];

const COMPOSED_SKILLS = [
  'deep-literature-review',
  'claim-grounding',
  'citation-triangulation',
  'derivation-verify',
  'numerical-reliability-gate',
  'julia-perf',
  'review-swarm',
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

function requireAll(relPath, text, needles, label) {
  if (text === null) return;
  for (const needle of needles) {
    if (!text.includes(needle)) {
      errors.push(`${relPath}: missing ${label}: expected to find ${JSON.stringify(needle)}`);
    }
  }
}

// 1. Gate substance.
const gateText = read(GATE_FILE);
requireAll(GATE_FILE, gateText, PHASES.map((p) => `"${p}"`), 'phase id');
requireAll(GATE_FILE, gateText, GATE_LABELS, 'falsification label');
requireAll(GATE_FILE, gateText, ['literature_to_package_gate_result_v1'], 'verdict schema id');

// 2. Contract.
const contractText = read(CONTRACT_FILE);
requireAll(CONTRACT_FILE, contractText, ARTIFACT_SCHEMAS, 'artifact schema id');
requireAll(CONTRACT_FILE, contractText, ['The caller never self-judges', 'Honesty invariants'], 'honesty invariant');

// 3. Skill prose.
const skillText = read(SKILL_FILE);
requireAll(SKILL_FILE, skillText, COMPOSED_SKILLS.map((s) => `\`${s}\``), 'composed-skill reference');
requireAll(SKILL_FILE, skillText, [
  'never settle by majority vote',
  'self-judges',
], 'discipline phrase');

// 4. Tests + smoke + CI wiring.
const testsText = read(TESTS_FILE);
requireAll(TESTS_FILE, testsText, [
  'PORT_CLAIMED_INDEPENDENT',
  'VALUE_MISMATCH',
  'NON_DIAGNOSTIC_TOLERANCE',
  'SILENT_WAIVER',
  'SCRUB_LEXICON_HIT',
  'MEMORY_CITED_AS_SOURCE',
  // Adversarial regressions: each pins a hole a reviewer demonstrated or a
  // fail-closed guarantee the contract states. A gutted checker cannot
  // survive these tests demanding FAIL verdicts.
  'def test_reference_check_self_claimed_pass_is_ignored',
  'def test_skeleton_ledger_escape_via_dotdot_rejected',
  'def test_skeleton_untraced_package_file',
  'def test_survey_absence_only_prior_art_rejected',
  'def test_reference_check_zero_errors_unanchored',
  'def test_reference_check_no_errors_at_all_unanchored',
  'def test_composite_gates_row_verdicts_recomputed',
  'def test_composite_gates_unversioned_matrix_rejected',
  'def test_reimplementation_json_pass_with_blockers_not_approved',
  'def test_reimplementation_bare_verdict_line_is_not_a_review',
  'def test_skeleton_comment_mention_cannot_fake_export_leg',
  'def test_wrong_schema_id_is_input_error',
  'def test_unwritable_out_json_keeps_single_stdout_verdict',
], 'load-bearing test assertion');

// 5. Mirror sync: the review-verdict format this gate accepts is MIRRORED from
// the review-swarm output contract. If review-swarm's required headers evolve,
// this lock fails until the mirror in check_phase.py is updated too.
const REVIEW_CONTRACT_FILE = 'skills/review-swarm/scripts/bin/review_contract.py';
const reviewContractText = read(REVIEW_CONTRACT_FILE);
if (reviewContractText !== null && gateText !== null) {
  const headerBlock = reviewContractText.match(/REQUIRED_HEADERS\s*=\s*\[([\s\S]*?)\]/);
  if (!headerBlock) {
    errors.push(`${REVIEW_CONTRACT_FILE}: could not parse REQUIRED_HEADERS — update this lock's mirror-sync parser.`);
  } else {
    const headers = [...headerBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (headers.length === 0) {
      errors.push(`${REVIEW_CONTRACT_FILE}: REQUIRED_HEADERS parsed empty — update this lock's mirror-sync parser.`);
    }
    for (const h of headers) {
      if (!gateText.includes(`"${h}"`)) {
        errors.push(
          `${GATE_FILE}: review-contract mirror is missing required header ${JSON.stringify(h)} ` +
          `(source of truth: ${REVIEW_CONTRACT_FILE}).`,
        );
      }
    }
  }
  // Same for the JSON half of the contract (verdict/blocking_issues/summary).
  const jsonBlock = reviewContractText.match(/JSON_REQUIRED_FIELDS\s*=\s*\{([\s\S]*?)\}/);
  if (!jsonBlock) {
    errors.push(`${REVIEW_CONTRACT_FILE}: could not parse JSON_REQUIRED_FIELDS — update this lock's mirror-sync parser.`);
  } else {
    const fields = [...jsonBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (fields.length === 0) {
      errors.push(`${REVIEW_CONTRACT_FILE}: JSON_REQUIRED_FIELDS parsed empty — update this lock's mirror-sync parser.`);
    }
    for (const fld of fields) {
      if (!gateText.includes(`"${fld}"`)) {
        errors.push(
          `${GATE_FILE}: review-contract mirror is missing required JSON field ${JSON.stringify(fld)} ` +
          `(source of truth: ${REVIEW_CONTRACT_FILE}).`,
        );
      }
    }
  }
}
if (!existsSync(path.join(repoRoot, SMOKE_FILE))) {
  errors.push(`smoke script missing: ${SMOKE_FILE}`);
}
const ciText = read(CI_FILE);
requireAll(CI_FILE, ciText, [
  'scripts/check-literature-to-package-anti-drift.mjs',
  'skills/literature-to-package/tests/test_phase_gates.py',
], 'CI wiring');

if (errors.length > 0) {
  process.stderr.write('[literature-to-package-drift] anti-drift check failed:\n\n');
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.stderr.write(
    '\nThe literature-to-package phase-gate discipline is load-bearing: restore the contract ' +
    '(gate labels, artifact schemas, composed-skill prose, tests, CI wiring) rather than ' +
    'softening this check.\n',
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `[ok] literature-to-package contract intact: ${PHASES.length} phases, ` +
    `${GATE_LABELS.length} falsification labels, ${ARTIFACT_SCHEMAS.length} artifact schemas, ` +
    `${COMPOSED_SKILLS.length} composed skills, tests + smoke + CI wiring all present.\n`,
  );
}
