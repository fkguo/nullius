#!/usr/bin/env node

/**
 * Rendered-field continuity anti-drift CI check.
 *
 * A figure that renders a computed field can look smooth everywhere and
 * still carry hard neighbour-to-neighbour jumps produced by the evaluator
 * rather than by the quantity — a threshold inside the evaluator that
 * switches the size of the working problem, a code path that flips, a cell
 * left from an earlier run. Visual inspection is exactly the wrong
 * instrument: the eye certifies the smooth majority and reads an isolated
 * jump as texture, so the wrong values travel on into tables and
 * conclusions. The countermeasure is mechanical and pre-delivery — scan
 * neighbour differences across the whole raster before the figure is
 * presented as delivered, report the worst delta, and treat any jump away
 * from a declared singularity as a defect to trace rather than a caption to
 * write. This lock fails the build when any leg of that discipline is
 * removed, renamed, or softened:
 *
 *   1. figure-hygiene: the Data Fidelity rule (continuity premise, whole-
 *      raster scan, pre-delivery timing, worst-delta reporting, trace-not-
 *      annotate consequence, smooth-rendering-hides motivation), the
 *      matching Anti-Patterns entry, and the description surface that makes
 *      the rule discoverable.
 *
 *   2. numerical-reliability-gate: the recorded failure mode that produced
 *      the rule, still pointing at the figure-side obligation.
 *
 *   3. CI wiring: this lock still runs.
 *
 * Matching is whitespace-normalized, so re-wrapping a paragraph does not
 * trip the lock; changing the words does.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIGURE_SKILL_FILE = 'skills/figure-hygiene/SKILL.md';
const NUMERICAL_SKILL_FILE = 'skills/numerical-reliability-gate/SKILL.md';
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
 * Slice a "## Heading" section out of a Markdown file, so a rule cannot
 * satisfy the lock by surviving somewhere unrelated in the same file.
 */
function section(relPath, text, heading) {
  if (text === null) return null;
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) {
    errors.push(`${relPath}: missing section heading ${JSON.stringify(heading)}`);
    return null;
  }
  const rest = text.slice(start + heading.length + 2);
  const end = rest.indexOf('\n## ');
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

const figureSkill = read(FIGURE_SKILL_FILE);

// 1. figure-hygiene: the rule itself, inside Data Fidelity.
requireAll(
  `${FIGURE_SKILL_FILE} (## Data Fidelity)`,
  section(FIGURE_SKILL_FILE, figureSkill, '## Data Fidelity'),
  [
    ['rule heading', '- **Rendered-field continuity.**'],
    ['continuity premise', 'continuous across the plotted domain except at declared singularities'],
    ['whole-raster neighbour scan', 'scan neighbour-to-neighbour differences across the whole raster'],
    ['pre-delivery timing', '**before the figure is presented as delivered**'],
    ['worst-delta reporting', 'report the worst delta together with the scan'],
    ['trace-to-mechanism consequence', 'is a defect to trace to its mechanism'],
    ['evaluator-threshold mechanism example', 'a threshold inside the evaluator that switches the size of the working problem'],
    ['annotation is not a fix', '**never an annotation to write on the figure**'],
    ['mechanical-and-precedes-presentation', 'The scan is mechanical, and precedes presentation'],
    ['smooth-rendering-hides-it motivation', 'a smooth-looking rendering is what hides such a defect'],
  ],
);

// 2. figure-hygiene: the matching anti-pattern entry.
requireAll(
  `${FIGURE_SKILL_FILE} (## Anti-Patterns)`,
  section(FIGURE_SKILL_FILE, figureSkill, '## Anti-Patterns'),
  [
    [
      'continuity anti-pattern entry',
      'A neighbour-to-neighbour jump in a rendered field, away from any declared singularity, annotated on the figure instead of traced to its mechanism.',
    ],
  ],
);

// 3. figure-hygiene: the rule is advertised on the discovery surface.
requireAll(`${FIGURE_SKILL_FILE} (description)`, figureSkill, [
  ['description coverage clause', 'a rendered continuous field is continuity-scanned before delivery'],
]);

// 4. numerical-reliability-gate: the failure mode that produced the rule.
requireAll(NUMERICAL_SKILL_FILE, read(NUMERICAL_SKILL_FILE), [
  ['recorded jump-versus-smooth evidence', 'isolated neighbour-to-neighbour jumps'],
  ['declared-singularity contrast', 'including across its genuinely declared singularities'],
  ['traced mechanism', '**discrete acceptance threshold inside the evaluator**'],
  ['verdict-reversal consequence', 'reversed the verdict the table was built to deliver'],
  ['pointer to the figure-side obligation', '`figure-hygiene` (*rendered-field continuity*)'],
]);

// 5. CI wiring: the lock still runs.
requireAll(CI_FILE, read(CI_FILE), [
  ['CI step for this lock', 'node scripts/check-rendered-field-continuity-anti-drift.mjs'],
]);

if (errors.length > 0) {
  console.error('[check-rendered-field-continuity-anti-drift] FAIL');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log('[check-rendered-field-continuity-anti-drift] OK');
