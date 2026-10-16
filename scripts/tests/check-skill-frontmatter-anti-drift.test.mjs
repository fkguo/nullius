import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PORTABLE_KEYS,
  RESERVED_WORD_EXEMPTIONS,
  checkSkillFile,
  extractFrontmatter,
  runCheck,
} from '../check-skill-frontmatter-anti-drift.mjs';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'check-skill-frontmatter-anti-drift.mjs');
const repoRoot = path.join(path.dirname(scriptPath), '..');

const NO_EXEMPTIONS = new Map();
const frontmatter = (...lines) => ['---', ...lines, '---', '', '# Body', ''].join('\n');
const check = (content, skillDir = 'demo-skill', exemptions = NO_EXEMPTIONS) =>
  checkSkillFile({ skillDir, content, exemptions });
const GOOD = frontmatter('name: demo-skill', 'description: Does one thing.');

function assertFires(content, pattern, options = {}) {
  const problems = check(content, options.skillDir, options.exemptions);
  assert.ok(
    problems.some(problem => pattern.test(problem)),
    `expected a problem matching ${pattern}, got: ${JSON.stringify(problems)}`,
  );
}

test('a well-formed frontmatter block passes, including every portable key', () => {
  assert.deepEqual(check(GOOD), []);
  const allKeys = frontmatter(
    'name: demo-skill',
    'description: Does one thing.',
    'license: MIT',
    'compatibility: Needs node.',
    'metadata:',
    '  owner: someone',
    'allowed-tools: Read Grep',
  );
  assert.deepEqual(check(allKeys), []);
  assert.deepEqual(PORTABLE_KEYS, ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
});

test('CRLF line endings and trailing blanks on fence lines are accepted', () => {
  assert.deepEqual(check(GOOD.replace(/\n/g, '\r\n')), []);
  assert.deepEqual(check(GOOD.replace(/^---$/gm, '--- ')), []);
});

test('frontmatter must start on line 1 and be closed', () => {
  assertFires('# Title\n\n' + GOOD, /line 1 is not a --- line/);
  assertFires('\n' + GOOD, /line 1 is not a --- line/);
  assertFires('', /line 1 is not a --- line/);
  assertFires('\uFEFF' + GOOD, /byte-order mark/);
  assertFires('---\nname: demo-skill\ndescription: Does one thing.\n', /not closed/);
  assertFires('----\nname: demo-skill\n---\n', /line 1 is not a --- line/);
  assert.deepEqual(extractFrontmatter(GOOD), { text: 'name: demo-skill\ndescription: Does one thing.' });
});

test('invalid YAML, an empty block and a non-mapping block are reported', () => {
  assertFires(frontmatter('name: [unclosed', 'description: x'), /not valid YAML/);
  assertFires(frontmatter('name: demo-skill', 'name: demo-skill', 'description: x'), /not valid YAML/);
  assertFires('---\n---\n', /frontmatter is empty/);
  assertFires(frontmatter('- name', '- description'), /must be a mapping, parsed as a list/);
  assertFires(frontmatter('just a sentence'), /must be a mapping, parsed as string/);
});

test('name: missing, wrong type, directory mismatch', () => {
  assertFires(frontmatter('description: x'), /name is missing/);
  assertFires(frontmatter('name: 123', 'description: x'), /name must be a string, parsed as number/);
  assertFires(frontmatter('name:', 'description: x'), /name must be a string, parsed as null/);
  assertFires(frontmatter('name: other-skill', 'description: x'), /differs from the directory name "demo-skill"/);
  assertFires(frontmatter('name: ""', 'description: x'), /name is empty/);
});

test('name: characters outside lowercase letters, digits and hyphens', () => {
  for (const bad of ['Demo-Skill', 'demo_skill', 'demo skill', 'demo.skill', 'démo-skill']) {
    assertFires(frontmatter(`name: "${bad}"`, 'description: x'), /outside lowercase letters, digits and hyphens/, {
      skillDir: bad,
    });
  }
  assert.deepEqual(check(frontmatter('name: demo-2-skill', 'description: x'), 'demo-2-skill'), []);
});

test('name: at most 64 characters', () => {
  const longest = 'a'.repeat(NAME_MAX_LENGTH);
  assert.deepEqual(check(frontmatter(`name: ${longest}`, 'description: x'), longest), []);
  const tooLong = 'a'.repeat(NAME_MAX_LENGTH + 1);
  assertFires(frontmatter(`name: ${tooLong}`, 'description: x'), /over the 64 limit/, { skillDir: tooLong });
});

test('name: reserved words are rejected, whatever their position', () => {
  for (const bad of ['claude-helper', 'helper-claude', 'my-claude-tool', 'anthropic-tools', 'x-anthropic']) {
    assertFires(frontmatter(`name: ${bad}`, 'description: x'), /reserved word/, { skillDir: bad });
  }
  assertFires(frontmatter('name: Claude-Helper', 'description: x'), /reserved word "claude"/, { skillDir: 'Claude-Helper' });
});

test('name: the exemption covers exactly the listed names and nothing else', () => {
  const exemptions = new Map([['claude-cli-runner', 'test reason']]);
  const exempt = frontmatter('name: claude-cli-runner', 'description: x');
  assert.deepEqual(check(exempt, 'claude-cli-runner', exemptions), []);
  assertFires(exempt, /reserved word/, { skillDir: 'claude-cli-runner' });
  assertFires(frontmatter('name: claude-cli-runner-two', 'description: x'), /reserved word/, {
    skillDir: 'claude-cli-runner-two',
    exemptions,
  });
  assertFires(frontmatter('name: anthropic-cli-runner', 'description: x'), /reserved word/, {
    skillDir: 'anthropic-cli-runner',
    exemptions,
  });
  // The exemption lifts only the reserved-word rule: the other name rules still fire.
  assertFires(frontmatter('name: claude-cli-runner', 'description: x'), /differs from the directory name/, {
    skillDir: 'other-dir',
    exemptions,
  });
  assertFires(frontmatter('name: Claude-Cli-Runner', 'description: x'), /outside lowercase/, {
    skillDir: 'Claude-Cli-Runner',
    exemptions: new Map([['Claude-Cli-Runner', 'test reason']]),
  });
  assert.ok(RESERVED_WORD_EXEMPTIONS.get('claude-cli-runner')?.length > 20, 'the repo exemption carries a written reason');
  assert.deepEqual([...RESERVED_WORD_EXEMPTIONS.keys()], ['claude-cli-runner']);
});

test('description: missing, wrong type, empty', () => {
  assertFires(frontmatter('name: demo-skill'), /description is missing/);
  assertFires(frontmatter('name: demo-skill', 'description: 42'), /description must be a string, parsed as number/);
  assertFires(frontmatter('name: demo-skill', 'description:'), /description must be a string, parsed as null/);
  assertFires(frontmatter('name: demo-skill', 'description: ""'), /description is empty/);
  assertFires(frontmatter('name: demo-skill', 'description: "   "'), /description is empty/);
});

test('description: at most 1,024 characters, counted as Unicode code points', () => {
  const atLimit = 'a'.repeat(DESCRIPTION_MAX_LENGTH);
  assert.deepEqual(check(frontmatter('name: demo-skill', `description: ${atLimit}`)), []);
  assertFires(frontmatter('name: demo-skill', `description: ${atLimit}a`), /1025 characters, over the 1024 limit/);
  // 1,024 astral code points are 2,048 UTF-16 units: counted by code point they pass.
  const astral = '\u{1D6FC}'.repeat(DESCRIPTION_MAX_LENGTH);
  assert.deepEqual(check(frontmatter('name: demo-skill', `description: "${astral}"`)), []);
  assertFires(frontmatter('name: demo-skill', `description: "${astral}x"`), /over the 1024 limit/);
});

test('description: a trailing newline is caught in every YAML spelling that produces one', () => {
  assertFires(frontmatter('name: demo-skill', 'description: "Does one thing.\\n"'), /ends with a newline/);
  assertFires(frontmatter('name: demo-skill', "description: 'Does one thing.\n\n  '"), /ends with a newline/);
  assertFires(frontmatter('name: demo-skill', 'description: >', '  Does one thing', '  across lines.'), /ends with a newline/);
  assertFires(frontmatter('name: demo-skill', 'description: |', '  Does one thing.'), /ends with a newline/);
  assertFires(frontmatter('name: demo-skill', 'description: |+', '  Does one thing.', ''), /ends with a newline/);
  assertFires(frontmatter('name: demo-skill', 'description: "Does one thing.\\r\\n"'), /ends with a newline/);
  assertFires(frontmatter('name: demo-skill', 'description: "Does one thing.\\r"'), /ends with a newline/);
  // Spellings that leave no trailing newline pass.
  assert.deepEqual(check(frontmatter('name: demo-skill', 'description: >-', '  Does one thing', '  across lines.')), []);
  assert.deepEqual(check(frontmatter('name: demo-skill', 'description: |-', '  Does one thing.')), []);
  assert.deepEqual(check(frontmatter('name: demo-skill', 'description: "Does one thing.\\n  Then another."')), []);
  assert.deepEqual(check(frontmatter('name: demo-skill', "description: 'Does one thing.'")), []);
});

test('a "---" sequence inside the block is reported, wherever it stands', () => {
  const inline = frontmatter('name: demo-skill', 'description: Fits a curve --- then reports the residuals.');
  assertFires(inline, /contains "---"/);
  const inBlockScalar = frontmatter('name: demo-skill', 'description: >-', '  Part one.', '  ---', '  Part two.');
  assertFires(inBlockScalar, /contains "---"/);
  const inValue = frontmatter('name: demo-skill', 'description: x', 'metadata:', '  note: a---b');
  assertFires(inValue, /contains "---"/);
  // It does not hide the other problems of the same block.
  const withInvalidYaml = frontmatter('name: [unclosed ---', 'description: x');
  assertFires(withInvalidYaml, /contains "---"/);
  assertFires(withInvalidYaml, /not valid YAML/);
  // Nor does it hide itself behind the other early returns.
  assertFires(frontmatter('- name---x'), /contains "---"/);
  assertFires(frontmatter('- name---x'), /must be a mapping/);
  // Hyphenated names and keys are not mistaken for the sequence.
  const hyphens = frontmatter('name: demo-skill', 'description: A - B -- C.', 'allowed-tools: Read');
  assert.deepEqual(check(hyphens), []);
});

test('keys outside the six portable fields are reported one by one', () => {
  const problems = check(
    frontmatter('name: demo-skill', 'description: x', 'version: 1', 'user-invocable: true', 'allowed_tools: Read'),
  );
  assert.deepEqual(
    problems.map(problem => /key "([^"]+)"/.exec(problem)?.[1]),
    ['version', 'user-invocable', 'allowed_tools'],
  );
});

test('several problems in one file are all listed', () => {
  const problems = check(frontmatter('name: Bad_Name', 'description: ""', 'extra: 1'));
  assert.ok(problems.length >= 4, JSON.stringify(problems));
});

function fixture(t, skills) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-skill-frontmatter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [];
  for (const [dir, content] of Object.entries(skills)) {
    const rel = `skills/${dir}/SKILL.md`;
    fs.mkdirSync(path.join(root, 'skills', dir), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
    files.push(rel);
  }
  return { root, files };
}

test('runCheck lists each offender with its file and reason', t => {
  const { root, files } = fixture(t, {
    'good-skill': frontmatter('name: good-skill', 'description: Fine.'),
    'bad-skill': frontmatter('name: bad-skill', 'description: "Ends badly.\\n"'),
    'no-fence': '# Title\n',
  });
  const result = runCheck({ repoRoot: root, files, exemptions: NO_EXEMPTIONS });
  assert.equal(result.scanned, 3);
  assert.deepEqual(
    result.violations.map(v => v.file).sort(),
    ['skills/bad-skill/SKILL.md', 'skills/no-fence/SKILL.md'],
  );
  assert.match(result.violations.find(v => v.file.includes('bad-skill')).reason, /ends with a newline/);
});

test('runCheck: an unreadable listed file and an empty scan both fail', t => {
  const { root } = fixture(t, {});
  const missing = runCheck({ repoRoot: root, files: ['skills/gone/SKILL.md'], exemptions: NO_EXEMPTIONS });
  assert.deepEqual(missing.violations.map(v => [v.file, v.reason.replace(/:.*$/, '')]), [
    ['skills/gone/SKILL.md', 'cannot be read'],
  ]);
  const empty = runCheck({ repoRoot: root, files: [], exemptions: NO_EXEMPTIONS });
  assert.deepEqual(empty.violations.map(v => v.file), ['skills/']);
});

test('runCheck: a file that is not valid UTF-8 fails instead of being repaired silently', t => {
  const { root } = fixture(t, {});
  fs.mkdirSync(path.join(root, 'skills', 'latin-skill'), { recursive: true });
  const bytes = Buffer.concat([
    Buffer.from('---\nname: latin-skill\ndescription: Caf'),
    Buffer.from([0xe9]),
    Buffer.from(' analysis.\n---\n'),
  ]);
  fs.writeFileSync(path.join(root, 'skills', 'latin-skill', 'SKILL.md'), bytes);
  const result = runCheck({ repoRoot: root, files: ['skills/latin-skill/SKILL.md'], exemptions: NO_EXEMPTIONS });
  assert.ok(result.violations.some(v => v.file === 'skills/latin-skill/SKILL.md' && /not valid UTF-8/.test(v.reason)));
  assert.equal(result.scanned, 0);
});

test('runCheck: a byte-order mark in the file bytes is reported, not swallowed by the decoder', t => {
  const { root } = fixture(t, {});
  fs.mkdirSync(path.join(root, 'skills', 'bom-skill'), { recursive: true });
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(frontmatter('name: bom-skill', 'description: Fine.')),
  ]);
  fs.writeFileSync(path.join(root, 'skills', 'bom-skill', 'SKILL.md'), bytes);
  const result = runCheck({ repoRoot: root, files: ['skills/bom-skill/SKILL.md'], exemptions: NO_EXEMPTIONS });
  assert.equal(result.scanned, 1);
  assert.deepEqual(result.violations.map(v => v.file), ['skills/bom-skill/SKILL.md']);
  assert.match(result.violations[0].reason, /byte-order mark/);
});

test('runCheck: a skill that cannot be decoded is reported once, without a misleading exemption notice', t => {
  const { root } = fixture(t, {});
  fs.mkdirSync(path.join(root, 'skills', 'claude-cli-runner'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'claude-cli-runner', 'SKILL.md'), Buffer.from([0xff, 0xfe, 0xfd]));
  const exemptions = new Map([['claude-cli-runner', 'reason']]);
  const result = runCheck({ repoRoot: root, files: ['skills/claude-cli-runner/SKILL.md'], exemptions });
  assert.deepEqual(result.violations.map(v => v.reason), ['is not valid UTF-8']);
});

test('runCheck: only depth-one skills/<dir>/SKILL.md files are scanned', t => {
  const { root, files } = fixture(t, {
    'good-skill': frontmatter('name: good-skill', 'description: Fine.'),
    'good-skill/nested': '# not frontmatter\n',
  });
  const result = runCheck({ repoRoot: root, files, exemptions: NO_EXEMPTIONS });
  assert.equal(result.scanned, 1);
  assert.deepEqual(result.violations, []);
});

test('runCheck: a stale exemption fails, a used one does not', t => {
  const { root, files } = fixture(t, {
    'claude-cli-runner': frontmatter('name: claude-cli-runner', 'description: Fine.'),
    'plain-skill': frontmatter('name: plain-skill', 'description: Fine.'),
  });
  const used = new Map([['claude-cli-runner', 'reason']]);
  assert.deepEqual(runCheck({ repoRoot: root, files, exemptions: used }).violations, []);
  const stale = new Map([
    ['claude-cli-runner', 'reason'],
    ['plain-skill', 'its name has no reserved word'],
    ['removed-claude-skill', 'names no skill'],
  ]);
  const reasons = runCheck({ repoRoot: root, files, exemptions: stale }).violations.map(v => v.reason);
  assert.equal(reasons.length, 2, JSON.stringify(reasons));
  assert.ok(reasons.some(reason => reason.includes('"plain-skill"')));
  assert.ok(reasons.some(reason => reason.includes('"removed-claude-skill"')));
});

test('the repository skills pass the lock', () => {
  const result = runCheck({ repoRoot });
  assert.deepEqual(result.violations, []);
  assert.ok(result.scanned > 0);
});

// A throwaway git tree holding one skill and a copy of the script, so the command scans that
// tree and not the real repository.
function commandTree(t, skillContent, extraSkills = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-skill-frontmatter-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  for (const [dir, content] of Object.entries({ 'demo-skill': skillContent, ...extraSkills })) {
    fs.mkdirSync(path.join(root, 'skills', dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', dir, 'SKILL.md'), content);
  }
  execFileSync('git', ['add', '--', 'skills'], { cwd: root });
  fs.mkdirSync(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts', 'check-skill-frontmatter-anti-drift.mjs');
  fs.copyFileSync(scriptPath, script);
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'));
  return { root, script };
}

function runCommand(entry, cwd, nodeArgs = []) {
  const result = spawnSync('node', [...nodeArgs, entry], { cwd, encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const OFFENDING = frontmatter('name: demo-skill', 'description: "Ends badly.\\n"');

test('the command exits 1 and names each offender on a synthetic offending tree', t => {
  const { root } = commandTree(t, OFFENDING);
  const result = runCommand('scripts/check-skill-frontmatter-anti-drift.mjs', root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skills\/demo-skill\/SKILL\.md: description ends with a newline/);
});

test('the command exits 0 on a conforming tree', t => {
  // The repository exemption must find the skill it names, so the tree carries that skill too.
  const runner = frontmatter('name: claude-cli-runner', 'description: Runs a command-line program.');
  const { root } = commandTree(t, GOOD, { 'claude-cli-runner': runner });
  const result = runCommand('scripts/check-skill-frontmatter-anti-drift.mjs', root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^OK: 2 skills\/\*\/SKILL\.md/);
});

test('the command still checks when it is started through a symlinked path', t => {
  const { root, script } = commandTree(t, OFFENDING);
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-skill-frontmatter-link-'));
  t.after(() => fs.rmSync(linkDir, { recursive: true, force: true }));
  const link = path.join(linkDir, 'check.mjs');
  fs.symlinkSync(script, link);
  const result = runCommand(link, linkDir);
  assert.equal(result.status, 1, `stdout: ${result.stdout} stderr: ${result.stderr}`);
  assert.match(result.stderr, /skills\/demo-skill\/SKILL\.md/);
  assert.ok(root);
});

test('the command still checks when node keeps symlinks in the main module path', t => {
  const { root } = commandTree(t, OFFENDING);
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-skill-frontmatter-root-link-'));
  t.after(() => fs.rmSync(linkDir, { recursive: true, force: true }));
  const linkedRoot = path.join(linkDir, 'tree');
  fs.symlinkSync(root, linkedRoot);
  const entry = path.join(linkedRoot, 'scripts', 'check-skill-frontmatter-anti-drift.mjs');
  const result = runCommand(entry, linkDir, ['--preserve-symlinks-main']);
  assert.equal(result.status, 1, `stdout: ${result.stdout} stderr: ${result.stderr}`);
  assert.match(result.stderr, /skills\/demo-skill\/SKILL\.md/);
});
