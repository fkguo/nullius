import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { _setAtomicWriteAuditHook } from '@nullius/shared';
import { setCurrentResult, parseResultRegistry } from '../src/result-registry.js';
import { refreshRunIndexBlock } from '../src/run-index.js';
import { stampRunDirectory } from '../src/run-stamp.js';

let root: string;
let restore: (() => void) | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-owner-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
  git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, '.gitignore'), 'artifacts/\n.nullius/\n*.lock\n');
  fs.writeFileSync(path.join(root, 'project_index.md'), [
    '# Human index', '', 'Human prose.', '', '<!-- RESULT_REGISTRY_START -->',
    '| Result | Description | SHA-256 | Run | Supersedes | Superseded by |',
    '| --- | --- | --- | --- | --- | --- |', '<!-- RESULT_REGISTRY_END -->', '',
    '<!-- RUN_INDEX_START -->', '(Generated run index.)', '<!-- RUN_INDEX_END -->', '',
  ].join('\r\n'));
  git('add', '.'); git('commit', '-qm', 'fixture');
  fs.mkdirSync(path.join(root, 'artifacts/runs/r1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifacts/runs/r1/result.txt'), 'original output');
  expect(stampRunDirectory(root, 'artifacts/runs/r1', { actor: 'fixture' }).kind).toBe('stamped');
  fs.chmodSync(path.join(root, 'project_index.md'), 0o600);
});
afterEach(() => { restore?.(); restore = undefined; fs.rmSync(root, { recursive: true, force: true }); });

const selection = { resultId: 'value', runId: 'r1', artifactRelPath: 'artifacts/runs/r1/result.txt' };
function atCarrierWrite(action: () => void): void {
  let carrierFd: number | undefined;
  restore = _setAtomicWriteAuditHook(event => {
    if (event.kind === 'open' && event.path.includes('project_index.md') && event.path.includes('.tmp')) carrierFd = event.fd;
    if (event.kind === 'write' && event.fd === carrierFd) action();
  });
}

it('retains a human edit and carrier EOL/mode through fresh registry recomputation', () => {
  let edits = 0;
  atCarrierWrite(() => {
    if (edits++ === 0) {
      const file = path.join(root, 'project_index.md');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Human prose.', 'Human edited prose.'));
    }
  });
  setCurrentResult(root, selection);
  const text = fs.readFileSync(path.join(root, 'project_index.md'), 'utf8');
  expect(text).toContain('Human edited prose.\r\n');
  expect(text.replaceAll('\r\n', '')).not.toContain('\n');
  expect(fs.statSync(path.join(root, 'project_index.md')).mode & 0o7777).toBe(0o600);
  expect(parseResultRegistry(root).current.map(row => row.result_id)).toEqual(['value']);
  expect(edits).toBe(2);
});

it('revalidates a changed artifact before publishing its registry hash', () => {
  let edits = 0;
  atCarrierWrite(() => { if (edits++ === 0) fs.writeFileSync(path.join(root, selection.artifactRelPath), 'new output'); });
  const result = setCurrentResult(root, selection);
  expect(result.row.artifact_sha256).toBe(createHash('sha256').update('new output').digest('hex'));
  expect(edits).toBe(2);
});

it('preserves mixed-EOL human bytes inside the registry through a concurrent edit and row replacement', () => {
  const file = path.join(root, 'project_index.md');
  fs.chmodSync(file, 0o640);
  const before = fs.readFileSync(file, 'utf8');
  const start = '<!-- RESULT_REGISTRY_START -->';
  const end = '<!-- RESULT_REGISTRY_END -->';
  const human = '## Human owned interior\r\nHuman conflict bytes\tstay\n';
  let writes = 0;
  atCarrierWrite(() => {
    if (writes++ === 0) {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(end, human + end));
    }
  });
  setCurrentResult(root, selection);
  expect(writes).toBe(2);
  setCurrentResult(root, selection);
  const after = fs.readFileSync(file);
  expect(after.includes(Buffer.from(human))).toBe(true);
  expect(after.toString().slice(0, after.toString().indexOf(start))).toBe(before.slice(0, before.indexOf(start)));
  expect(after.toString().slice(after.toString().indexOf(end))).toBe(before.slice(before.indexOf(end)));
  expect(fs.statSync(file).mode & 0o7777).toBe(0o640);
  expect(parseResultRegistry(root).current.map(row => row.result_id)).toEqual(['value']);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});

it('preserves a superseded row delimiter and unrelated mixed-EOL content', () => {
  const file = path.join(root, 'project_index.md');
  setCurrentResult(root, { ...selection, resultId: 'prior' });
  const human = 'Human interior\tbytes\n';
  const before = fs.readFileSync(file, 'utf8').replace(/(\| `prior`[^\n]*)\r\n/, '$1\n')
    .replace('<!-- RESULT_REGISTRY_END -->', human + '<!-- RESULT_REGISTRY_END -->');
  fs.writeFileSync(file, before);
  setCurrentResult(root, { ...selection, supersedes: 'prior' });
  const after = fs.readFileSync(file, 'utf8');
  expect(after).toContain(human);
  const priorLine = after.split('\n').find(line => line.startsWith('| `prior`'))!;
  expect(priorLine.endsWith('\r')).toBe(false);
  expect(parseResultRegistry(root).rows.find(row => row.result_id === 'prior')?.superseded_by).toBe('value');
});

it('exhausts bounded registry retries without publishing a stale row', () => {
  let edits = 0;
  atCarrierWrite(() => {
    edits += 1;
    fs.appendFileSync(path.join(root, 'project_index.md'), `Human edit ${edits}\r\n`);
  });
  expect(() => setCurrentResult(root, selection)).toThrow('no stale row was written');
  expect(edits).toBe(3);
  expect(parseResultRegistry(root).rows).toEqual([]);
  expect(fs.readFileSync(path.join(root, 'project_index.md'), 'utf8')).toContain('Human edit 3\r\n');
  expect(fs.existsSync(path.join(root, 'project_index.md.lock'))).toBe(false);
});

it('uses the same held path lock for registry and derived-block writers', () => {
  const file = path.join(root, 'project_index.md');
  const before = fs.readFileSync(file);
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 123, ts: 'fixture' }));
  expect(() => setCurrentResult(root, selection)).toThrow('ledger is locked');
  expect(() => refreshRunIndexBlock(root)).toThrow('ledger is locked');
  expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.existsSync(`${file}.lock`)).toBe(true);
}, 10000);

it('refuses non-round-tripping carrier bytes before registry or derived writes', () => {
  const index = path.join(root, 'project_index.md');
  const before = Buffer.concat([Buffer.from([0x80]), fs.readFileSync(index)]);
  fs.writeFileSync(index, before);
  expect(() => setCurrentResult(root, selection)).toThrow('not valid UTF-8');
  expect(refreshRunIndexBlock(root).reason).toContain('not valid UTF-8');
  expect(fs.readFileSync(index)).toEqual(before);
  expect(fs.statSync(index).mode & 0o7777).toBe(0o600);

});

it.each(['target', 'superseded', 'unrelated'])('refuses a duplicate %s ID without rewriting any ambiguous row', (kind) => {
  const file = path.join(root, 'project_index.md');
  setCurrentResult(root, { ...selection, resultId: 'prior' });
  const original = fs.readFileSync(file, 'utf8');
  const prior = original.match(/^\| `prior`[^\n]*/m)![0].replace(/\r$/, '');
  const duplicated = original.replace('<!-- RESULT_REGISTRY_END -->', `${prior.replace('[prior](', '[Human second description](')}\n<!-- RESULT_REGISTRY_END -->`);
  fs.writeFileSync(file, duplicated);
  const before = fs.readFileSync(file);
  let writes = 0;
  atCarrierWrite(() => { writes += 1; });
  const input = kind === 'target' ? { ...selection, resultId: 'prior' }
    : kind === 'superseded' ? { ...selection, supersedes: 'prior' } : selection;
  expect(() => setCurrentResult(root, input)).toThrow(/duplicate.*prior/i);
  expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.statSync(file).mode & 0o7777).toBe(0o600);
  expect(writes).toBe(0);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});

it('refuses an acknowledged concurrent duplicate without flattening its human description', () => {
  const file = path.join(root, 'project_index.md');
  setCurrentResult(root, { ...selection, resultId: 'prior' });
  let humanBytes: Buffer | undefined;
  let writes = 0;
  atCarrierWrite(() => {
    writes += 1;
    const current = fs.readFileSync(file, 'utf8');
    const prior = current.match(/^\| `prior`[^\n]*/m)![0].replace(/\r$/, '');
    const edited = current.replace('<!-- RESULT_REGISTRY_END -->', `${prior.replace('[prior](', '[Human concurrent description](')}\n<!-- RESULT_REGISTRY_END -->`);
    humanBytes = Buffer.from(edited);
    fs.writeFileSync(file, humanBytes);
  });
  expect(() => setCurrentResult(root, selection)).toThrow(/duplicate.*prior/i);
  expect(writes).toBe(1);
  expect(fs.readFileSync(file)).toEqual(humanBytes);
  expect(parseResultRegistry(root).rows.some(row => row.result_id === 'value')).toBe(false);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});
