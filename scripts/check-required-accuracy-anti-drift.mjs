#!/usr/bin/env node

/**
 * Required-accuracy anti-drift CI check.
 *
 * An executing agent's default drift is to keep refining a number long after it
 * is accurate enough for its use: the reliability gate's G1 ladder ("refine
 * until it stops moving") and its precision escalation have no natural end,
 * and a strict tolerance always looks like extra rigor. Across several
 * projects this spent computation and review rounds on precision nobody
 * needed, refined error sources that were not the dominant ones, and held
 * correct results out of the record behind gates far stricter than the
 * results' use.
 *
 * The countermeasure is the gate's G0: the strictest accuracy among the
 * quantity's uses is written down first and bounds every tolerance placed on
 * the quantity itself; the error is budgeted by source and only the dominant
 * source is refined; refinement stops when the total error (combined by a
 * stated rule) is at or below the required accuracy; an over-tight tolerance
 * on the quantity is a defect, not rigor, while diagnostic thresholds keep
 * blocking where they are needed to bound the error or validate the method.
 *
 * This lock fails the build when G0 or its back-references in G1/G2 are removed
 * or renamed, when the matrix contract loses the G0 field rule, when the
 * matrix checker or its tests disappear, when the research-team prompts lose
 * their stop-at-required-accuracy sentences, or when the lock or the checker
 * tests are unwired from CI. Matching is whitespace-normalized and scoped to
 * the owning gate item, so a clause cannot survive under an unrelated gate.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKILL_FILE = 'skills/numerical-reliability-gate/SKILL.md';
const CONTRACT_FILE = 'skills/numerical-reliability-gate/references/contract.md';
const CHECKER_FILE = 'skills/numerical-reliability-gate/scripts/check_reliability_matrix.py';
const CHECKER_TESTS = 'skills/numerical-reliability-gate/tests/test_check_reliability_matrix.py';
const MEMBER_A = 'skills/research-team/assets/system_member_a.txt';
const MEMBER_B = 'skills/research-team/assets/system_member_b.txt';
const VERIFIER = 'skills/research-team/assets/system_asymmetric_verifier.txt';
const TEAM_SKILL = 'skills/research-team/SKILL.md';
const CI_FILE = '.github/workflows/ci.yml';
const PACKAGE_FILE = 'package.json';

const errors = [];

function read(relPath) {
  const abs = path.join(repoRoot, relPath);
  if (!existsSync(abs)) {
    errors.push(`file missing: ${relPath}`);
    return null;
  }
  return readFileSync(abs, 'utf-8');
}

function flatten(text) {
  return text.replace(/\s+/g, ' ');
}

/** Slice one "- **G<n> — …**" gate item: from its marker to the next gate item. */
function gateItem(relPath, text, gate) {
  if (text === null) return null;
  const marker = `- **${gate} — `;
  const start = text.indexOf(marker);
  if (start === -1) {
    errors.push(`${relPath}: missing gate item ${JSON.stringify(marker)}`);
    return null;
  }
  const rest = text.slice(start + marker.length);
  const end = rest.indexOf('\n- **G');
  return end === -1 ? rest : rest.slice(0, end);
}

function requireAll(label, text, needles) {
  if (text === null) return;
  const flat = flatten(text);
  for (const [what, needle] of needles) {
    if (!flat.includes(flatten(needle))) {
      errors.push(`${label}: missing ${what}: expected to find ${JSON.stringify(needle)}`);
    }
  }
}

const skill = read(SKILL_FILE);

// 1. G0 owns the rule, and comes before G1.
if (skill !== null) {
  const g0 = skill.indexOf('- **G0 — ');
  const g1 = skill.indexOf('- **G1 — ');
  if (g0 !== -1 && g1 !== -1 && g0 > g1) {
    errors.push(`${SKILL_FILE}: G0 must precede G1 (it sets how far every later check is run)`);
  }
}
requireAll(`${SKILL_FILE} (G0)`, gateItem(SKILL_FILE, skill, 'G0'), [
  ['G0 heading', 'Required accuracy first; refine only the dominant error; stop when the total meets it.**'],
  ['required accuracy written down first', 'write down the **required accuracy** of the quantity and where it comes from'],
  ['every use, strictest governs', 'List every use the quantity serves'],
  ['strictest use', 'and take the **strictest** of them'],
  ['display accuracy is half the last digit', 'about half the last displayed digit'],
  ['method capability is not a source', 'What the method could achieve is never a source.'],
  ['observable, not raw parameters', 'not on raw internal parameters in mixed units'],
  ['error budget by source', '**Budget the error by source.**'],
  ['refine only the dominant source', 'Refine **only the dominant source**'],
  ['subdominant refinement is not progress', 'changes nothing the result depends on and is not progress'],
  ['total error by a stated rule', 'combine them into a **total error** by a stated rule: a linear sum by default, a sum in quadrature only with a one-line reason the sources are independent'],
  ['stop rule on the total error', '**Stop when the total error is at or below the required accuracy.**'],
  ['further refinement needs authorization', 'Refinement past that point needs explicit authorization from the project owner.'],
  ['quantity tolerances bounded', 'A tolerance placed on the quantity itself — a ladder plateau, a cross-check agreement — is set from the required accuracy and no tighter'],
  ['stricter quantity tolerances do not block', 'may be kept as an informational record but may not block acceptance'],
  ['diagnostic thresholds keep blocking', 'stays blocking where that is what it takes to bound the quantity\'s error or to validate the method'],
  ['G0 never demotes diagnostics', 'G0 never demotes it, and G3/G7/G9 keep their thresholds'],
  ['diagnostic rationale recorded', 'recorded in the matrix as `threshold_basis`'],
  ['over-tight gate is a defect', '**an over-tight gate is a defect, just as a loose one is**'],
  ['unknown target comes first', 'the first deliverable is that accuracy and its source, not more digits'],
]);

// 2. G1 and G2 are bounded by G0.
requireAll(`${SKILL_FILE} (G1)`, gateItem(SKILL_FILE, skill, 'G1'), [
  ['ladder bounded by G0', '**The ladder runs to the G0 required accuracy, not to the last digit.**'],
  ['refinement only for the dominant source above target', 'owed only when that knob is the dominant error source and the total error is still above the required accuracy'],
]);
requireAll(`${SKILL_FILE} (G2)`, gateItem(SKILL_FILE, skill, 'G2'), [
  ['cross-check tolerance bounded by G0', 'set from the G0 required accuracy and no tighter than it'],
]);

// 3. The foldable verdict includes G0, and the recorded failure modes stay.
requireAll(`${SKILL_FILE} (output and provenance)`, skill, [
  ['reliable requires G0', '`reliable` requires every *applicable* G0–G10 check to pass — including the G0 total error at or below the required accuracy'],
  ['G6 folds only G0–G10 passes', 'passed every applicable G0–G10 check at the converged setting'],
  ['over-tight gate episode', 'some six orders of magnitude tighter than the declared target accuracy'],
  ['subdominant refinement episode', 'the agent kept tightening the integration precision'],
  ['display-held episode', 'held out of a manuscript for three review re-entries'],
]);

// 4. The matrix contract carries G0 as a field rule, the example uses it, and the checker is named.
requireAll(CONTRACT_FILE, read(CONTRACT_FILE), [
  ['G0 field rule', '**G0 required accuracy, error budget and total error (every row)**'],
  ['method capability is not a source', 'What the method could achieve is never a source.'],
  ['strictest use governs', '`required_accuracy.value` MUST equal the smallest use value (the strictest use governs)'],
  ['exactly one dominant source', '**exactly one** entry marked `dominant: true`'],
  ['quadrature needs independence basis', '`quadrature` (a one-line `basis` stating why the sources are independent is then required)'],
  ['reliable needs total within target', 'A `reliable` row requires every estimate to be numeric and the total error to be at or below the required accuracy'],
  ['quantity tolerances informational when stricter', 'a stricter one is recorded in `notes` as informational and does not block the verdict'],
  ['diagnostic thresholds keep blocking', 'carries that rationale, and keeps blocking'],
  ['diagnostic rationale machine-readable', 'a present (non-null) `invariant_check` or `method_precondition` value must be an object carrying a non-empty one-line `threshold_basis`'],
  ['understated totals refused exactly', 'checked exactly, so a total rounded down is refused (round a quadrature total up)'],
  ['declared exact range', 'within that range every comparison is exact (exact rationals; a quadrature total is compared through squares)'],
  ['example diagnostic carries its basis', '"threshold_basis": "integrality consistency only'],
  ['example error from the ladder, not the integer residual', 'From the refinement ladder, NOT from closeness to an integer'],
  ['example carries total_error', '"total_error": {'],
  ['example carries required_accuracy', '"required_accuracy": {'],
  ['example carries error_budget', '"error_budget": ['],
  ['checker named', 'scripts/check_reliability_matrix.py'],
  ['reliable verdict covers G0', 'passed **every applicable** G0–G10 check at the converged setting — including the G0 total error at or below the required accuracy'],
]);

// 5. The checker enforces the rules it is documented to enforce.
requireAll(CHECKER_FILE, read(CHECKER_FILE), [
  ['missing required accuracy finding', 'MISSING_REQUIRED_ACCURACY'],
  ['total above target finding', 'TOTAL_ERROR_ABOVE_REQUIRED_ACCURACY'],
  ['total understated finding', 'TOTAL_ERROR_BELOW_ITS_RULE'],
  ['strictest-use finding', 'REQUIRED_ACCURACY_NOT_STRICTEST'],
  ['diagnostic-basis finding', 'DIAGNOSTIC_WITHOUT_BASIS'],
  ['exact decimal reading', 'parse_float=Decimal'],
  ['exact rational linear sum', 'combined = sum(values, Fraction(0))'],
  ['quadrature compared through squares', 'understated = reported * reported < combined_sq'],
  ['declared magnitude range', '_MIN_MAGNITUDE = Decimal("1e-300")'],
  ['dominant must be largest finding', 'DOMINANT_NOT_LARGEST'],
  ['over-refinement warning', 'REFINED_PAST_REQUIRED_ACCURACY'],
  ['allowed accuracy sources', 'ACCURACY_SOURCES = frozenset({"display", "downstream_sensitivity", "comparison_uncertainty"})'],
]);
requireAll(CHECKER_TESTS, read(CHECKER_TESTS), [
  ['contract example is checked', 'def test_contract_example_matrix_satisfies_the_checker'],
  ['aggregate-error counterexample test', 'def test_stop_rule_uses_the_total_error_not_only_the_dominant_source'],
  ['strictest-use test', 'def test_required_accuracy_is_the_strictest_use'],
  ['rounding-allowance test', 'def test_rounding_allowance_cannot_reverse_the_verdict'],
  ['tiny-addend test', 'def test_tiny_addends_are_never_rounded_away'],
  ['quadrature-underflow test', 'def test_quadrature_of_tiny_estimates_does_not_underflow'],
  ['diagnostic-basis test', 'def test_diagnostic_threshold_needs_a_machine_readable_basis'],
]);

// 6. The research-team prompts carry the stop-at-required-accuracy instruction.
requireAll(MEMBER_A, read(MEMBER_A), [
  ['member A stop sentence', 'Do not request precision beyond what the result\'s use requires (numerical-reliability-gate G0)'],
]);
requireAll(MEMBER_B, read(MEMBER_B), [
  ['member B stop sentence', 'Precision stops at the required accuracy (numerical-reliability-gate G0)'],
  ['member B over-tight finding', 'report any gate stricter than that accuracy as a finding (an over-tight gate), never as a reason to refine further'],
]);
requireAll(VERIFIER, read(VERIFIER), [
  ['verifier judges against required accuracy', 'Judge "appropriate" against the accuracy the result\'s use requires (numerical-reliability-gate G0)'],
  ['older challenge rule yields to required accuracy', 'this is a CHALLENGED verdict, unless the method already meets the required accuracy below'],
]);
requireAll(TEAM_SKILL, read(TEAM_SKILL), [
  ['tolerance ceiling is G0 on delegation', 'This ceiling is the delegation-side form of the `numerical-reliability-gate` G0 required accuracy'],
]);

// 7. CI wiring: the lock and the checker tests still run.
requireAll(CI_FILE, read(CI_FILE), [
  ['CI step for this lock', 'node scripts/check-required-accuracy-anti-drift.mjs'],
  ['CI step for the checker tests', 'python -m pytest skills/numerical-reliability-gate/tests -q'],
]);
requireAll(PACKAGE_FILE, read(PACKAGE_FILE), [
  ['package script for this lock', '"check:required-accuracy-anti-drift": "node scripts/check-required-accuracy-anti-drift.mjs"'],
]);

if (errors.length > 0) {
  console.error('[check-required-accuracy-anti-drift] FAIL');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log('[check-required-accuracy-anti-drift] OK');
