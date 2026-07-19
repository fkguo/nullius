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
  ['single-read strict config authority', 'build_team_config(config_path, strict_raw)'],
  ['resolve-once config binding', 'config_path = config_path.resolve()'],
  ['nonblocking regular-file contract reader', 'def _read_regular_file_text'],
  ['descriptor-verified regular file (no stat/open race)', 'os.fstat(fd)'],
]);
// The gate must never re-read the config leniently after strict validation
// (swap-between-reads would reopen a fail-open hole on a control input).
{
  const gateText = read(GATE_FILE);
  if (gateText !== null && gateText.includes('load_team_config(')) {
    errors.push(`${GATE_FILE}: gate re-reads config via load_team_config (must build from the strict snapshot only)`);
  }
}

// Strict config-parser legs in the shared library.
requireAll('skills/research-team/scripts/lib/team_config.py',
  read('skills/research-team/scripts/lib/team_config.py'), [
    ['strict parser entry point', 'def load_config_object'],
    ['config duplicate-key rejection', '_reject_duplicate_config_keys'],
    ['snapshot-based config assembly', 'def build_team_config'],
  ]);

// 2. Schema authority.
const schemaText = read(SCHEMA_FILE);
if (schemaText !== null) {
  let parsed;
  let parseFailed = false;
  try {
    parsed = JSON.parse(schemaText);
  } catch (e) {
    parseFailed = true;
    errors.push(`${SCHEMA_FILE}: not parseable JSON: ${e.message}`);
  }
  if (!parseFailed) {
    // A literal JSON null (or any non-object) must fail this leg too — a
    // `parsed !== null` guard would silently skip the enum assertion.
    if (parsed === null || typeof parsed !== 'object') {
      errors.push(`${SCHEMA_FILE}: schema is not a JSON object (schema-authority leg broken)`);
    } else {
      const gateIds = parsed?.properties?.meta?.properties?.gate_id?.enum;
      if (!Array.isArray(gateIds)) {
        errors.push(`${SCHEMA_FILE}: meta.gate_id enum missing or structurally moved (schema-authority leg broken)`);
      } else if (!gateIds.includes('delegation_budget')) {
        errors.push(`${SCHEMA_FILE}: meta.gate_id enum no longer contains "delegation_budget"`);
      }
    }
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
  // Bound the wiring block to the delegation-gate section: from the section
  // comment to the next section ("Validate and set up tool-access"), so the
  // stage-guard checks below cannot false-positive on later gates' legitimate
  // exploration handling. Both bounds are themselves pinned: if either marker
  // is reworded, the lock fails loudly instead of silently widening/narrowing
  // the window.
  const SECTION_START = 'Preflight: delegation budget contracts';
  const SECTION_END = 'Validate and set up tool-access';
  if (!runnerText.includes(SECTION_START)) {
    errors.push(`${RUNNER_FILE}: delegation gate section marker ${JSON.stringify(SECTION_START)} missing (wiring-block bound broken)`);
  }
  const afterStart = runnerText.split(SECTION_START)[1] ?? '';
  // The end marker must appear AFTER the start marker — a global includes()
  // would stay green if the end marker moved before the start and the block
  // silently widened.
  if (!afterStart.includes(SECTION_END)) {
    errors.push(`${RUNNER_FILE}: section end marker ${JSON.stringify(SECTION_END)} not found after the start marker (wiring-block bound broken)`);
  }
  const wiringBlock = afterStart.split(SECTION_END)[0] ?? afterStart;
  if (!wiringBlock.trim()) {
    errors.push(`${RUNNER_FILE}: delegation budget wiring block not found after section marker`);
  }
  if (!wiringBlock.includes('_delegation_budget_gate.json')) {
    errors.push(`${RUNNER_FILE}: delegation budget gate no longer persists its machine verdict via --out-json`);
  }
  if (!/delegation_budget_code\}?"?\s+-ne\s+0/.test(wiringBlock)) {
    errors.push(`${RUNNER_FILE}: delegation budget gate exit code is no longer checked (gate turned advisory)`);
  }
  if (!/exit\s+"?\$\{?delegation_budget_code\}?"?/.test(wiringBlock)) {
    errors.push(`${RUNNER_FILE}: run no longer aborts on delegation budget gate failure (gate turned advisory)`);
  }
  if (!runnerText.includes('missing delegation budget gate script')) {
    errors.push(`${RUNNER_FILE}: missing-gate-script fail-closed check removed (absent script would silently disable the discipline)`);
  }
  // The gate must never grow a stage downgrade or stage guard: an incomplete
  // budget on an actual delegation is exactly when executor drift happens.
  // Checking the block from the section comment onward also catches a
  // conditional wrapped around the whole gate invocation.
  if (wiringBlock.includes('should_warn_gate_in_exploration')) {
    errors.push(`${RUNNER_FILE}: delegation budget gate gained an exploration downgrade (must fail fast in every project stage)`);
  }
  if (wiringBlock.includes('PROJECT_STAGE')) {
    errors.push(`${RUNNER_FILE}: delegation budget gate wiring references PROJECT_STAGE (stage-conditional enforcement is forbidden)`);
  }
  if (wiringBlock.includes('PREFLIGHT_ONLY')) {
    errors.push(`${RUNNER_FILE}: delegation budget gate wiring references PREFLIGHT_ONLY (mode-conditional enforcement is forbidden — the gate must brake full cycles too)`);
  }
}

// Default-ON authority: the gate's feature flag must stay default-enabled in
// the shared DEFAULT_CONFIG (a silent default flip would disable enforcement
// for every project that does not set the flag explicitly).
requireAll('skills/research-team/scripts/lib/team_config.py',
  read('skills/research-team/scripts/lib/team_config.py'), [
    ['default-ON feature flag', '"delegation_budget_gate": True'],
    ['delegation_budget config block default', '"delegations_dir": "team/delegations"'],
  ]);

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
  ['strict-snapshot authority regression test', 'test_gate_uses_strict_config_snapshot'],
  ['YAML duplicate-config-key control', 'test_yaml_duplicate_config_key_is_input_error'],
  ['missing-yaml-module control', 'test_yaml_config_without_yaml_module_is_input_error'],
  ['symlink-retarget resolve-once regression', 'test_config_symlink_retarget_between_reads_keeps_original_root'],
  ['nonblocking FIFO contract control', 'test_fifo_contract_entry_fails_without_blocking'],
  ['nonblocking symlink-to-FIFO contract control', 'test_symlink_to_fifo_contract_entry_fails_without_blocking'],
  ['nonblocking FIFO config-loader control', 'test_fifo_config_target_raises_instead_of_blocking'],
  ['nonblocking FIFO out-json control', 'test_fifo_out_json_fails_fast_with_single_verdict'],
  ['active-reader fstat-rejection control', 'test_out_json_fifo_with_active_reader_rejected_by_fstat'],
  ['contract-retarget resolve-once regression', 'test_contract_symlink_retarget_after_discovery_keeps_original_target'],
  ['scan-dir-retarget bind-before-listdir regression', 'test_delegations_dir_symlink_retarget_during_listdir_keeps_original_set'],
  ['fstat-diagnostic assertion in active-reader control', 'assert "not a regular file" in proc.stderr'],
]);

// The hang-guard timeout must live INSIDE the FIFO config-loader control —
// a global needle would stay green if that one test dropped its timeout
// while other tests kept theirs.
{
  const t = read(TESTS_FILE);
  if (t !== null) {
    const fn = (t.split('def test_fifo_config_target_raises_instead_of_blocking')[1] ?? '').split('\ndef ')[0];
    if (!fn.includes('timeout=60')) {
      errors.push(`${TESTS_FILE}: FIFO config-loader control lost its hang-guard timeout=60`);
    }
  }
}

// Strict config loader and verdict writer must stay descriptor-verified and
// nonblocking (a FIFO would otherwise hang preflight with no verdict).
requireAll('skills/research-team/scripts/lib/team_config.py',
  read('skills/research-team/scripts/lib/team_config.py'), [
    ['nonblocking config reader', 'def _read_regular_file_bytes'],
  ]);
requireAll(GATE_FILE, read(GATE_FILE), [
  ['FIFO-safe verdict writer', 'def _write_regular_file_text'],
]);

// The runner's config finder must print the RESOLVED path (the runner
// exports it and derives PROJECT_ROOT from its parent; a lexical path would
// let a symlink retarget pair one tree's config with another tree's
// delegations).
requireAll('skills/research-team/scripts/bin/team_cycle_find_config_path.py',
  read('skills/research-team/scripts/bin/team_cycle_find_config_path.py'), [
    ['resolved-path printing', 'print(str(p.resolve()))'],
  ]);

// The runner-integration brake tests (text lock cannot prove the runner
// actually calls the gate; these do) must survive, with their exploration
// no-downgrade scenario.
requireAll('skills/research-team/tests/test_delegation_budget_runner_integration.py',
  read('skills/research-team/tests/test_delegation_budget_runner_integration.py'), [
    ['exploration no-downgrade brake test', 'test_bad_contract_fails_preflight_even_in_exploration'],
    ['full-cycle brake test (non --preflight-only)', 'test_bad_contract_brakes_full_cycle_before_any_runner'],
    ['symlinked-config target-tree brake test', 'test_symlinked_config_brakes_on_target_tree_contract'],
    ['required-contract brake test', 'test_required_with_no_contract_fails_preflight'],
    ['positive control', 'test_complete_contract_passes_preflight'],
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
