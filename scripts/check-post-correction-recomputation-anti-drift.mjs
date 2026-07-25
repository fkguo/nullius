#!/usr/bin/env node

/**
 * Post-correction recomputation anti-drift CI check.
 *
 * Fixing the defect is the cheap half; the expensive half is that every
 * result already computed through the broken path is now wrong. The
 * observed default is to leave those results in place under a status
 * caveat — the caveat stays with the prose while the number travels on
 * alone, and a table nobody can split into pre-fix and post-fix rows reads
 * as current truth. The obligation is recomputation, plus an explicit
 * statement of which results were recomputed and which were provably
 * unaffected and why. This lock also covers the two acceptance clauses a
 * computed feature has to clear before it is admitted to that same record:
 * a cheap exact identity carried per evaluation rather than checked once,
 * and an artifact-family enumeration showing the discretization did not
 * manufacture the feature. It fails the build when any of them is removed
 * or renamed:
 *
 *   1. numerical-reliability-gate G6: recompute-never-relabel, the
 *      recomputed-versus-provably-unaffected record, and the fail-closed
 *      mixed-table consequence.
 *
 *   2. numerical-reliability-gate G3: the per-evaluation certificate and
 *      the discretization-artifact-family enumeration.
 *
 *   3. The recorded failure mode that produced the G6 clause, and the
 *      matrix contract field rule that has to carry the evidence.
 *
 *   4. CI wiring: this lock still runs.
 *
 * Matching is whitespace-normalized (a re-wrap does not trip the lock) and
 * scoped to the owning gate item, so a clause cannot satisfy the lock by
 * surviving under an unrelated gate.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKILL_FILE = 'skills/numerical-reliability-gate/SKILL.md';
const CONTRACT_FILE = 'skills/numerical-reliability-gate/references/contract.md';
const CI_FILE = '.github/workflows/ci.yml';

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

/**
 * Slice one "- **G<n> — …**" gate item out of the gate list: from its
 * marker to the start of the next gate item.
 */
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

// 1. G6: recompute downstream after a correction; say which rows are which.
requireAll(`${SKILL_FILE} (G6)`, gateItem(SKILL_FILE, skill, 'G6'), [
  ['recomputation clause heading', '**After a correction, recompute downstream — never relabel.**'],
  ['upstream-defect trigger', 'When a defect is found in anything upstream of already-accepted results'],
  ['downstream scope', 'table rows, folded numbers, rendered figures'],
  ['recompute-not-relabel obligation', 'must be **recomputed**, not relabelled, caveated, or annotated in place'],
  ['explicit recomputed-versus-unaffected record', '**which results were recomputed after the fix and which were provably unaffected, with the reason**'],
  ['fail-closed mixed-table consequence', 'mixes pre-fix and post-fix rows without saying which is which fails closed (`stale_artifact`)'],
  ['why a caveat does not travel', 'the caveat stays with the prose while the number travels on alone'],
  ['distinction from the pre-variation anchor', 'this is the obligation that falls due *after* one'],
]);

// 2. G3: per-evaluation certificate + discretization artifact family.
requireAll(`${SKILL_FILE} (G3)`, gateItem(SKILL_FILE, skill, 'G3'), [
  ['per-call identity clause heading', '**Evaluate a cheap exact identity on every call, not once.**'],
  ['two admissible configurations', 'an exact identity relates two admissible configurations of the same computation'],
  ['every-call requirement', 'evaluate it on **every call**'],
  ['certificate carried with the result', 'carry its residual with the result as a **per-evaluation certificate**'],
  ['once-checked is not enough', 'Checked once at development time it certifies one configuration on one day'],
  ['catches the lapsing run', 'catches the run where the identity lapses'],
  ['artifact-family clause heading', "**Rule out the discretization's own look-alikes before accepting a feature.**"],
  ['discrete-feature scope', 'a root, a mode, a peak'],
  ['artifact-family enumeration', '**artifact family the discretization itself can generate**'],
  ['artifact sources', 'a finite basis, a truncation order, a sampling grid, or a boundary treatment'],
  ['non-membership requirement', 'show the accepted feature is **not a member of it**'],
  ['change-the-discretization test', 'survives when the discretization that generates those look-alikes is changed'],
  ['invariant does not settle it', '"an invariant found it" does not settle the question'],
]);

// 3. The recorded failure mode that produced the G6 clause.
requireAll(`${SKILL_FILE} (recorded failure modes)`, skill, [
  ['stale rows left in the delivered table', '**stayed in the delivered table under a status caveat**'],
  ['stale figures still presented', 'figures rendered with the broken path were still presented as delivered'],
  ['recomputation-not-relabelling lesson', 'a correction upstream obliges *recomputation* downstream, not relabelling'],
  ['record must name the affected rows', 'the record had to say which rows those were'],
]);

// 4. The matrix contract carries the obligation as a field rule.
requireAll(CONTRACT_FILE, read(CONTRACT_FILE), [
  ['contract field rule', '- **G6 post-correction recomputation (when applicable)**'],
  ['recompute obligation', 'every affected row MUST be **recomputed**'],
  ['explicit recomputed-versus-unaffected record', 'MUST state which rows were recomputed after the fix and which were **provably unaffected, with the reason**'],
  ['caveat-only row stays stale', 'A pre-fix row carrying only a status caveat stays `stale_artifact`'],
  ['mixed table is not foldable', 'mixes pre-fix and post-fix rows without saying which is which is not foldable'],
]);

// 5. CI wiring: the lock still runs.
requireAll(CI_FILE, read(CI_FILE), [
  ['CI step for this lock', 'node scripts/check-post-correction-recomputation-anti-drift.mjs'],
]);

if (errors.length > 0) {
  console.error('[check-post-correction-recomputation-anti-drift] FAIL');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log('[check-post-correction-recomputation-anti-drift] OK');
