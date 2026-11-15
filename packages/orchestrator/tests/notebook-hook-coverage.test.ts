import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { parseCliArgs } from '../src/cli-args.js';
import { checkRunIndexBlock, computeRunIndexProjection } from '../src/run-index.js';
import { validateResultRegistry } from '../src/result-registry.js';
import { readValidityLedger } from '../src/validity-ledger.js';

let root: string;
let notebook: string;
let original: Buffer;
const scientificNote = '# 研究笔记\r\n\r\n## Estimate\r\nAssuming independent errors, α = 0.12 ± 0.03.\r\nSee [derivation](docs/estimate.md).\r\n';
const historicalBlock = [
  '<!-- NOTEBOOK_CURRENT_STATE_START -->',
  `<!-- state-digest: ${'a'.repeat(64)} -->`,
  '| Result | Artifact |',
  '|---|---|',
  '| previous | [old evidence](docs/previous.md) |',
  '<!-- NOTEBOOK_CURRENT_STATE_END -->',
  '',
].join('\r\n');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-ownership-'));
  notebook = path.join(root, 'research_notebook.md');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function expectAuthoredBytes(): void {
  expect(fs.readFileSync(notebook)).toEqual(original);
  expect(fs.statSync(notebook).mode & 0o7777).toBe(0o640);
}

async function command(args: string[]): Promise<string> {
  let output = ''; let errors = '';
  const code = await runCli(args, { cwd: root,
    stdout: text => { output += text; }, stderr: text => { errors += text; } });
  expect(code, errors).toBe(0);
  expectAuthoredBytes();
  return output;
}

function git(...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
}

function makeRun(id: string): void {
  fs.mkdirSync(path.join(root, 'artifacts/runs', id), { recursive: true });
}

describe('lifecycle writes preserve the user-owned notebook', () => {
  it.each([
    ['scientific CRLF prose', Buffer.from(scientificNote)],
    ['historical machine table with scientific CRLF prose', Buffer.from(historicalBlock + scientificNote)],
    ['ambiguous historical markers with scientific CRLF prose', Buffer.from('<!-- NOTEBOOK_CURRENT_STATE_START -->\r\n' + historicalBlock + scientificNote)],
    ['non-round-tripping historical bytes', Buffer.concat([Buffer.from([0xff]), Buffer.from(scientificNote)])],
  ] as const)('preserves %s through init, runtime reconnect and scaffold refresh', async (_label, bytes) => {
    original = bytes;
    fs.writeFileSync(notebook, original, { mode: 0o640 });
    await command(['init']);
    await command(['init', '--runtime-only']);
    await command(['init', '--refresh']);
  });

  it('records stamps, adoption and validity changes in the ledger/index while leaving old notebook bytes untouched', async () => {
    original = Buffer.from(historicalBlock + scientificNote);
    fs.writeFileSync(notebook, original, { mode: 0o640 });
    await command(['init']);
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs/estimate.md'), 'Estimate α = 0.12 ± 0.03.\n');
    git('add', '-A'); git('commit', '-qm', 'scientific fixture');

    const first = '20261001-estimate-r1';
    const second = '20261001-estimate-r2';
    makeRun(first); makeRun(second);
    await command(['trace', 'stamp', path.join('artifacts/runs', first)]);
    await command(['trace', 'stamp', path.join('artifacts/runs', second)]);
    expect(readValidityLedger(root).runs.get(first)?.stamped).toBe(true);
    expect(computeRunIndexProjection(root).run_directories).toBe(2);
    expect(checkRunIndexBlock(root, computeRunIndexProjection(root)).in_sync).toBe(true);

    await command(['result', 'set-current', 'estimate', '--run', first, '--artifact', 'docs/estimate.md']);
    expect(validateResultRegistry(root).current[0]).toMatchObject({ result_id: 'estimate', run_id: first });
    await command(['trace', 'void', first, '--reason', 'calibration under review']);
    expect(readValidityLedger(root).runs.get(first)?.validity).toBe('void');
    expect(validateResultRegistry(root).defective_result_ids.has('estimate')).toBe(true);
    await command(['trace', 'reinstate', first, '--reason', 'calibration verified']);
    expect(readValidityLedger(root).runs.get(first)?.validity).toBe('active');
    await command(['trace', 'supersede', first, '--by', second, '--reason', 'improved estimator']);
    expect(readValidityLedger(root).runs.get(first)?.superseded_by).toBe(second);
    expect(checkRunIndexBlock(root, computeRunIndexProjection(root)).in_sync).toBe(true);

    const older = '20261002-check-r1';
    const newer = '20261002-check-r2';
    makeRun(older); makeRun(newer);
    await command(['trace', 'backfill']);
    expect(readValidityLedger(root).runs.get(older)?.stamped).toBe(true);
    await command(['trace', 'propose-chains']);
    await command(['trace', 'confirm-chains']);
    expect(readValidityLedger(root).runs.get(older)?.superseded_by).toBe(newer);
    expect(checkRunIndexBlock(root, computeRunIndexProjection(root)).in_sync).toBe(true);
  }, 30_000);

  it('rejects the retired sync command before any notebook write and retains read-only check/review commands', async () => {
    original = Buffer.from(historicalBlock + scientificNote);
    fs.writeFileSync(notebook, original, { mode: 0o640 });
    expect(() => parseCliArgs(['notebook', 'sync'])).toThrow('unknown notebook subcommand: sync');
    await expect(runCli(['notebook', 'sync'], { cwd: root, stdout: () => {}, stderr: () => {} }))
      .rejects.toThrow('unknown notebook subcommand: sync');
    expectAuthoredBytes();
    expect(parseCliArgs(['notebook', 'check', '--structure-only'])).toMatchObject({ command: 'notebook', action: 'check' });
    expect(parseCliArgs(['notebook', 'review', '--model', 'test-model'])).toMatchObject({ command: 'notebook', action: 'review' });
    let help = '';
    await runCli(['notebook', '--help'], { cwd: root, stdout: text => { help += text; }, stderr: () => {} });
    expect(help).not.toContain('notebook sync');
    expect(help).toContain('without modifying it');
    expectAuthoredBytes();
  });
});
