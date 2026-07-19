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
    const authorizedBranch = (schema.allOf ?? []).find(
      (clause) => clause?.if?.properties?.verdict?.const === 'authorized',
    );
    if (authorizedBranch?.then?.properties?.exit_code?.const !== 0) {
      errors.push(`${RESULT_SCHEMA_FILE}: allOf must bind verdict "authorized" to exit_code 0`);
    }
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

// 3. Registry SSOT still carries the constants and wires them into A3.
const registryText = read(REGISTRY_FILE);
if (registryText !== null) {
  requireAll(REGISTRY_FILE, registryText, [
    ['result-schema constant', "LAUNCH_AUTHORIZATION_RESULT_SCHEMA = 'launch_authorization_v1'"],
    ['A3 policy wiring', 'launch_authorization: {'],
    ['A3 policy result schema', 'result_schema: LAUNCH_AUTHORIZATION_RESULT_SCHEMA'],
    ['A3 policy checks', 'required_checks: LAUNCH_AUTHORIZATION_CHECKS'],
    ['policy accessor', 'export function getLaunchAuthorizationPolicy('],
    ...VERDICTS.map((verdict) => [`verdict '${verdict}'`, `'${verdict}',`]),
    ...CHECKS.map((check) => [`check '${check}'`, `'${check}',`]),
  ]);
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
  ]);
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
