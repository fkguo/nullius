import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXEMPTION_MARKER, scanSourceLanguage, sourceRoots } from '../check-source-language-anti-drift.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-source-language-anti-drift.mjs');

function fixtureRoot(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-source-language-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const write = (rel, content) => {
    const target = path.join(base, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write('packages/alpha/src/index.ts', 'export const greeting = "hello";\n');
  write('packages/alpha/src/nested/util.py', 'def f():\n    return 1\n');
  write('packages/beta/README.md', '# 中文说明\n');
  write('packages/beta/src/ok.ts', 'export const x = 1;\n');
  return { base, write };
}

test('the real repository has no CJK characters under packages/*/src', () => {
  const { files, hits } = scanSourceLanguage({ repoRoot });
  assert.ok(files > 100, `expected to scan many source files, scanned ${files}`);
  assert.deepEqual(hits, []);
});

test('CLI entry exits 0 on the real repository', () => {
  const result = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /carry no CJK characters/);
});

test('scans only packages/*/src and only .ts/.py files', t => {
  const { base, write } = fixtureRoot(t);
  write('packages/alpha/src/notes.md', '中文\n');          // not a source extension
  write('packages/alpha/tests/t.ts', '// 测试\n');        // not under src/
  write('skills/x/scripts/run.py', 'TOKENS = ["通过"]\n'); // outside packages/
  assert.deepEqual(sourceRoots(base).map(p => path.relative(base, p)), ['packages/alpha/src', 'packages/beta/src']);
  const { files, hits } = scanSourceLanguage({ repoRoot: base });
  assert.equal(files, 3);
  assert.deepEqual(hits, []);
});

test('a CJK character in a comment, string or identifier is reported with file:line', t => {
  const { base, write } = fixtureRoot(t);
  write('packages/alpha/src/bad.ts', [
    '// 这是注释',
    'export const label = "结果";',
    'const 变量 = 1;',
    'export const fine = "ok";',
    '',
  ].join('\n'));
  write('packages/alpha/src/bad.py', '# コメント\nx = "한글"\n');
  const { hits } = scanSourceLanguage({ repoRoot: base });
  assert.deepEqual(hits.map(h => `${h.file}:${h.line}`), [
    'packages/alpha/src/bad.py:1',
    'packages/alpha/src/bad.py:2',
    'packages/alpha/src/bad.ts:1',
    'packages/alpha/src/bad.ts:2',
    'packages/alpha/src/bad.ts:3',
  ]);
});

test('generated/ directories and CONTRACT-EXEMPT lines are skipped', t => {
  const { base, write } = fixtureRoot(t);
  write('packages/alpha/src/generated/model.py', 'description = "描述"\n');
  write('packages/alpha/src/terms.ts', `export const term = "夸克"; // ${EXEMPTION_MARKER} physics term used verbatim in a data file\n`);
  write('packages/alpha/src/terms2.ts', 'export const other = "胶子";\n');
  const { hits } = scanSourceLanguage({ repoRoot: base });
  assert.deepEqual(hits.map(h => `${h.file}:${h.line}`), ['packages/alpha/src/terms2.ts:1']);
});

test('CLI entry exits 1 and lists every hit on a violating tree', t => {
  const { base, write } = fixtureRoot(t);
  write('packages/alpha/src/bad.ts', 'export const label = "结果";\n');
  const scriptCopyDir = path.join(base, 'scripts');
  fs.mkdirSync(scriptCopyDir, { recursive: true });
  fs.copyFileSync(scriptPath, path.join(scriptCopyDir, 'check.mjs'));
  const result = spawnSync(process.execPath, [path.join(scriptCopyDir, 'check.mjs')], { cwd: base, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL \(LANG-01\): 1 line/);
  assert.match(result.stderr, /packages\/alpha\/src\/bad\.ts:1/);
  assert.match(result.stderr, new RegExp(EXEMPTION_MARKER.replace(/[-:]/g, '\\$&')));
});
