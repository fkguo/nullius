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
import { buildTraceabilityView } from '../src/traceability-view.js';
import { appendValidityEvent, buildValidityEvent } from '../src/validity-ledger.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'current-state-'));
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

const notebookPath = (): string => path.join(projectRoot, 'research_notebook.md');

const EMPTY: CurrentStateProjection = {
  registry_block_found: true, current_rows: [], total_rows: 0, issue_codes: [],
};
const NO_REGISTRY: CurrentStateProjection = { ...EMPTY, registry_block_found: false };
const ONE_ROW: CurrentStateProjection = {
  registry_block_found: true,
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

  it('never calls a MISSING registry an honest empty state', () => {
    const block = renderCurrentStateBlock({ ...EMPTY, registry_block_found: false });
    expect(block).not.toContain('No result is promoted yet');
    expect(block).toContain('no results-registry block');
    expect(block).toContain('RESULT_REGISTRY');
  });

  it('reports zero-parsed-rows-with-issues as a possible unseen row, and always renders issue codes', () => {
    const block = renderCurrentStateBlock({ ...EMPTY, issue_codes: ['malformed_result_row'] });
    expect(block).not.toContain('No result is promoted yet');
    expect(block).toContain('a written row may be going unseen');
    expect(block).toContain('malformed_result_row');
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
    expect(checkCurrentStateBlock(projectRoot, NO_REGISTRY).in_sync).toBe(true);
  });

  it('replaces template placeholder content between markers, then is idempotent', () => {
    fs.writeFileSync(notebookPath(), [
      '# Memo', '',
      CURRENT_STATE_START, '(rendered at init)', CURRENT_STATE_END,
      '', '## Results', 'Body.',
    ].join('\n'));
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: false }).action).toBe('rewritten');
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: false }).action).toBe('unchanged');
    expect(checkCurrentStateBlock(projectRoot, NO_REGISTRY).in_sync).toBe(true);
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

  it('two garbage pairs are strays (no machine interior = no claim), and adoption refuses', () => {
    fs.writeFileSync(notebookPath(), [
      '# Memo',
      CURRENT_STATE_START, 'a', CURRENT_STATE_END,
      CURRENT_STATE_START, 'b', CURRENT_STATE_END,
      '## Results',
    ].join('\n'));
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: true }).action).toBe('skipped');
    const status = checkCurrentStateBlock(projectRoot, EMPTY);
    expect(status.duplicated_markers).toBe(false);
    expect(status.reason).toContain('stray');
  });

  it('stray unpaired marker lines are NOT duplication (claim nothing, advisory only), and block adoption', () => {
    fs.writeFileSync(notebookPath(), [
      '# Memo',
      CURRENT_STATE_START,
      'prose that mentions markers twice',
      CURRENT_STATE_START,
      '## Results',
    ].join('\n'));
    const status = checkCurrentStateBlock(projectRoot, EMPTY);
    expect(status.duplicated_markers).toBe(false);
    expect(status.block_found).toBe(false);
    expect(status.in_sync).toBe(null);
    expect(status.reason).toContain('stray');
    const outcome = refreshNotebookCurrentState(projectRoot, { insertIfMissing: true });
    expect(outcome.action).toBe('skipped');
    expect(outcome.reason).toContain('stray');
  });

  it('preserves the researcher\'s own file mode across a refresh', () => {
    fs.writeFileSync(notebookPath(), [
      '# Memo', '',
      CURRENT_STATE_START, '(rendered at init)', CURRENT_STATE_END,
      '', '## Results',
    ].join('\n'));
    fs.chmodSync(notebookPath(), 0o600);
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: false }).action).toBe('rewritten');
    expect(fs.statSync(notebookPath()).mode & 0o777).toBe(0o600);
  });

  it('one complete block plus a stray marker stays advisory: in_sync judged, never duplicated', () => {
    fs.writeFileSync(notebookPath(), [
      '# Memo', '',
      renderCurrentStateBlock(NO_REGISTRY), '',
      CURRENT_STATE_START, // botched hand edit left a stray START below the real block
      '', '## Results', 'Body.',
    ].join('\n'));
    const status = checkCurrentStateBlock(projectRoot, NO_REGISTRY);
    expect(status.duplicated_markers).toBe(false);
    expect(status.block_found).toBe(true);
    expect(status.in_sync).toBe(true);
    expect(status.reason).toContain('stray');
  });

  it('a stray START above the real block can NEVER swallow the prose between them (innermost pairing)', () => {
    const realBlock = renderCurrentStateBlock(NO_REGISTRY);
    fs.writeFileSync(notebookPath(), [
      '# Memo',
      CURRENT_STATE_START, // stray leftover from a botched hand repair
      'Front matter prose the researcher wrote.',
      '## Results',
      'Real analysis prose here.',
      realBlock,
      '## Method',
    ].join('\n'));
    const status = checkCurrentStateBlock(projectRoot, NO_REGISTRY);
    expect(status.duplicated_markers).toBe(false);
    expect(status.block_found).toBe(true);
    // The real block sits after the first heading → out of position; the
    // refresh RELOCATES exactly the real block and touches nothing else.
    expect(status.in_sync).toBe(false);
    const outcome = refreshNotebookCurrentState(projectRoot, { insertIfMissing: false });
    expect(outcome.action).toBe('rewritten');
    const text = fs.readFileSync(notebookPath(), 'utf-8');
    expect(text).toContain('Front matter prose the researcher wrote.');
    expect(text).toContain('## Results');
    expect(text).toContain('Real analysis prose here.');
    expect(text).toContain('## Method');
  });

  it('a lone stray pair wrapped around researcher prose is NEVER a rewritable block (interior validation)', () => {
    for (const interior of [
      ['## Results', 'Six months of analysis prose.', 'Another finding.'], // heading inside
      ['Front-matter paragraph one.', '', 'Front-matter paragraph two.'], // blank line, no digest
      ['  ## Indented heading', 'Contiguous prose.'], // 1-3 space heading is still a heading
      [`<!-- state-digest: ${'a'.repeat(63)} -->`, 'Contiguous researcher prose.'], // corrupted digest, no blank
      ['A prose sentence first.', `<!-- state-digest: ${'a'.repeat(64)} -->`], // valid digest NOT on the first line
      [`Research note <!-- state-digest: ${'a'.repeat(64)} -->`], // prose sharing the digest line
      [`\t<!-- state-digest: ${'a'.repeat(64)} -->`], // tab-indented digest line is code, not a machine block
      ['(', '### Interpretation', 'The extrapolation caveat is scientifically material.', ')'], // parenthesized smuggle with ### heading
      ['(' + 'x'.repeat(450) + ')'], // parenthetical over the byte cap
      // missing-END topology: genuine digest first, researcher sections
      // below (the real END was deleted; a leftover END closes the pair)
      [`<!-- state-digest: ${'a'.repeat(64)} -->`, '**Current state (auto-maintained).** lead', '## Results', 'Six months of prose.'],
      ['(Findings', '==='], // parenthetical smuggle via setext underline
    ]) {
      fs.writeFileSync(notebookPath(), [
        '# Memo',
        CURRENT_STATE_START,
        ...interior,
        CURRENT_STATE_END,
        '## Method', 'Method prose.',
      ].join('\n'));
      const status = checkCurrentStateBlock(projectRoot, NO_REGISTRY);
      expect(status.block_found).toBe(false);
      expect(status.duplicated_markers).toBe(false);
      expect(status.reason).toContain('stray');
      // Adoption refuses; nothing is ever spliced.
      const before = fs.readFileSync(notebookPath(), 'utf-8');
      expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: true }).action).toBe('skipped');
      expect(fs.readFileSync(notebookPath(), 'utf-8')).toBe(before);
      for (const line of interior) {
        if (line) expect(before).toContain(line);
      }
    }
  });

  it('an EMPTY interior self-heals: rewritable, not a permanent invisible blocker', () => {
    fs.writeFileSync(notebookPath(), [
      '# Memo', '',
      CURRENT_STATE_START, CURRENT_STATE_END,
      '', '## Results', 'Body.',
    ].join('\n'));
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: false }).action).toBe('rewritten');
    expect(checkCurrentStateBlock(projectRoot, NO_REGISTRY).in_sync).toBe(true);
    const text = fs.readFileSync(notebookPath(), 'utf-8');
    expect(text).toContain('## Results');
    expect(text).toContain('Body.');
  });

  it('nested garbage pairs are strays (no valid claim) and refresh refuses to write', () => {
    fs.writeFileSync(notebookPath(), [
      '# Memo',
      CURRENT_STATE_START, CURRENT_STATE_START, 'inner', CURRENT_STATE_END, CURRENT_STATE_END,
      '## Results',
    ].join('\n'));
    const status = checkCurrentStateBlock(projectRoot, NO_REGISTRY);
    expect(status.duplicated_markers).toBe(false);
    expect(status.block_found).toBe(false);
    expect(status.reason).toContain('stray');
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: true }).action).toBe('skipped');
  });

  it('two sibling rendered blocks are duplicated (ambiguous claim) and refresh refuses to write', () => {
    fs.writeFileSync(notebookPath(), [
      '# Memo', '',
      renderCurrentStateBlock(NO_REGISTRY), '',
      renderCurrentStateBlock(EMPTY), '',
      '## Results',
    ].join('\n'));
    expect(checkCurrentStateBlock(projectRoot, NO_REGISTRY).duplicated_markers).toBe(true);
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: true }).action).toBe('skipped');
  });

  it('markers inside four-space-indented code are examples, not blocks', () => {
    fs.writeFileSync(notebookPath(), [
      '# Memo', '',
      renderCurrentStateBlock(NO_REGISTRY), '',
      '## Documentation', '',
      `    ${CURRENT_STATE_START}`,
      '    example',
      `    ${CURRENT_STATE_END}`,
    ].join('\n'));
    const status = checkCurrentStateBlock(projectRoot, NO_REGISTRY);
    expect(status.duplicated_markers).toBe(false);
    expect(status.in_sync).toBe(true);
  });

  it('names a never-rendered block (template placeholder, no digest line) as its own cause', () => {
    fs.writeFileSync(notebookPath(), [
      '# Memo', '',
      CURRENT_STATE_START, '(rendered at init)', CURRENT_STATE_END,
      '', '## Results',
    ].join('\n'));
    const status = checkCurrentStateBlock(projectRoot, EMPTY);
    expect(status.in_sync).toBe(false);
    expect(status.reason).toContain('never rendered');
  });

  it('treats a CRLF notebook as in sync and splices CRLF back on rewrite', () => {
    const lf = `# Memo\n\n${renderCurrentStateBlock(NO_REGISTRY)}\n\n## Results\nBody.\n`;
    fs.writeFileSync(notebookPath(), lf.replace(/\n/g, '\r\n'));
    expect(checkCurrentStateBlock(projectRoot, NO_REGISTRY).in_sync).toBe(true);
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: false }).action).toBe('unchanged');
    // A projection change rewrites the block but preserves the file's EOL
    // flavor. Simulate it with a DIFFERENT VALID 64-hex digest — a
    // length-corrupted digest line is deliberately treated as a stray pair
    // (blank-containing interiors without a valid digest are never
    // destructively rewritten).
    fs.writeFileSync(notebookPath(), lf
      .replace(/state-digest: ([0-9a-f])/, (_m, c: string) => `state-digest: ${c === '0' ? '1' : '0'}`)
      .replace(/\n/g, '\r\n'));
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: false }).action).toBe('rewritten');
    const text = fs.readFileSync(notebookPath(), 'utf-8');
    expect(text).toContain('\r\n');
    expect(checkCurrentStateBlock(projectRoot, NO_REGISTRY).in_sync).toBe(true);
  });

  it('a memo with no ## heading gets the block after its title, never glued to EOF prose', () => {
    fs.writeFileSync(notebookPath(), '# Memo\nProse only, single-hash sections.\nLast line without newline');
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: true }).action).toBe('inserted');
    const text = fs.readFileSync(notebookPath(), 'utf-8');
    expect(text.startsWith(`# Memo\n\n${CURRENT_STATE_START}`)).toBe(true);
    expect(text).not.toContain(`newline${CURRENT_STATE_START}`);
    expect(checkCurrentStateBlock(projectRoot, NO_REGISTRY).in_sync).toBe(true);
  });

  it('a fenced example quoting the markers is neither a block nor duplication', () => {
    fs.writeFileSync(notebookPath(), [
      '# Memo', '',
      renderCurrentStateBlock(NO_REGISTRY),
      '', '## Mechanism notes',
      '```', CURRENT_STATE_START, 'example', CURRENT_STATE_END, '```',
    ].join('\n'));
    const status = checkCurrentStateBlock(projectRoot, NO_REGISTRY);
    expect(status.duplicated_markers).toBe(false);
    expect(status.in_sync).toBe(true);
  });

  it('a canonical block moved below a heading is out of sync, and sync relocates it to front matter', () => {
    fs.writeFileSync(notebookPath(), [
      '# Memo', '', '## Results', 'Body.', '',
      renderCurrentStateBlock(NO_REGISTRY), '',
    ].join('\n'));
    const status = checkCurrentStateBlock(projectRoot, NO_REGISTRY);
    expect(status.in_sync).toBe(false);
    expect(status.reason).toContain('front matter');
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: false }).action).toBe('rewritten');
    const text = fs.readFileSync(notebookPath(), 'utf-8');
    expect(text.indexOf(CURRENT_STATE_START)).toBeLessThan(text.indexOf('## Results'));
    expect(checkCurrentStateBlock(projectRoot, NO_REGISTRY).in_sync).toBe(true);
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
  it('stamps of unregistered runs never touch the notebook at all (cheap pre-check, zero churn)', () => {
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
    const beforeStamps = fs.readFileSync(notebookPath(), 'utf-8');

    const runA = path.join(projectRoot, 'artifacts/runs/20260808-m1-r001-first');
    const runB = path.join(projectRoot, 'artifacts/runs/20260808-m1-r002-second');
    fs.mkdirSync(runA, { recursive: true });
    fs.mkdirSync(runB, { recursive: true });
    expect(stampRunDirectory(projectRoot, runA, { actor: 'test' }).kind).toBe('stamped');
    expect(stampRunDirectory(projectRoot, runB, { actor: 'test' }).kind).toBe('stamped');
    // Neither run is referenced by project_index.md, so the hot path skips
    // the projection entirely: the notebook bytes are untouched — the
    // placeholder render is init's and sync's job, not the stamp path's.
    expect(fs.readFileSync(notebookPath(), 'utf-8')).toBe(beforeStamps);

    // Rendering the placeholder is one `notebook sync` away.
    expect(refreshNotebookCurrentState(projectRoot, { insertIfMissing: true }).action).toBe('rewritten');
    expect(fs.readFileSync(notebookPath(), 'utf-8')).toContain('no results-registry block');
    expect(checkCurrentStateBlock(projectRoot, computeCurrentStateProjection(projectRoot)).in_sync).toBe(true);
  });
});

describe('gate key binding', () => {
  it('the view JSON carries the exact key paths the fold gate reads', () => {
    // The Python gate degrades OPEN on a missing key (deliberate launcher
    // compatibility), so a silent rename on the TS side would disarm both
    // new refusals with every suite green. Pin the key paths here.
    execFileSync('git', ['-C', projectRoot, 'init', '-q']);
    const deadRun = '20260808-m1-r001-early';
    fs.writeFileSync(notebookPath(),
      `# Memo\n\n## Results\nThe value came from [this run](artifacts/runs/${deadRun}/out.tsv).\n`);
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void', run_id: deadRun, actor: 'test', reason: 'bad configuration',
    }));
    const view = JSON.parse(JSON.stringify(buildTraceabilityView(projectRoot))) as Record<string, any>;
    const notebook = view.notebook as Record<string, any>;
    expect(notebook).toHaveProperty('current_state_block');
    for (const key of ['notebook_found', 'block_found', 'duplicated_markers', 'in_sync', 'reason']) {
      expect(Object.keys(notebook.current_state_block as object)).toContain(key);
    }
    expect(notebook).toHaveProperty('run_links');
    // The gate destructures entry.section / entry.run_id / entry.validity:
    // pin those exact keys on a REAL entry so a TS-side rename cannot leave
    // every suite green while both refusals stop firing.
    const dead = notebook.run_links.unacknowledged_dead as Array<Record<string, unknown>>;
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ section: 'Results', run_id: deadRun, validity: 'void' });
  });
});
