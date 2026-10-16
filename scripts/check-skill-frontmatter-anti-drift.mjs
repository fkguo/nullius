#!/usr/bin/env node

// Skill frontmatter anti-drift guard.
//
// Every `skills/<dir>/SKILL.md` opens with a YAML frontmatter block that skill loaders
// parse before anything else. A block that breaks the portable skill format makes the
// skill fail to load in some hosts or packagers while still looking fine in another, and
// the failure is silent until someone installs the skill there. This check parses each
// frontmatter as YAML (not with line patterns, so quoting, folding and escapes are
// resolved the way a loader resolves them) and fails when any of these hold:
//
//   - the file is not valid UTF-8, does not start with a `---` line on line 1, the block
//     is never closed, it is not valid YAML, or it is not a mapping;
//   - the block itself contains a `---` sequence: some loaders end the block at the first
//     `---` they meet, wherever it stands, and silently read a truncated block;
//   - `name` is missing or not a string, differs from the directory name, contains
//     anything outside lowercase letters, digits and hyphens, is longer than 64
//     characters, or contains a reserved word (`claude`, `anthropic`);
//   - `description` is missing, not a string, empty, longer than 1,024 characters
//     (Unicode code points), or ends with a newline. A trailing newline survives in
//     the parsed value both from a folded/literal block scalar with default chomping
//     and from a quoted scalar ending in an escaped newline, so it is tested on the
//     parsed value, never on the source text;
//   - the mapping has a key other than the six portable fields: name, description,
//     license, compatibility, metadata, allowed-tools.
//
// A name reserved-word exemption is allowed only through RESERVED_WORD_EXEMPTIONS below:
// one skill name per entry, with the reason. The exemption does not touch any other rule,
// and an entry that no longer names a skill containing a reserved word fails the check,
// so the list cannot outlive what it names.
//
// The scan reads the tracked `skills/<dir>/SKILL.md` files (depth one). An empty scan
// fails, so a broken file listing cannot pass silently.
//
// Usage:
//   node scripts/check-skill-frontmatter-anti-drift.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const scriptRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PORTABLE_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
export const NAME_MAX_LENGTH = 64;
export const DESCRIPTION_MAX_LENGTH = 1024;
export const RESERVED_SUBSTRINGS = ['claude', 'anthropic'];

// Skill names exempt from the reserved-word rule only. One entry per skill, with the reason.
export const RESERVED_WORD_EXEMPTIONS = new Map([
  [
    'claude-cli-runner',
    'Maintainer decision: the reserved-word restriction matters for skills uploaded to the ' +
      'hosted claude.ai product or packaged for the Skills API, which this repository does not ' +
      'do. This skill is installed through the agent CLIs listed in packages/skills-market, ' +
      'which load it under this name; the name states which command-line program it wraps.',
  ],
]);

// A malformed byte sequence throws instead of being replaced by U+FFFD, and a leading
// byte-order mark is kept (the default decoder drops it) so that the line-1 rule can see it.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const FENCE_LINE = /^---[ \t]*$/;
const SKILL_FILE = /^skills\/([^/]+)\/SKILL\.md$/;

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value === 'object' ? 'a mapping' : typeof value;
}

// Returns { text } with the raw frontmatter body, or { error }.
export function extractFrontmatter(content) {
  if (content.startsWith('\uFEFF')) {
    return { error: 'frontmatter does not start on line 1 (byte-order mark before the opening ---)' };
  }
  const lines = content.split(/\r?\n/);
  if (!FENCE_LINE.test(lines[0])) {
    return { error: 'frontmatter missing: line 1 is not a --- line' };
  }
  const end = lines.findIndex((line, i) => i > 0 && FENCE_LINE.test(line));
  if (end === -1) {
    return { error: 'frontmatter is not closed by a --- line' };
  }
  return { text: lines.slice(1, end).join('\n') };
}

function nameProblems(name, skillDir, exemptions) {
  if (name === undefined) return ['name is missing'];
  if (typeof name !== 'string') return [`name must be a string, parsed as ${describeType(name)}`];
  const problems = [];
  if (name === '') {
    problems.push('name is empty');
  } else if (!/^[a-z0-9-]+$/.test(name)) {
    problems.push(`name "${name}" contains characters outside lowercase letters, digits and hyphens`);
  }
  if (name !== skillDir) {
    problems.push(`name "${name}" differs from the directory name "${skillDir}"`);
  }
  const length = [...name].length;
  if (length > NAME_MAX_LENGTH) {
    problems.push(`name is ${length} characters, over the ${NAME_MAX_LENGTH} limit`);
  }
  if (!exemptions.has(name)) {
    for (const word of RESERVED_SUBSTRINGS) {
      if (name.toLowerCase().includes(word)) {
        problems.push(`name "${name}" contains the reserved word "${word}"`);
      }
    }
  }
  return problems;
}

function descriptionProblems(description) {
  if (description === undefined) return ['description is missing'];
  if (typeof description !== 'string') {
    return [`description must be a string, parsed as ${describeType(description)}`];
  }
  const problems = [];
  if (description.trim() === '') {
    problems.push('description is empty');
  }
  const length = [...description].length;
  if (length > DESCRIPTION_MAX_LENGTH) {
    problems.push(`description is ${length} characters, over the ${DESCRIPTION_MAX_LENGTH} limit`);
  }
  if (/[\r\n]$/.test(description)) {
    problems.push(
      'description ends with a newline after YAML parsing ' +
        '(block scalar without a strip indicator, or a quoted scalar ending in an escaped newline ' +
        'or on an empty last line)',
    );
  }
  return problems;
}

// Returns the list of problems found in one SKILL.md; an empty list means the file passes.
export function checkSkillFile({ skillDir, content, exemptions = RESERVED_WORD_EXEMPTIONS }) {
  const extracted = extractFrontmatter(content);
  if (extracted.error) return [extracted.error];

  const problems = [];
  if (extracted.text.includes('---')) {
    problems.push('frontmatter block contains "---"; some loaders end the block at the first "---" they meet');
  }

  let data;
  try {
    data = yaml.load(extracted.text, { schema: yaml.CORE_SCHEMA });
  } catch (error) {
    const firstLine = String(error?.message ?? error).split('\n')[0];
    return [...problems, `frontmatter is not valid YAML: ${firstLine}`];
  }
  if (data === null || data === undefined) return [...problems, 'frontmatter is empty'];
  if (typeof data !== 'object' || Array.isArray(data)) {
    return [...problems, `frontmatter must be a mapping, parsed as ${describeType(data)}`];
  }

  problems.push(...nameProblems(data.name, skillDir, exemptions), ...descriptionProblems(data.description));
  for (const key of Object.keys(data)) {
    if (!PORTABLE_KEYS.includes(key)) {
      problems.push(`unsupported frontmatter key "${key}" (portable fields: ${PORTABLE_KEYS.join(', ')})`);
    }
  }
  return problems;
}

export function trackedSkillFiles(repoRoot) {
  return execFileSync('git', ['ls-files', '-z', 'skills/'], { cwd: repoRoot, encoding: 'utf-8' })
    .split('\0')
    .filter(file => SKILL_FILE.test(file));
}

// Scans the given repo-relative SKILL.md paths; returns { scanned, violations: [{ file, reason }] }.
export function runCheck({
  repoRoot = scriptRepoRoot,
  files = trackedSkillFiles(repoRoot),
  exemptions = RESERVED_WORD_EXEMPTIONS,
} = {}) {
  const violations = [];
  const exemptionsUsed = new Set();
  let matched = 0;
  let scanned = 0;
  for (const file of files) {
    const match = SKILL_FILE.exec(file);
    if (!match) continue;
    matched += 1;
    if (exemptions.has(match[1]) && RESERVED_SUBSTRINGS.some(word => match[1].includes(word))) {
      exemptionsUsed.add(match[1]);
    }
    let content;
    try {
      content = strictUtf8.decode(readFileSync(path.join(repoRoot, file)));
    } catch (error) {
      const invalid = error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA';
      const reason = invalid ? 'is not valid UTF-8' : `cannot be read: ${error.code ?? error.message}`;
      violations.push({ file, reason });
      continue;
    }
    scanned += 1;
    for (const reason of checkSkillFile({ skillDir: match[1], content, exemptions })) {
      violations.push({ file, reason });
    }
  }
  if (matched === 0) {
    violations.push({ file: 'skills/', reason: 'no skills/<dir>/SKILL.md file was scanned' });
  }
  for (const name of exemptions.keys()) {
    if (!exemptionsUsed.has(name)) {
      violations.push({
        file: 'scripts/check-skill-frontmatter-anti-drift.mjs',
        reason: `reserved-word exemption "${name}" names no scanned skill whose name contains a reserved word; remove it`,
      });
    }
  }
  return { scanned, violations };
}

// Resolve both sides through symlinks (the module URL is already resolved unless node runs
// with --preserve-symlinks-main): otherwise a run through a symlinked path would skip the
// check and exit 0 silently.
function isMainModule() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {
    return path.resolve(process.argv[1]) === modulePath;
  }
}

if (isMainModule()) {
  const { scanned, violations } = runCheck();
  if (violations.length === 0) {
    console.log(`OK: ${scanned} skills/*/SKILL.md frontmatter blocks pass the frontmatter rules (name, description, keys).`);
    process.exit(0);
  }
  console.error('DRIFT: skill frontmatter violates the portable skill format:');
  for (const { file, reason } of violations) {
    console.error(`  ${file}: ${reason}`);
  }
  console.error('');
  console.error(`Allowed keys: ${PORTABLE_KEYS.join(', ')}. name must equal the directory name`);
  console.error(`(lowercase letters, digits, hyphens; at most ${NAME_MAX_LENGTH} characters; no reserved word).`);
  console.error(`description must be non-empty, at most ${DESCRIPTION_MAX_LENGTH} characters, and must not end with a newline`);
  console.error('(use a >- or |- block scalar, or a plain/quoted scalar without a trailing \\n).');
  console.error('The block must not contain "---" and the file must be valid UTF-8.');
  process.exit(1);
}
