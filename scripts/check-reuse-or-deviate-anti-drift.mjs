#!/usr/bin/env node

/**
 * Reuse-or-deviate gate anti-drift CI check.
 *
 * When a delegation brief names prior art (an upstream toolkit routine, a
 * sibling project's implementation of the same end-to-end problem, a
 * published method), reuse instructions that live only in prose do not
 * survive delegation: an executor satisfies the acceptance gates, not the
 * prose around them, and rewriting from scratch is cheaper for an agent
 * than understanding foreign code — so the observed default is a silent
 * pivot to bespoke code with an inapplicability justification written only
 * afterwards by the same invested party. The countermeasure is a
 * review-enforced per-asset either/or obligation (call-site evidence, or a
 * pre-implementation deviation record followed by a stop for approval),
 * an architecture-first definition of what a reuse scan is, and a
 * reviewer-side ordering rule (verify the binding before assessing
 * results). This lock fails the build when any leg of that discipline is
 * removed or renamed from the skill surfaces that state it:
 *
 *   1. research-team: the reuse-or-deviate gate section (per-asset
 *      either/or obligation, stop-before-replacement, post-hoc deviation
 *      quarantine, architecture-first scan) and the prior-art-binding
 *      reviewer contract in the non-negotiables list.
 *
 *   2. research-integrity: the M8 prior-art sign, the architecture-level
 *      scan deliverable, and the reviewer-side call-sites-before-results
 *      check, cross-referenced to the research-team gate.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEAM_SKILL_FILE = 'skills/research-team/SKILL.md';
const INTEGRITY_SKILL_FILE = 'skills/research-integrity/SKILL.md';

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

// 1. research-team: dispatch-side gate + reviewer contract.
requireAll(TEAM_SKILL_FILE, read(TEAM_SKILL_FILE), [
  ['gate section heading', '## Reuse-or-deviate gate'],
  ['prose-does-not-bind motivation', 'do not survive delegation'],
  ['rewrite-cheaper failure mode', 'cheaper for an agent than understanding foreign'],
  ['per-asset either/or obligation', 'for each named asset, exactly one of'],
  ['call-site evidence leg', '**call-site evidence**'],
  ['call-site file-and-line substance', 'file and line showing the named asset consumed'],
  ['deviation record leg', '**a deviation record**'],
  ['deviation measured-reasons substance', "measured, code-level reasons the named asset's"],
  ['deviation model-inapplicability substance', 'mathematical model does not apply'],
  ['deviation proposed-replacement substance', 'plus the proposed replacement'],
  ['stop-before-replacement leg', 'coordinator approval before the replacement is'],
  ['review rejection consequence', 'carrying neither is rejected at review'],
  ['post-hoc deviation quarantine', 'post-hoc self-justification'],
  ['clean-room review requirement for post-hoc deviations', 'independent clean-room'],
  ['architecture-first scan deliverable', 'architecture-level answer'],
  ['grep-is-not-a-scan clause', 'not a reuse scan'],
  ['prior-art binding reviewer bullet', '- **Prior-art binding (mandatory when a delegation brief names prior art)**'],
  ['call-sites-before-results ordering', 'exist **before** assessing results'],
  ['non-convergence consequence', 'an implementation carrying neither does not converge'],
  ['cross-reference to the integrity checklist trigger', '`research-integrity` M8'],
]);

// 2. research-integrity: M8 extension + reviewer-side check.
requireAll(INTEGRITY_SKILL_FILE, read(INTEGRITY_SKILL_FILE), [
  ['prior-art sign', 'no pre-implementation deviation record'],
  ['grep-alone-insufficient clause', 'A name-level grep alone is not the scan'],
  ['architecture-first scan deliverable', 'architecture-level answer'],
  ['per-source adopt-or-reject verdict', 'adopt-or-reject verdict'],
  ['reviewer-side check heading', '**Reviewer-side check.**'],
  ['per-asset reviewer verification', 'for each named asset'],
  ['call-sites-before-results ordering', 'exist **before** assessing results'],
  ['post-hoc deviation quarantine', 'post-hoc self-justification'],
  ['cross-reference to dispatch-side gate', '*Reuse-or-deviate gate*'],
  ['convergence reviewability pointer', 'reviewable at convergence'],
]);

if (errors.length > 0) {
  console.error('[check-reuse-or-deviate-anti-drift] FAIL');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log('[check-reuse-or-deviate-anti-drift] OK');
