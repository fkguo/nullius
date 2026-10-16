#!/usr/bin/env node

// Verify that CLAUDE.md delegates to AGENTS.md instead of mirroring it.
//
// AGENTS.md is the single edit point for the root agent rules. CLAUDE.md
// exists only so that Claude Code (and any host that knows CLAUDE.md but not
// AGENTS.md) loads those rules: it must contain exactly one bare `@AGENTS.md`
// import line, no copy of the governance text, and it must be a regular file
// (a symlink silently turns into a one-line text file on checkouts without
// symlink support). On failure the check prints what is wrong and exits
// non-zero.

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const IMPORT_LINE = '@AGENTS.md';
const GOVERNANCE_START = '## Read Order';

const problems = [];

function read(relPath) {
  const filePath = path.join(repoRoot, relPath);
  if (!existsSync(filePath)) {
    problems.push(`${relPath}: file is missing`);
    return null;
  }
  return readFileSync(filePath, 'utf-8');
}

// Lines of a markdown file that are outside fenced code blocks. A fence closes
// only on a marker of the same character and at least the opening length, as
// in CommonMark, so a ``` line inside a ```` fence does not end it.
function proseLines(content) {
  const out = [];
  let fence = null;
  for (const line of content.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const run = marker[1];
      if (fence === null) {
        fence = run;
        continue;
      }
      // A closing fence is the marker alone (an info string makes it an
      // opening fence, which cannot close in CommonMark).
      if (run[0] === fence[0] && run.length >= fence.length && line.trim() === run) {
        fence = null;
        continue;
      }
    }
    if (fence === null) out.push(line);
  }
  return out;
}

// A prose line with its backtick code spans removed: Claude Code ignores an
// import inside a code span, so `@AGENTS.md` in backticks is not an import.
function withoutCodeSpans(line) {
  return line.replace(/`[^`]*`/g, ' ');
}

// Every `@path` import on a line: an `@` at the start of the line or after
// whitespace, followed by a non-space path.
function importsOn(line) {
  return [...withoutCodeSpans(line).matchAll(/(?:^|\s)(@\S+)/g)].map((m) => m[1]);
}

// AGENTS.md must still carry the governance text, as a heading line.
const agents = read('AGENTS.md');
const agentsLines = agents === null ? [] : agents.split('\n');
if (agents !== null && !agentsLines.some((line) => line.trim() === GOVERNANCE_START)) {
  problems.push(`AGENTS.md: missing governance start heading ${JSON.stringify(GOVERNANCE_START)}`);
}

// CLAUDE.md must be a regular file, not a symlink.
const claudePath = path.join(repoRoot, 'CLAUDE.md');
if (existsSync(claudePath) && lstatSync(claudePath).isSymbolicLink()) {
  problems.push('CLAUDE.md: is a symbolic link; it must be a regular file containing the import line');
}

const claude = read('CLAUDE.md');
const rawLines = claude === null ? [] : claude.split('\n');
const lines = claude === null ? [] : proseLines(claude);

// Exactly one import, and it is the bare `@AGENTS.md` line. Imports are read
// the way Claude Code reads them: outside code fences and code spans, at the
// start of a line or after whitespace.
const imports = lines.flatMap(importsOn);
const expected = imports.filter((imp) => imp === IMPORT_LINE);
const others = imports.filter((imp) => imp !== IMPORT_LINE);
if (claude !== null && expected.length !== 1) {
  problems.push(`CLAUDE.md: expected exactly one ${JSON.stringify(IMPORT_LINE)} import, found ${expected.length}`);
}
if (others.length > 0) {
  problems.push(`CLAUDE.md: unexpected import(s): ${others.map((imp) => JSON.stringify(imp)).join(', ')}`);
}
if (expected.length === 1 && !lines.some((line) => line.trim() === IMPORT_LINE)) {
  problems.push(`CLAUDE.md: the ${JSON.stringify(IMPORT_LINE)} import must stand alone on its own line`);
}

// No copied governance text anywhere in the file, code fences included: none
// of AGENTS.md's section headings may appear.
const agentsHeadings = agentsLines.filter((line) => /^##+ /.test(line)).map((line) => line.trim());
const copied = rawLines.map((l) => l.trim()).filter((line) => agentsHeadings.includes(line));
if (copied.length > 0) {
  problems.push(`CLAUDE.md: contains governance heading(s) copied from AGENTS.md: ${copied.join(', ')}`);
}

// Keep the file short: a header plus the import, nothing that could drift.
const nonEmpty = rawLines.filter((line) => line.trim().length > 0);
if (claude !== null && nonEmpty.length > 12) {
  problems.push(`CLAUDE.md: ${nonEmpty.length} non-empty lines; it should hold only a short header and the import line`);
}

if (problems.length === 0) {
  console.log('OK: CLAUDE.md is a regular file that imports AGENTS.md once and copies none of its governance text.');
  process.exit(0);
}

console.error('DRIFT: CLAUDE.md no longer delegates cleanly to AGENTS.md.');
for (const problem of problems) console.error(`  - ${problem}`);
console.error('');
console.error('Fix: keep AGENTS.md as the only place rules are written; CLAUDE.md holds a short');
console.error(`header and one line reading ${IMPORT_LINE} (outside backticks and code fences).`);
process.exit(1);
