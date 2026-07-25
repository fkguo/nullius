#!/usr/bin/env node

/**
 * Knob-threading anti-drift CI check.
 *
 * A convergence ladder and an orthogonal-method cross-check both certify a
 * number only if they can actually see the setting they are testing. Two
 * ways they silently cannot:
 *
 *   1. THE KNOB NEVER REACHED THE COMPUTATION (G1). A ladder whose steps
 *      return bit-identical values did not refine anything — the knob was
 *      read once at load time, frozen in a cached configuration, or
 *      overridden by a default in the consuming stage. Read as a plateau,
 *      that ladder certifies an arbitrary setting as converged. The
 *      countermeasure is to treat identical values across a ladder step as
 *      a threading failure to diagnose, and to confirm with a cheap
 *      positive control that the knob-sensitive intermediate really differs
 *      between steps.
 *
 *   2. THE CROSS-CHECK INHERITED THE SUSPECT SETTING (G2). When a specific
 *      setting is what is in doubt, a second route that shares that setting
 *      is non-diagnostic for it however different its implementation is:
 *      both routes presuppose the quantity in question, so their agreement
 *      measures the shared setting instead of testing it.
 *
 * This lock fails the build when either clause is removed or renamed from
 * the gate item that owns it, from the recorded failure modes that produced
 * them, or from the matrix contract that has to carry the evidence — and
 * when the lock itself is unwired from CI.
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

// 1. G1: a ladder is evidence only if the knob reached the computation.
requireAll(`${SKILL_FILE} (G1)`, gateItem(SKILL_FILE, skill, 'G1'), [
  ['threading clause heading', '**A ladder is evidence only if the knob demonstrably changed what was computed.**'],
  ['bit-identical signature', 'Bit-identical values across nominally different settings mean the knob is **not threading**'],
  ['threading failure mechanisms', 'read once at load time, frozen in a cached configuration, or silently overridden by a default in the stage that consumes it'],
  ['diagnose-not-convergence consequence', '**threading failure to diagnose, not as convergence**'],
  ['plateau definition', 'a plateau is values that *stop moving*, never values that never moved'],
  ['cheap positive control', 'the intermediate quantity most sensitive to the knob actually differs between ladder steps'],
  ['positive control precedes the reading', 'before the ladder is read at all'],
]);

// 2. G2: independence must hold in the setting under suspicion.
requireAll(`${SKILL_FILE} (G2)`, gateItem(SKILL_FILE, skill, 'G2'), [
  ['suspect-setting clause heading', '**Independence must also hold in the setting under suspicion.**'],
  ['what counts as a suspect setting', 'an under-resolved knob, a truncation order, an extraction window'],
  ['inherited-setting consequence', 'a cross-check that inherits that same setting is **non-diagnostic for it**'],
  ['implementation difference is not enough', 'however different the two implementations are'],
  ['why agreement is uninformative', 'their agreement measures the shared setting rather than testing it'],
  ['required repair', 'Vary the suspect setting in at least one route'],
  ['non-diagnostic record form', 'record the check as "agree, but cannot resolve `<the setting under suspicion>`"'],
]);

// 3. The recorded failure modes that produced both clauses.
requireAll(`${SKILL_FILE} (recorded failure modes)`, skill, [
  ['ladder-ran-one-setting-twice evidence', 'silently **ran one setting twice**'],
  ['bit-identical values exposed it', 'anomalously bit-identical values were the only thing that exposed it'],
  ['arbitrary-resolution consequence', 'would have certified an arbitrary resolution as converged'],
  ['shared-suspect-knob cross-check evidence', '**same under-resolved value of the very knob whose adequacy was in question**'],
  ['confirmed-nothing consequence', 'confirmed nothing about the setting under suspicion'],
]);

// 4. The matrix contract carries both as field rules.
requireAll(CONTRACT_FILE, read(CONTRACT_FILE), [
  ['bit-identical ladder entries rejected', 'Two `refinement` entries whose `value`s are **bit-identical** do not establish a plateau either'],
  ['threading-failure diagnosis required', 'Diagnose the threading failure'],
  ['knob-sensitive intermediate recorded', 'record the knob-sensitive intermediate that actually differs between the settings'],
  ['converged gated on the diagnosis', 'before `converged` may be `true`'],
  ['suspect-setting independence rule', 'Independence must also hold **in the setting under suspicion**'],
  ['inherited-setting entries do not agree', 'does **not** set `methods_agree` for that setting'],
]);

// 5. CI wiring: the lock still runs.
requireAll(CI_FILE, read(CI_FILE), [
  ['CI step for this lock', 'node scripts/check-knob-threading-anti-drift.mjs'],
]);

if (errors.length > 0) {
  console.error('[check-knob-threading-anti-drift] FAIL');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log('[check-knob-threading-anti-drift] OK');
