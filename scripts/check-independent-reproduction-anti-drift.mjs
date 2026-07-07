#!/usr/bin/env node

/**
 * Independent-reproduction gate anti-drift CI check.
 *
 * The shared-kernel-inheritance discipline ("two reproductions that import /
 * include the same kernel are not independent; disagreement is resolved by
 * tracing divergence, never by majority vote") is enforced by
 * skills/research-team/scripts/gates/check_independent_reproduction.py and
 * documented in the research-team skill surfaces. A discipline that lives
 * only in prose erodes silently; this lock fails the build when any leg of
 * the contract is removed or renamed:
 *
 *   1. GATE SUBSTANCE. The gate script still carries the falsification
 *      labels (SHARED_KERNEL_INHERITANCE, MISSING_INDEPENDENT_ARTIFACT,
 *      UNVERIFIABLE_INDEPENDENCE), the `not_independent` verdict token, the
 *      scan entry points, and emits the shared machine contract via
 *      build_gate_meta("independent_reproduction").
 *
 *   2. SCHEMA AUTHORITY. meta/schemas/convergence_gate_result_v1.schema.json
 *      keeps "independent_reproduction" in the meta.gate_id enum (the gate's
 *      emitted verdict validates against the shared SSOT).
 *
 *   3. RUNNER WIRING. run_team_cycle.sh still wires the gate into the
 *      full_access postflight AND persists the machine verdict via
 *      --out-json.
 *
 *   4. PROSE + TESTS. The research-team SKILL.md still states the
 *      trace-divergence-not-majority discipline, and the behavior tests for
 *      the gate still exist.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GATE_FILE = 'skills/research-team/scripts/gates/check_independent_reproduction.py';
const SCHEMA_FILE = 'meta/schemas/convergence_gate_result_v1.schema.json';
const RUNNER_FILE = 'skills/research-team/scripts/bin/run_team_cycle.sh';
const SKILL_FILE = 'skills/research-team/SKILL.md';
const TESTS_FILE = 'skills/research-team/tests/test_independent_reproduction_gate.py';

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
  ['shared-kernel falsification label', 'SHARED_KERNEL_INHERITANCE'],
  ['artifact-presence falsification label', 'MISSING_INDEPENDENT_ARTIFACT'],
  ['unverifiable-independence fail-closed label', 'UNVERIFIABLE_INDEPENDENCE'],
  ['not_independent verdict token', '"not_independent"'],
  ['declared-kernel scan entry point', 'def _scan_declared_kernels'],
  ['cross-member shared-kernel scan entry point', 'def _scan_shared_kernel'],
  ['machine-contract emission', 'build_gate_meta("independent_reproduction")'],
  ['trace-divergence resolution discipline', 'never settle a disagreement by majority vote'],
]);

// 2. Schema authority.
const schemaText = read(SCHEMA_FILE);
if (schemaText !== null) {
  let gateIds = [];
  try {
    const schema = JSON.parse(schemaText);
    gateIds = schema?.properties?.meta?.properties?.gate_id?.enum ?? [];
  } catch (e) {
    errors.push(`${SCHEMA_FILE}: not parseable as JSON: ${e.message}`);
  }
  if (!gateIds.includes('independent_reproduction')) {
    errors.push(
      `${SCHEMA_FILE}: meta.gate_id enum ${JSON.stringify(gateIds)} no longer contains ` +
      `"independent_reproduction" — the gate's emitted verdict would fail schema validation.`,
    );
  }
}

// 3. Runner wiring.
requireAll(RUNNER_FILE, read(RUNNER_FILE), [
  ['postflight gate wiring', 'independent_reproduction_gate:${GATES_DIR}/check_independent_reproduction.py'],
  ['persisted machine verdict', '--out-json "${run_dir}/independent_reproduction_gate.json"'],
]);

// 4. Prose + tests.
requireAll(SKILL_FILE, read(SKILL_FILE), [
  ['reproduction-independence contract bullet', 'Reproduction independence ('],
  ['shared-kernel criterion', 'SHARED_KERNEL_INHERITANCE'],
  ['trace-divergence discipline', 'never settle a disagreement by majority vote'],
]);
// The tests must keep asserting the discipline, not merely exist: a stubbed
// scan returning [] with the labels left in comments would keep the substring
// checks above green, but cannot survive tests that demand FAIL verdicts.
requireAll(TESTS_FILE, read(TESTS_FILE), [
  ['shared-kernel FAIL assertions', 'SHARED_KERNEL_INHERITANCE'],
  ['unverifiable-independence FAIL assertion', 'UNVERIFIABLE_INDEPENDENCE'],
  ['not_independent verdict assertions', '"not_independent"'],
  ['K2 shared project-local module scenario', 'def test_shared_project_local_python_module_fails_both'],
  ['K3 shared include-by-path scenario', 'def test_shared_include_path_fails_both'],
]);

if (errors.length > 0) {
  process.stderr.write('[independent-reproduction-drift] anti-drift check failed:\n\n');
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.stderr.write(
    '\nThe shared-kernel independence discipline is load-bearing: restore the contract ' +
    '(gate labels, schema gate_id, runner wiring, SKILL.md prose, tests) rather than ' +
    'softening this check.\n',
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    '[ok] independent-reproduction gate contract intact: gate substance, schema gate_id, ' +
    'runner wiring, SKILL.md discipline, and behavior tests all present.\n',
  );
}
