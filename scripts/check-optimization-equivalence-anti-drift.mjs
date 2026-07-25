#!/usr/bin/env node

/**
 * Optimization-equivalence anti-drift CI check.
 *
 * Benchmark evidence answers "is it faster", never "is it the same
 * computation". An accelerated, reorganized, batched, cached, or otherwise
 * restructured implementation is derived on the typical case, and a green
 * test suite only exercises the inputs someone thought of — so a fast path
 * can replace a reference one and silently change the answer on the
 * configurations nobody benchmarked. The countermeasure is an identity
 * check against the verbatim reference, to near machine precision, over the
 * full domain of intended use including the edge configurations the fast
 * path was not designed around, with the measured agreement stated. This
 * lock fails the build when any leg of that gate is removed or renamed:
 *
 *   1. julia-perf: the equivalence gate section (identity against the
 *      verbatim reference, stated measured agreement, full-domain coverage
 *      including untargeted edge configurations, re-run on change), the
 *      hard-fail protocol entry that makes it binding at review, the
 *      correctness cross-reference, and the description surface that makes
 *      the gate discoverable.
 *
 *   2. The cross-referenced sibling skill still exists, so the correctness
 *      hand-off does not dangle.
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

const SKILL_FILE = 'skills/julia-perf/SKILL.md';
const SIBLING_SKILL_FILE = 'skills/numerical-reliability-gate/SKILL.md';
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
 * Slice a "### Heading" subsection out of a Markdown file, so a clause
 * cannot satisfy the lock by surviving somewhere unrelated in the file.
 */
function subsection(relPath, text, heading) {
  if (text === null) return null;
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) {
    errors.push(`${relPath}: missing subsection heading ${JSON.stringify(heading)}`);
    return null;
  }
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(/\n#{2,3} /);
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
const GATE_HEADING = '### Equivalence gate (an accelerated path must compute the same thing)';

// 1. julia-perf: the equivalence gate itself.
requireAll(
  `${SKILL_FILE} (${GATE_HEADING})`,
  subsection(SKILL_FILE, skill, GATE_HEADING),
  [
    ['speed-is-not-correctness motivation', 'Speed evidence says nothing about *what* was computed'],
    ['derived-on-the-typical-case motivation', 'a restructured implementation is derived on the typical case'],
    ['restructuring vocabulary', 'accelerated, reorganized, batched, cached, or otherwise restructured implementation'],
    ['replacement trigger', 'may replace a reference one'],
    ['identity requirement', '**identity against the verbatim reference**'],
    ['near-machine-precision requirement', 'to near machine precision'],
    ['stated agreement requirement', '**state the measured agreement**'],
    ['agreement metric', 'worst relative deviation over the compared set'],
    ['green-suite is not evidence', '"It is faster and the suite is green" is not that evidence'],
    ['full-domain requirement', '**full domain of intended use**'],
    ['benchmark inputs are not the domain', 'not merely the typical inputs used for benchmarking'],
    ['edge-configuration requirement', '**edge configurations the fast path was not designed around**'],
    ['measured agreement from the recorded case', '~1e-16'],
    ['later-use consequence', 'would have left the later use unverified'],
    ['re-run on change', 'Re-run the identity when either implementation changes'],
    ['scope boundary', 'This gate covers only the identity between the two implementations'],
    ['correctness cross-reference', '[`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md)'],
    ['heuristic-fast-path hand-off', 'its G10 governs the other case'],
  ],
);

// 2. julia-perf: binding at review, and discoverable from the description.
requireAll(SKILL_FILE, skill, [
  ['hard-fail protocol entry', '- an accelerated path adopted without the equivalence evidence below'],
  ['description coverage clause', 'gate an accelerated implementation as an identity against its verbatim reference over the full domain of intended use'],
]);

// 3. The correctness hand-off target still exists.
read(SIBLING_SKILL_FILE);

// 4. CI wiring: the lock still runs.
requireAll(CI_FILE, read(CI_FILE), [
  ['CI step for this lock', 'node scripts/check-optimization-equivalence-anti-drift.mjs'],
]);

if (errors.length > 0) {
  console.error('[check-optimization-equivalence-anti-drift] FAIL');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log('[check-optimization-equivalence-anti-drift] OK');
