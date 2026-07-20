#!/usr/bin/env node

/**
 * Launch-authorization gate anti-drift CI check (W29-N3).
 *
 * The production launch authorization preflight is one discipline stated in
 * five places that nothing else keeps in sync:
 *
 *   - meta/schemas/launch_authorization_v1.schema.json   (result contract)
 *   - meta/schemas/gate_spec_v1.schema.json              (A3 policy shape)
 *   - packages/shared/src/gate-registry.ts               (registry SSOT: A3 policy + constants)
 *   - skills/research-harness/scripts/check_launch_authorization.py  (the checker)
 *   - skills/research-harness/SKILL.md                   (operator-facing contract)
 *
 * This lock asserts the falsification-labeled verdict enum, the check ids,
 * and the "unavailable is never approval / default refuse" discipline stay
 * identical across all five, that the negative-control tests still cover
 * every mismatch class, and that CI still runs both those tests and this
 * lock. Same structural-parse shape as the sibling anti-drift scripts
 * (e.g. check-independent-reproduction-anti-drift.mjs).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RESULT_SCHEMA_FILE = 'meta/schemas/launch_authorization_v1.schema.json';
const GATE_SPEC_SCHEMA_FILE = 'meta/schemas/gate_spec_v1.schema.json';
const REGISTRY_FILE = 'packages/shared/src/gate-registry.ts';
const CHECKER_FILE = 'skills/research-harness/scripts/check_launch_authorization.py';
const SKILL_FILE = 'skills/research-harness/SKILL.md';
const TESTS_FILE = 'skills/research-harness/tests/test_launch_authorization_gate.py';
const CI_FILE = '.github/workflows/ci.yml';

// Canonical falsification-labeled verdicts, in contract order.
const VERDICTS = [
  'authorized',
  'invalid_record',
  'missing_plan_hash',
  'stale_review',
  'missing_review',
  'review_rejected',
  'reviewer_unavailable',
  'fingerprint_mismatch',
];

// Canonical check ids, in evaluation order.
const CHECKS = ['plan_frozen', 'review_binding', 'fingerprint_match'];

const errors = [];

function read(relPath) {
  try {
    return readFileSync(path.join(repoRoot, relPath), 'utf8');
  } catch {
    errors.push(`${relPath}: file missing or unreadable`);
    return null;
  }
}

function requireAll(relPath, text, needles) {
  for (const [label, needle] of needles) {
    if (!text.includes(needle)) {
      errors.push(`${relPath}: missing ${label} (expected to contain: ${JSON.stringify(needle)})`);
    }
  }
}

function sameList(relPath, label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(
      `${relPath}: ${label} drifted — expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
    );
  }
}

// 1. Result schema is the enum authority: verdicts, check ids, exit codes,
//    and the authorized->0 / refusal->non-zero binding.
const resultSchemaText = read(RESULT_SCHEMA_FILE);
if (resultSchemaText !== null) {
  let schema;
  try {
    schema = JSON.parse(resultSchemaText);
  } catch (parseError) {
    errors.push(`${RESULT_SCHEMA_FILE}: not valid JSON (${parseError.message})`);
  }
  if (schema) {
    sameList(RESULT_SCHEMA_FILE, 'verdict enum', schema.properties?.verdict?.enum, VERDICTS);
    sameList(
      RESULT_SCHEMA_FILE,
      'check_id enum',
      schema.properties?.checks?.items?.properties?.check_id?.enum,
      CHECKS,
    );
    sameList(RESULT_SCHEMA_FILE, 'exit_code enum', schema.properties?.exit_code?.enum, [0, 2, 3]);
    const allOf = schema.allOf ?? [];
    const constBranch = (verdict) =>
      allOf.find((clause) => clause?.if?.properties?.verdict?.const === verdict);
    const enumBranch = allOf.find((clause) =>
      Array.isArray(clause?.if?.properties?.verdict?.enum),
    );
    const assertBranch = (branch, label, exitCode, authorized) => {
      if (
        branch?.then?.properties?.exit_code?.const !== exitCode ||
        branch?.then?.properties?.launch_authorized?.const !== authorized
      ) {
        errors.push(
          `${RESULT_SCHEMA_FILE}: allOf must bind ${label} to exit_code ${exitCode} and launch_authorized ${authorized}`,
        );
      }
    };
    assertBranch(constBranch('authorized'), 'verdict "authorized"', 0, true);
    assertBranch(constBranch('invalid_record'), 'verdict "invalid_record"', 2, false);
    assertBranch(enumBranch, 'the refusal-verdict set', 3, false);
    sameList(
      RESULT_SCHEMA_FILE,
      'refusal-branch verdict enum',
      enumBranch?.if?.properties?.verdict?.enum,
      VERDICTS.filter((verdict) => verdict !== 'authorized' && verdict !== 'invalid_record'),
    );
  }
}

// 2. gate_spec_v1 policy shape names the result schema and the exact checks.
const gateSpecText = read(GATE_SPEC_SCHEMA_FILE);
if (gateSpecText !== null) {
  let gateSpec;
  try {
    gateSpec = JSON.parse(gateSpecText);
  } catch (parseError) {
    errors.push(`${GATE_SPEC_SCHEMA_FILE}: not valid JSON (${parseError.message})`);
  }
  if (gateSpec) {
    const shape = gateSpec.properties?.policy?.properties?.launch_authorization;
    if (!shape) {
      errors.push(`${GATE_SPEC_SCHEMA_FILE}: policy.properties.launch_authorization shape removed`);
    } else {
      if (shape.properties?.result_schema?.const !== 'launch_authorization_v1') {
        errors.push(
          `${GATE_SPEC_SCHEMA_FILE}: launch_authorization.result_schema const must be "launch_authorization_v1"`,
        );
      }
      sameList(
        GATE_SPEC_SCHEMA_FILE,
        'launch_authorization.required_checks item enum',
        shape.properties?.required_checks?.items?.enum,
        CHECKS,
      );
    }
  }
}

// 3. Registry SSOT still carries the constants (exact list equality, so an
//    added, dropped, or reordered entry fires) and wires them into A3.
const registryText = read(REGISTRY_FILE);
if (registryText !== null) {
  requireAll(REGISTRY_FILE, registryText, [
    ['result-schema constant', "LAUNCH_AUTHORIZATION_RESULT_SCHEMA = 'launch_authorization_v1'"],
    ['A3 policy wiring', 'launch_authorization: {'],
    ['A3 policy result schema', 'result_schema: LAUNCH_AUTHORIZATION_RESULT_SCHEMA'],
    ['A3 policy checks', 'required_checks: LAUNCH_AUTHORIZATION_CHECKS'],
    ['policy accessor', 'export function getLaunchAuthorizationPolicy('],
  ]);
  const parseTsArray = (constName) => {
    const match = registryText.match(new RegExp(`${constName} = \\[([^\\]]*)\\]`, 's'));
    return match ? [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : null;
  };
  sameList(REGISTRY_FILE, 'LAUNCH_AUTHORIZATION_VERDICTS', parseTsArray('LAUNCH_AUTHORIZATION_VERDICTS'), VERDICTS);
  sameList(REGISTRY_FILE, 'LAUNCH_AUTHORIZATION_CHECKS', parseTsArray('LAUNCH_AUTHORIZATION_CHECKS'), CHECKS);
}

// 4. The checker's tuples match the canonical enums, and the discipline
//    prose survives.
const checkerText = read(CHECKER_FILE);
if (checkerText !== null) {
  const verdictsMatch = checkerText.match(/VERDICTS = \(([^)]*)\)/s);
  const parsedVerdicts = verdictsMatch
    ? [...verdictsMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
    : null;
  sameList(CHECKER_FILE, 'VERDICTS tuple', parsedVerdicts, VERDICTS);
  const checksMatch = checkerText.match(/CHECK_IDS = \(([^)]*)\)/s);
  const parsedChecks = checksMatch
    ? [...checksMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
    : null;
  sameList(CHECKER_FILE, 'CHECK_IDS tuple', parsedChecks, CHECKS);
  requireAll(CHECKER_FILE, checkerText, [
    ['schema id', 'SCHEMA_ID = "launch_authorization_v1"'],
    ['unavailable-never-approval discipline', 'never counts as approval'],
    ['silence-is-refusal discipline', 'Silence is refusal'],
    ['single-read plan hash discipline', 'read ONCE'],
    ['shared strict JSON decoder', 'def _loads_json_strict(raw: bytes)'],
    ['recursive duplicate-key rejection', 'object_pairs_hook=_reject_duplicate_json_keys'],
    ['ambiguous-record output refusal', 'RECORD_PARSE_OUTPUT_REFUSAL = ('],
    [
      'ambiguous-record output suppression wiring',
      'output_blocked_reason=RECORD_PARSE_OUTPUT_REFUSAL',
    ],
  ]);
  const jsonLoadCalls = checkerText.match(/json\.loads\(/g) ?? [];
  if (jsonLoadCalls.length !== 1) {
    errors.push(
      `${CHECKER_FILE}: every JSON input must use the shared strict decoder (expected one json.loads call, found ${jsonLoadCalls.length})`,
    );
  }
}

// 5. Operator-facing contract in the skill prose.
const skillText = read(SKILL_FILE);
if (skillText !== null) {
  requireAll(SKILL_FILE, skillText, [
    ['section header', '## Production Launch Authorization (A3 Preflight)'],
    ['checker invocation', 'check_launch_authorization.py'],
    ['result contract name', 'launch_authorization_v1'],
    [
      'verdict enum prose',
      'authorized | invalid_record | missing_plan_hash | stale_review | missing_review | review_rejected | reviewer_unavailable | fingerprint_mismatch',
    ],
    ['unavailable-never-approval discipline', 'Reviewer unavailability is never approval'],
    ['zero-production-output contract', 'zero production output'],
    ['stale-review discipline', 'Editing the plan after review voids the old verdict'],
    ['recursive duplicate-key refusal', 'Duplicate JSON object keys are rejected at every nesting level'],
    [
      'ambiguous-record output suppression',
      'no `--output` file is written at all because its declared input paths cannot be recovered safely',
    ],
  ]);
}

// 6. Negative controls: one test per mismatch class, plus the positive
//    control and the contract-alignment test.
const testsText = read(TESTS_FILE);
if (testsText !== null) {
  requireAll(TESTS_FILE, testsText, [
    ['positive control', 'def test_authorized_when_all_preconditions_hold'],
    ['negative control: missing plan', 'def test_refuses_missing_plan_file'],
    ['negative control: stale review', 'def test_refuses_stale_review_when_plan_edited_after_authorization'],
    ['negative control: missing review', 'def test_refuses_missing_review_verdict'],
    ['negative control: rejection', 'def test_refuses_review_rejected'],
    ['negative control: unavailable reviewer', 'def test_refuses_reviewer_unavailable'],
    ['negative control: fingerprint', 'def test_refuses_fingerprint_value_mismatch'],
    ['negative control: duplicate plan hash', 'def test_duplicate_plan_sha256_is_invalid_record'],
    ['negative control: duplicate verdict', 'def test_duplicate_verdict_never_counts'],
    [
      'negative control: duplicate reviewed plan hash',
      'def test_duplicate_reviewed_plan_sha256_never_counts',
    ],
    [
      'negative control: duplicate observed fingerprint key',
      'def test_duplicate_observed_fingerprint_key_refuses',
    ],
    ['negative control: nested duplicate key', 'def test_nested_duplicate_record_key_is_invalid'],
    [
      'negative control: duplicate record cannot overwrite plan',
      'def test_duplicate_record_suppresses_output_aliasing_declared_plan',
    ],
    [
      'negative control: duplicate record cannot overwrite verdict',
      'def test_duplicate_record_suppresses_output_aliasing_declared_verdict',
    ],
    ['contract alignment', 'def test_verdicts_and_checks_match_schema_contract'],
  ]);
}

// 7. CI still runs the tests and this lock.
const ciText = read(CI_FILE);
if (ciText !== null) {
  requireAll(CI_FILE, ciText, [
    ['pytest wiring', 'skills/research-harness/tests/test_launch_authorization_gate.py'],
    ['anti-drift wiring', 'check-launch-authorization-anti-drift.mjs'],
  ]);
}

if (errors.length > 0) {
  console.error('Launch-authorization anti-drift check FAILED:');
  for (const message of errors) {
    console.error(`  - ${message}`);
  }
  process.exit(1);
}

console.log('Launch-authorization anti-drift check passed.');
