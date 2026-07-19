#!/usr/bin/env node

/**
 * Delegation-budget gate anti-drift CI check.
 *
 * The delegation budget discipline ("a delegated executor's default drift is
 * to refine precision indefinitely and to expand scope; a delegation without
 * explicit budgets is drift by construction — so every delegated computation /
 * verification workstream carries a machine-checked budget contract:
 * tolerance ceiling + anchor note, time box, attempt cap, scope negative
 * list, dry-run peak RSS + heap cap") is enforced by
 * skills/research-team/scripts/gates/check_delegation_budget.py and
 * documented across the research-team and research-harness skill surfaces.
 * A discipline that lives only in prose erodes silently; this lock fails the
 * build when any leg of the contract is removed or renamed:
 *
 *   1. GATE SUBSTANCE. The gate script still carries every falsification
 *      label for the mandated field groups, validates fail-closed on unknown
 *      contract versions and unfilled placeholders, and emits the shared
 *      machine contract via build_gate_meta("delegation_budget").
 *
 *   2. SCHEMA AUTHORITY. meta/schemas/convergence_gate_result_v1.schema.json
 *      keeps "delegation_budget" in the meta.gate_id enum (the gate's
 *      emitted verdict validates against the shared SSOT).
 *
 *   3. RUNNER WIRING. run_team_cycle.sh still validates delegation contracts
 *      at preflight AND persists the machine verdict via --out-json.
 *
 *   4. TEMPLATE. The contract template still ships the five mandated field
 *      groups (an unfilled copy must FAIL the gate — behavior-tested).
 *
 *   5. PROSE + TESTS. The research-team skill still states the
 *      budgets-before-dispatch discipline, the research-harness skill still
 *      states the settle-on-flushed-results + failed-approaches-ledger
 *      budget-exhaustion semantics, and the behavior tests still exist.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GATE_FILE = 'skills/research-team/scripts/gates/check_delegation_budget.py';
const SCHEMA_FILE = 'meta/schemas/convergence_gate_result_v1.schema.json';
const RUNNER_FILE = 'skills/research-team/scripts/bin/run_team_cycle.sh';
const TEMPLATE_FILE = 'skills/research-team/assets/delegation_budget_contract_template.json';
const CONFIG_TEMPLATE_FILE = 'skills/research-team/assets/research_team_config_template.json';
const TEAM_SKILL_FILE = 'skills/research-team/SKILL.md';
const HARNESS_SKILL_FILE = 'skills/research-harness/SKILL.md';
const TESTS_FILE = 'skills/research-team/tests/test_delegation_budget_gate.py';

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
  ['tolerance-ceiling falsification label', 'MISSING_TOLERANCE_CEILING'],
  ['tolerance-value falsification label', 'MISSING_TOLERANCE_VALUE'],
  ['tolerance-anchor falsification label', 'MISSING_TOLERANCE_ANCHOR'],
  ['time-box falsification label', 'MISSING_TIME_BOX'],
  ['max-attempts falsification label', 'MISSING_MAX_ATTEMPTS'],
  ['scope-negative-list falsification label', 'MISSING_SCOPE_NEGATIVE_LIST'],
  ['peak-memory falsification label', 'MISSING_PEAK_MEMORY_ESTIMATE'],
  ['dry-run peak RSS falsification label', 'MISSING_DRY_RUN_PEAK_RSS'],
  ['heap-limit falsification label', 'MISSING_HEAP_LIMIT'],
  ['heap-below-peak falsification label', 'HEAP_LIMIT_BELOW_DRY_RUN_PEAK'],
  ['unfilled-placeholder falsification label', 'PLACEHOLDER_VALUE'],
  ['unknown-version fail-closed label', 'UNSUPPORTED_CONTRACT_VERSION'],
  ['contracts-required falsification label', 'NO_CONTRACTS_FOUND'],
  ['unreadable-contract falsification label', 'UNREADABLE_CONTRACT'],
  ['machine-contract emission', 'build_gate_meta("delegation_budget")'],
  ['executor-drift motivation', 'refine precision indefinitely'],
]);

// 2. Schema authority.
const schemaText = read(SCHEMA_FILE);
if (schemaText !== null) {
  let gateIds = null;
  try {
    const schema = JSON.parse(schemaText);
    gateIds = schema?.properties?.meta?.properties?.gate_id?.enum ?? null;
  } catch (e) {
    errors.push(`${SCHEMA_FILE}: not parseable JSON: ${e.message}`);
  }
  if (gateIds !== null && !gateIds.includes('delegation_budget')) {
    errors.push(`${SCHEMA_FILE}: meta.gate_id enum no longer contains "delegation_budget"`);
  }
}

// 3. Runner wiring — presence is not enough: the enforcement legs (exit on
// gate failure, error on missing gate script) must survive too, or the gate
// silently turns advisory.
const runnerText = read(RUNNER_FILE);
if (runnerText !== null) {
  if (!runnerText.includes('check_delegation_budget.py')) {
    errors.push(`${RUNNER_FILE}: no longer invokes check_delegation_budget.py`);
  }
  const wiringBlock = runnerText.split('check_delegation_budget.py')[1] ?? '';
  if (!wiringBlock.includes('_delegation_budget_gate.json')) {
    errors.push(`${RUNNER_FILE}: delegation budget gate no longer persists its machine verdict via --out-json`);
  }
  if (!wiringBlock.includes('delegation_budget_code} -ne 0')) {
    errors.push(`${RUNNER_FILE}: delegation budget gate exit code is no longer checked (gate turned advisory)`);
  }
  if (!wiringBlock.includes('exit ${delegation_budget_code}')) {
    errors.push(`${RUNNER_FILE}: run no longer aborts on delegation budget gate failure (gate turned advisory)`);
  }
  if (!runnerText.includes('missing delegation budget gate script')) {
    errors.push(`${RUNNER_FILE}: missing-gate-script fail-closed check removed (absent script would silently disable the discipline)`);
  }
}

// 4. Template ships the five mandated field groups.
requireAll(TEMPLATE_FILE, read(TEMPLATE_FILE), [
  ['contract version pin', '"contract_version": 1'],
  ['tolerance ceiling group', '"tolerance_ceiling"'],
  ['tolerance anchor note', '"anchor_note"'],
  ['time box group', '"time_box"'],
  ['max attempts field', '"max_attempts"'],
  ['scope negative list', '"scope_negative_list"'],
  ['peak memory group', '"peak_memory_estimate"'],
  ['dry-run peak RSS field', '"dry_run_peak_rss_mb"'],
  ['heap limit field', '"heap_limit_mb"'],
]);

// Config template keeps the gate discoverable.
requireAll(CONFIG_TEMPLATE_FILE, read(CONFIG_TEMPLATE_FILE), [
  ['feature flag', '"delegation_budget_gate"'],
  ['config block', '"delegation_budget"'],
  ['delegations dir default', '"team/delegations"'],
]);

// 5. Prose + tests.
requireAll(TEAM_SKILL_FILE, read(TEAM_SKILL_FILE), [
  ['budgets-before-dispatch discipline', 'drift by construction'],
  ['tolerance ceiling field', '`tolerance_ceiling`'],
  ['time box field', '`time_box`'],
  ['max attempts field', '`max_attempts`'],
  ['scope negative list field', '`scope_negative_list`'],
  ['peak memory field', '`peak_memory_estimate`'],
  ['gate pointer', 'check_delegation_budget.py'],
]);
requireAll(HARNESS_SKILL_FILE, read(HARNESS_SKILL_FILE), [
  ['settle-on-flushed-results clause', 'it never voids the batch'],
  ['failed-approaches routing for abandoned budgets', 'failed-approaches ledger'],
  ['measured-memory clause', 'Estimating wall-clock alone is not a resource estimate'],
]);

// Behavior tests must exist AND still validate emitted verdicts against the
// shared validator (the leg that catches schema-invalid verdict shapes).
const testsText = read(TESTS_FILE);
requireAll(TESTS_FILE, testsText, [
  ['shared-validator import', 'validate_convergence_result'],
  ['verdict schema assertion helper', '_assert_verdict_valid'],
  ['schema-safe report_status key assertion', 'REPORT_STATUS_KEY_PATTERN'],
]);

// The shared validator must keep enforcing the report_status member key
// pattern from the schema SSOT (the gap that once let path-shaped keys emit
// schema-invalid verdicts while every test stayed green).
requireAll('skills/research-team/scripts/gates/convergence_schema.py',
  read('skills/research-team/scripts/gates/convergence_schema.py'), [
    ['report_status key-pattern authority', 'REPORT_STATUS_KEY_PATTERN'],
    ['patternProperties extraction from SSOT', 'patternProperties'],
    ['key-pattern enforcement message', 'does not match the shared schema'],
  ]);

if (errors.length > 0) {
  console.error('[check-delegation-budget-anti-drift] FAIL');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log('[check-delegation-budget-anti-drift] OK');
