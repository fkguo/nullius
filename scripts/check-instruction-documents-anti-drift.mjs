#!/usr/bin/env node
// Progressive disclosure is an entry-size and reachability contract. Each cap
// is local to its already-refactored entry, leaving bounded maintenance room;
// these are not context-window or global token budgets. Semantic locks consume
// only the same explicitly marked closure, never every reference on disk.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectInstructionDocuments } from './lib/instruction-documents.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY_LIMITS = [
  ['skills/research-harness/SKILL.md', 7000, 11],
  ['skills/research-team/SKILL.md', 12500, 8],
  ['skills/review-swarm/SKILL.md', 7500, 12],
  ['skills/research-integrity/SKILL.md', 10500, 12],
  ['packages/project-contracts/src/project_contracts/scaffold_templates/AGENTS.md', 5500, 1],
];

export function checkInstructionEntrypoints(root = repoRoot, limits = ENTRY_LIMITS) {
  const errors = [];
  const entries = [];
  for (const [relative, maximumBytes, minimumReferences] of limits) {
    const entry = path.join(root, relative);
    try {
      const documents = collectInstructionDocuments(entry);
      const bytes = fs.statSync(entry).size;
      const references = documents.length - 1;
      entries.push({ entry: relative, bytes, references });
      if (bytes > maximumBytes) errors.push(`${relative}: ${bytes} entry bytes exceeds local cap ${maximumBytes}`);
      if (references < minimumReferences) errors.push(`${relative}: ${references} reachable instruction references below ${minimumReferences}`);
    } catch (error) {
      errors.push(`${relative}: ${error.message}`);
    }
  }
  return { errors, entries };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, entries } = checkInstructionEntrypoints();
  if (errors.length) {
    process.stderr.write('[instruction-documents-drift] failed:\n' + errors.map(e => `- ${e}`).join('\n') + '\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(`[instruction-documents-drift] ${entries.length} concise entries and their marked instruction references pass.\n`);
  }
}
