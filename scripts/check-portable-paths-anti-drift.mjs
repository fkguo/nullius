#!/usr/bin/env node

// Portability anti-drift guard.
//
// Fails if a machine-specific home path (a concrete username under /Users/,
// /home/, or C:\Users\) leaks into a tracked doc / skill / source surface.
// This is what let `/home/user/...` slip into a public SKILL.md: the existing
// RE_NON_PORTABLE_SOURCE validator only checks run manifests, not docs/skills.
//
// Only a CONCRETE username segment is flagged. The matcher requires the path
// segment after the prefix to be `[A-Za-z0-9._-]+` (a real-name shape), so it
// does NOT match the legitimate redaction / validation machinery, which always
// uses a regex metacharacter right after the prefix:
//   - redaction.ts:        /\/Users\/[^/\s]+\//   (next char `[`)
//   - validate_manifest.py: ^(?:/Users/|/home/|…)  (next char `|`)
//   - docs placeholders:    /Users/<you>/          (next char `<`)
// Test fixtures (which intentionally embed fake user paths to exercise the
// redaction logic) are excluded by path.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Leading (?<![A-Za-z0-9/]) skips URL path segments (e.g. https://host/Users/bob)
// and host-glued matches; the trailing lookahead accepts a separator OR a word
// boundary (quote, space, punctuation, EOL) so bare/last-segment paths like
// `/home/user`, `"/home/user"`, and `C:\Users\user` are still caught.
const MACHINE_PATH = /(?<![A-Za-z0-9/])(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)(?=[/\\]|["'`\s.,:;)\]]|$)/g;

// Plain-word placeholders that are not real machines (segments with `<>[]` are
// already excluded by the matcher above).
const PLACEHOLDER_SEGMENTS = new Set([
  'me', 'you', 'user', 'users', 'username', 'name', 'example', 'someone', 'foo', 'bar',
]);

const SCAN_EXT = new Set(['.md', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.sh', '.json', '.txt']);
// Test files legitimately embed fake user paths to exercise redaction; the
// check script itself documents the patterns it forbids.
const SKIP_PATH_RE = /(^|\/)(node_modules|dist|__tests__|tests)\//;
const SKIP_FILE_RE = /(\.test\.[cm]?[tj]sx?$|(^|\/)test_[^/]*\.py$|check-portable-paths-anti-drift\.mjs$)/;

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean);
}

const violations = [];
for (const rel of trackedFiles()) {
  if (SKIP_PATH_RE.test('/' + rel) || SKIP_FILE_RE.test(rel)) continue;
  if (!SCAN_EXT.has(path.extname(rel))) continue;
  let content;
  try {
    content = readFileSync(path.join(repoRoot, rel), 'utf-8');
  } catch {
    continue;
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    MACHINE_PATH.lastIndex = 0;
    let m;
    while ((m = MACHINE_PATH.exec(lines[i])) !== null) {
      if (PLACEHOLDER_SEGMENTS.has(m[1].toLowerCase())) continue;
      violations.push({ file: rel, line: i + 1, match: m[0], seg: m[1] });
    }
  }
}

if (violations.length === 0) {
  console.log('OK: no machine-specific home paths in tracked doc/skill/source surfaces.');
  process.exit(0);
}

console.error('DRIFT: machine-specific hardcoded path(s) in tracked surfaces:');
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.match}  (username segment "${v.seg}")`);
}
console.error('');
console.error('Public docs/skills/source must stay portable across machines. Replace the concrete');
console.error('home path with a placeholder (e.g. /absolute/path/to/<repo> or /Users/<you>/), an');
console.error('env var, or a relative/discovered path. If a fake path is a deliberate test fixture,');
console.error('keep it under a tests/ or __tests__/ directory (those are not scanned).');
process.exit(1);
