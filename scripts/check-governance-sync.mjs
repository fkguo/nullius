#!/usr/bin/env node

// Verify that the governance content in AGENTS.md and CLAUDE.md is byte-for-byte
// identical. AGENTS.md is the canonical edit point; CLAUDE.md mirrors its
// governance sections for tools/prompts that only know CLAUDE.md.
//
// The check extracts the region from the first occurrence of `## Read Order`
// up to (and not including) the GitNexus appendix marker `<!-- gitnexus:start -->`
// if that marker is present, otherwise to end of file (the appendix was removed).
// On mismatch it prints the first divergent line and exits non-zero.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const START_MARKER = '## Read Order';
const END_MARKER = '<!-- gitnexus:start -->';

function extractGovernance(relPath) {
  const filePath = path.join(repoRoot, relPath);
  const content = readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(START_MARKER);
  if (startIdx === -1) {
    throw new Error(`${relPath}: missing start marker ${JSON.stringify(START_MARKER)}`);
  }
  // The GitNexus appendix marker bounds the region when present; once the
  // appendix is removed the governance section simply runs to end of file.
  const markerIdx = content.indexOf(END_MARKER);
  const endIdx = markerIdx === -1 ? content.length : markerIdx;
  if (startIdx > endIdx) {
    throw new Error(`${relPath}: ${JSON.stringify(START_MARKER)} appears after ${JSON.stringify(END_MARKER)}`);
  }
  const region = content.slice(startIdx, endIdx).trimEnd();
  if (region.trim().length < 100) {
    throw new Error(
      `${relPath}: governance region between markers is suspiciously short (<100 chars after trim); did the markers move or collapse?`,
    );
  }
  return region;
}

function firstDifference(a, b) {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) {
      return { line: i + 1, a: aLines[i], b: bLines[i] };
    }
  }
  return null;
}

const agentsGov = extractGovernance('AGENTS.md');
const claudeGov = extractGovernance('CLAUDE.md');

if (agentsGov === claudeGov) {
  console.log('OK: AGENTS.md and CLAUDE.md governance sections are in sync.');
  process.exit(0);
}

const diff = firstDifference(agentsGov, claudeGov);
console.error('DRIFT: AGENTS.md and CLAUDE.md governance sections differ.');
console.error('');
console.error(`Region: from "${START_MARKER}" up to "${END_MARKER}" (exclusive) or EOF.`);
console.error(`AGENTS.md governance: ${agentsGov.split('\n').length} lines`);
console.error(`CLAUDE.md governance: ${claudeGov.split('\n').length} lines`);
console.error('');
if (diff) {
  console.error(`First divergence at line ${diff.line} of the extracted region:`);
  console.error(`  AGENTS.md: ${JSON.stringify(diff.a ?? '<EOF>')}`);
  console.error(`  CLAUDE.md: ${JSON.stringify(diff.b ?? '<EOF>')}`);
}
console.error('');
console.error('Fix: edit AGENTS.md and replicate the change in CLAUDE.md (or vice versa).');
console.error('AGENTS.md is the canonical edit point; on conflict it wins.');
console.error('See AGENTS.md §Public Repo Boundaries for the sync rule.');
process.exit(1);
