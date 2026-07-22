#!/usr/bin/env node

/**
 * Citation-identity grounding anti-drift lock.
 *
 * A source-content span and a resolvable URL do not prove that the title and
 * identifier displayed to a reader name that source. Keep the executable
 * veto, parse-time recomputation, and the three public skill contracts wired
 * together so future edits cannot silently collapse identity into full-text
 * grounding.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const required = new Map([
  ['packages/shared/src/claim-grounding.ts', [
    'enforceCitationIdentityRule',
    'safeParseCitationIdentityCheck',
    'citation_identities',
    'citation identity mismatch',
    'canonical citation metadata unavailable',
    'must name one of the claim evidence_uris',
  ]],
  ['packages/shared/src/citation-identity.ts', [
    'archived_canonical_metadata',
    'authoritative_retrieval',
    'citation_triangulation',
    'locator_aliases',
    'title_mismatch',
    'authors_mismatch',
    'displayed_identifier_mismatch',
    'evaluateCitationIdentity',
  ]],
  ['skills/claim-grounding/SKILL.md', [
    'Citation identity is a prior gate',
    'Completing a full-text claim check cannot compensate',
    'Archived canonical metadata',
    'text copied from another source cannot ground this citation',
  ]],
  ['skills/research-integrity/SKILL.md', [
    'Identity gate before content verification',
    'displayed-entry',
    'A successful full-text check does not repair a failure',
  ]],
  ['skills/citation-triangulation/SKILL.md', [
    'Bind the human-facing entry separately',
    'not two acceptable aliases',
  ]],
]);

const failures = [];
for (const [relativePath, anchors] of required) {
  let content;
  try {
    content = readFileSync(path.join(repoRoot, relativePath), 'utf8');
  } catch (error) {
    failures.push(`${relativePath}: cannot read (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  for (const anchor of anchors) {
    if (!content.includes(anchor)) failures.push(`${relativePath}: missing contract anchor ${JSON.stringify(anchor)}`);
  }
}

if (failures.length > 0) {
  process.stderr.write('[citation-identity-grounding-drift] anti-drift check failed:\n\n');
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write('[citation-identity-grounding-drift] anti-drift check passed.\n');
