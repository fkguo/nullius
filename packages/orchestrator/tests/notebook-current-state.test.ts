import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_STATE_END,
  CURRENT_STATE_START,
  checkCurrentStateBlock,
  computeCurrentStateProjection,
  refreshNotebookCurrentState,
  renderCurrentStateBlock,
  type CurrentStateProjection,
} from '../src/notebook-current-state.js';
import { checkNotebookStaleness } from '../src/notebook-staleness.js';
import { stampRunDirectory } from '../src/run-stamp.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'current-state-'));
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

const notebookPath = (): string => path.join(projectRoot, 'research_notebook.md');

const EMPTY: CurrentStateProjection = { current_rows: [], total_rows: 0, issue_codes: [] };
const ONE_ROW: CurrentStateProjection = {
  current_rows: [{
    result_id: 'headline', run_id: '20260808-m1-r010-final',
    effective_commit: 'a'.repeat(40), has_snapshot: true,
    artifact: 'artifacts/runs/20260808-m1-r010-final/value.json', defective: false,
  }],
  total_rows: 1,
  issue_codes: [],
};

describe('renderCurrentStateBlock', () => {
  it('states the honest empty state when nothing is promoted', () => {
    const block = renderCurrentStateBlock(EMPTY);
    expect(block).toContain('No result is promoted yet');
    expect(block).toContain('an honest');
    expect(block.startsWith(CURRENT_STATE_START)).toBe(true);
    expect(block.endsWith(CURRENT_STATE_END)).toBe(true);
  });

  it('renders registered rows with snapshot qualifier, and marks defective rows', () => {
    const block = renderCurrentStateBlock(ONE_ROW);
    expect(block).toContain('| headline | 20260808-m1-r010-final | aaaaaaaaaaaa+snapshot |');
    const defective = renderCurrentStateBlock({
      ...ONE_ROW,
      current_rows: [{ ...ONE_ROW.current_rows[0]!, defective: true }],
    });
    expect(defective).toContain('**DEFECTIVE**');
  });
});

describe('refresh + check', () => {
  it('adopts a notebook without markers by inserting before the first section, invisibly to the classifier', () => {
    fs.writeFileSync(notebookPath(), '# Memo\n\nFront prose.\n\n## Results\n\nBody.\n');
    const before = checkNotebookStaleness(projectRoot).sections.map(section => section.heading);
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: true }).action).toBe('inserted');
    const text = fs.readFileSync(notebookPath(), 'utf-8');
    expect(text.indexOf(CURRENT_STATE_START)).toBeLessThan(text.indexOf('## Results'));
    expect(checkNotebookStaleness(projectRoot).sections.map(section => section.heading)).toEqual(before);
    expect(checkCurrentStateBlock(projectRoot, EMPTY).in_sync).toBe(true);
  });

  it('replaces template placeholder content between markers, then is idempotent', () => {
    fs.writeFileSync(notebookPath(), [
      '# Memo', '',
      CURRENT_STATE_START, '(rendered at init)', CURRENT_STATE_END,
      '', '## Results', 'Body.',
    ].join('\n'));
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: false }).action).toBe('rewritten');
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: false }).action).toBe('unchanged');
    expect(checkCurrentStateBlock(projectRoot, EMPTY).in_sync).toBe(true);
  });

  it('names the two out-of-sync causes distinctly: state moved vs hand edit', () => {
    fs.writeFileSync(notebookPath(), `# Memo\n\n${renderCurrentStateBlock(EMPTY)}\n\n## Results\n`);
    // Same bytes, new projection: the digest channel names state movement.
    const moved = checkCurrentStateBlock(projectRoot, ONE_ROW);
    expect(moved.in_sync).toBe(false);
    expect(moved.reason).toContain('state changed');
    // Edited bytes, same projection: the byte channel names the hand edit.
    fs.writeFileSync(notebookPath(), fs.readFileSync(notebookPath(), 'utf-8')
      .replace('No result is promoted yet', 'Everything is great'));
    const edited = checkCurrentStateBlock(projectRoot, EMPTY);
    expect(edited.in_sync).toBe(false);
    expect(edited.reason).toContain('hand edit');
  });

  it('refuses duplicated markers instead of guessing', () => {
    fs.writeFileSync(notebookPath(), [
      '# Memo',
      CURRENT_STATE_START, 'a', CURRENT_STATE_END,
      CURRENT_STATE_START, 'b', CURRENT_STATE_END,
      '## Results',
    ].join('\n'));
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: true }).action).toBe('skipped');
    expect(checkCurrentStateBlock(projectRoot, EMPTY).duplicated_markers).toBe(true);
  });

  it('skips a missing notebook, and skips (with the adoption hint) when markers are absent and insertion is off', () => {
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: true }).action).toBe('skipped');
    fs.writeFileSync(notebookPath(), '# Memo\n## Results\n');
    const outcome = refreshNotebookCurrentState(projectRoot, { insertIfMissing: false });
    expect(outcome.action).toBe('skipped');
    expect(outcome.reason).toContain('notebook sync');
    expect(checkCurrentStateBlock(projectRoot, EMPTY).block_found).toBe(false);
  });
});

describe('stamp hook stability', () => {
  it('a stamp renders the placeholder once; further stamps leave the block untouched (registry projection unchanged)', () => {
    execFileSync('git', ['-C', projectRoot, 'init', '-q']);
    execFileSync('git', ['-C', projectRoot, 'config', 'user.email', 't@example.com']);
    execFileSync('git', ['-C', projectRoot, 'config', 'user.name', 'T']);
    fs.writeFileSync(notebookPath(), [
      '# Memo', '',
      CURRENT_STATE_START, '(rendered at init)', CURRENT_STATE_END,
      '', '## Results', 'Body.',
    ].join('\n'));
    execFileSync('git', ['-C', projectRoot, 'add', '-A']);
    execFileSync('git', ['-C', projectRoot, 'commit', '-q', '-m', 'seed']);

    const runA = path.join(projectRoot, 'artifacts/runs/20260808-m1-r001-first');
    const runB = path.join(projectRoot, 'artifacts/runs/20260808-m1-r002-second');
    fs.mkdirSync(runA, { recursive: true });
    fs.mkdirSync(runB, { recursive: true });

    expect(stampRunDirectory(projectRoot, runA, { actor: 'test' }).kind).toBe('stamped');
    const afterFirst = fs.readFileSync(notebookPath(), 'utf-8');
    expect(afterFirst).toContain('No result is promoted yet');
    expect(checkCurrentStateBlock(projectRoot, computeCurrentStateProjection(projectRoot)).in_sync).toBe(true);

    expect(stampRunDirectory(projectRoot, runB, { actor: 'test' }).kind).toBe('stamped');
    // Stamp-stability by construction: the second stamp changes no
    // registry-relevant state, so the notebook bytes are identical.
    expect(fs.readFileSync(notebookPath(), 'utf-8')).toBe(afterFirst);
  });
});
