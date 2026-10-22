import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectInstructionDocuments, readInstructionDocuments } from '../lib/instruction-documents.mjs';

function fixture(t, files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-docs-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { root, entry: path.join(root, 'SKILL.md') };
}
const link = (target) => `[Read](${target} "nullius-guidance")`;

// Assert a scientific predicate against the reachable instructions, never all
// sibling files: deleting or unlinking a requirement must remove its credit.
const hasProductionCheck = (entry) => readInstructionDocuments(entry).includes('production-scale falsifier');

test('only marked links contribute rules, recursively, with repeated DAG edges deduplicated', (t) => {
  const { entry } = fixture(t, {
    'SKILL.md': link('refs/a.md') + '\n' + link('refs/b.md') + '\n[ordinary](dead.md)',
    'refs/a.md': 'first\n' + link('nested.md'),
    'refs/b.md': 'second\n' + link('nested.md'),
    'refs/nested.md': 'production-scale falsifier',
    'dead.md': 'DEAD FILE MUST NOT COUNT',
  });
  assert.equal(hasProductionCheck(entry), true);
  const docs = collectInstructionDocuments(entry);
  assert.equal(docs.length, 4);
  assert.equal(readInstructionDocuments(entry).includes('DEAD FILE MUST NOT COUNT'), false);
});

test('unmarked and unreachable dead files cannot satisfy a missing scientific rule', (t) => {
  const { root, entry } = fixture(t, {
    'SKILL.md': '[Ordinary](dead.md)\n' + link('live.md'),
    'dead.md': 'production-scale falsifier',
    'live.md': 'No such rule here.',
  });
  assert.equal(hasProductionCheck(entry), false);
  fs.writeFileSync(path.join(root, 'live.md'), 'production-scale falsifier');
  assert.equal(hasProductionCheck(entry), true);
  fs.writeFileSync(path.join(root, 'live.md'), 'Rule was removed.');
  assert.equal(hasProductionCheck(entry), false);
});

test('marked declarations in code and comments do not create hidden dependencies', (t) => {
  const { entry } = fixture(t, { 'SKILL.md': [
    '```markdown', link('missing-fenced.md'), '```',
    '~~~markdown', link('missing-tilde.md'), '~~~',
    '`' + link('missing-inline.md') + '`', '<!-- ' + link('missing-comment.md') + ' -->',
    '    ' + link('missing-indented.md'), '\t' + link('missing-tabbed.md'),
    '[Ordinary](also-missing.md)',
  ].join('\n') });
  assert.equal(collectInstructionDocuments(entry).length, 1);
});

test('Markdown fragments and angled local paths resolve without duplicate documents', (t) => {
  const { entry } = fixture(t, {
    'SKILL.md': link('guide.md#one') + '\n' + link('guide.md#two') + '\n' + link('<refs/space%20name.md>'),
    'guide.md': '# One\n# Two',
    'refs/space name.md': 'third document',
  });
  assert.equal(collectInstructionDocuments(entry).length, 3);
});

for (const [name, target] of [
  ['missing', 'missing.md'], ['escape', '../outside.md'], ['encoded escape', '%2e%2e/outside.md'],
  ['absolute', '/outside.md'], ['remote', 'https://example.com/guide.md'],
  ['query', 'guide.md?download=1'], ['non-Markdown', 'guide.txt'],
  ['invalid encoding', '%zz.md'], ['empty path', '#section'], ['multiple fragments', 'guide.md#a#b'],
  ['control', 'bad%00.md'], ['backslash', 'refs%5cguide.md'],
]) {
  test(`reject ${name} marked reference`, (t) => {
    const { entry } = fixture(t, { 'SKILL.md': link(target), 'guide.md': 'ordinary file', 'guide.txt': 'text' });
    assert.throws(() => readInstructionDocuments(entry));
  });
}

test('root boundary can be explicit but the entry cannot escape it', (t) => {
  const { root, entry } = fixture(t, { 'SKILL.md': link('refs/guide.md'), 'refs/guide.md': 'valid' });
  assert.equal(collectInstructionDocuments(entry, { root }).length, 2);
  assert.throws(() => readInstructionDocuments(entry, { root: path.join(root, 'refs') }), /escapes root/);
  assert.throws(() => readInstructionDocuments(entry, { root: entry }), /root is not a directory/);
});

test('refuse direct and indirect cycles rather than silently trimming them', (t) => {
  const { root, entry } = fixture(t, { 'SKILL.md': link('a.md'), 'a.md': link('b.md'), 'b.md': link('SKILL.md') });
  assert.throws(() => readInstructionDocuments(entry), /cycle/);
  fs.writeFileSync(path.join(root, 'a.md'), link('a.md'));
  assert.throws(() => readInstructionDocuments(entry), /cycle/);
});

test('refuse symlink documents, ancestor directories and entry roots', (t) => {
  const { root, entry } = fixture(t, { 'SKILL.md': link('linked.md'), 'real.md': 'rule', 'refs/a.md': 'rule' });
  fs.symlinkSync('real.md', path.join(root, 'linked.md'));
  assert.throws(() => readInstructionDocuments(entry), /symlink/);
  fs.writeFileSync(entry, link('linked-dir/a.md'));
  fs.symlinkSync('refs', path.join(root, 'linked-dir'));
  assert.throws(() => readInstructionDocuments(entry), /symlink/);
  const alias = path.join(root, 'alias'); fs.symlinkSync('refs', alias);
  assert.throws(() => readInstructionDocuments(path.join(alias, 'a.md')), /symlink/);
});

test('refuse a directory, non-UTF8 input and malformed reserved declaration', (t) => {
  const { root, entry } = fixture(t, { 'SKILL.md': link('refs.md/a.md'), 'refs.md/a.md': 'valid' });
  fs.writeFileSync(entry, link('refs.md'));
  assert.throws(() => readInstructionDocuments(entry), /regular file/);
  fs.writeFileSync(entry, Buffer.from([0xff]));
  assert.throws(() => readInstructionDocuments(entry), /encoded data/);
  fs.writeFileSync(entry, '[Broken](refs.md "nullius-guidance"');
  assert.throws(() => readInstructionDocuments(entry), /invalid nullius-guidance/);
});

import { checkInstructionEntrypoints } from '../check-instruction-documents-anti-drift.mjs';

test('entry guard fails missing or oversized entrances and unlinked reference closures', (t) => {
  const { root, entry } = fixture(t, { 'SKILL.md': link('rule.md'), 'rule.md': 'rule' });
  const limits = [['SKILL.md', 100, 1]];
  assert.deepEqual(checkInstructionEntrypoints(root, limits).errors, []);
  fs.writeFileSync(entry, '[Rule](rule.md)');
  assert.match(checkInstructionEntrypoints(root, limits).errors.join(' '), /reachable instruction references/);
  fs.writeFileSync(entry, 'x'.repeat(101) + '\n' + link('rule.md'));
  assert.match(checkInstructionEntrypoints(root, limits).errors.join(' '), /exceeds local cap/);
  fs.unlinkSync(entry);
  assert.notEqual(checkInstructionEntrypoints(root, limits).errors.length, 0);
});
