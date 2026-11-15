import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ValidityEventV1 } from '@nullius/shared';
import { analyzeNotebookRunLinks, notebookSectionLinkTargets } from '../src/notebook-run-links.js';
import type { ValidityLedgerView, RunValidity } from '../src/validity-ledger.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-links-'));
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function syntheticLedger(entries: Array<{
  id: string;
  ts: string;
  validity?: RunValidity['validity'];
  supersededBy?: string | null;
}>): ValidityLedgerView {
  const runs = new Map<string, RunValidity>();
  const events: ValidityEventV1[] = [];
  for (const entry of entries) {
    runs.set(entry.id, {
      run_id: entry.id,
      validity: entry.validity ?? 'active',
      superseded_by: entry.supersededBy ?? null,
      reason: null,
      scoped_annotations: [],
      stamped: true,
      origin: null,
      conflicting_stamps: false,
      no_authoritative_identity: false,
    });
    events.push({
      event: 'stamp', run_id: entry.id, ts_utc: entry.ts,
    } as unknown as ValidityEventV1);
  }
  return {
    ledger_path: path.join(projectRoot, 'artifacts/runs/validity_ledger.jsonl'),
    exists: true,
    events,
    malformed_lines: 0,
    integrity_defects: [],
    runs,
  };
}

function writeNotebook(markdown: string): void {
  fs.writeFileSync(path.join(projectRoot, 'research_notebook.md'), markdown);
}

function runId(index: number): string {
  return `20260808-m1-r${String(index).padStart(3, '0')}-object`;
}

function ascendingLedger(count: number): ValidityLedgerView {
  return syntheticLedger(Array.from({ length: count }, (_, i) => ({
    id: runId(i + 1),
    ts: `2026-08-08T0${Math.floor(i / 6)}:0${i % 6}:00.000Z`,
  })));
}

describe('objective notebook run references', () => {
  it('excludes formula link syntax while retaining a visible body link to the same run', () => {
    const formula = '## Results\n\n$$\n[x](artifacts/runs/result/output.md)\n$$\n\n'
      + 'Inline $[y](artifacts/runs/result/output.md)$ notation.\n';
    expect(notebookSectionLinkTargets(formula)).toEqual([{ heading: 'Results', targets: [] }]);
    writeNotebook(formula);
    expect(analyzeNotebookRunLinks(projectRoot, syntheticLedger([]), new Set()).citations).toEqual([]);
    expect(notebookSectionLinkTargets(formula + '\n[Original result](artifacts/runs/result/output.md)\n'))
      .toEqual([{ heading: 'Results', targets: ['artifacts/runs/result/output.md'] }]);
  });
  it('reports active, superseded and void runs without judging their scientific discussion', () => {
    const ledger = syntheticLedger([
      { id: 'old', ts: '2026-08-01', validity: 'superseded', supersededBy: 'current' },
      { id: 'rejected', ts: '2026-08-02', validity: 'void' },
      { id: 'current', ts: '2026-08-03' },
    ]);
    writeNotebook('# Notes\n## Results\n[old](artifacts/runs/old/result.json)\n\n'
      + '[failed approach](artifacts/runs/rejected/notes.md)\n\n[current](artifacts/runs/current/result.json)');
    expect(analyzeNotebookRunLinks(projectRoot, ledger, new Set())).toEqual({
      notebook_found: true,
      citations: [
        { section: 'Results', run_id: 'old', validity: 'superseded', superseded_by: 'current' },
        { section: 'Results', run_id: 'rejected', validity: 'void', superseded_by: null },
        { section: 'Results', run_id: 'current', validity: 'active', superseded_by: null },
      ],
      unknown_run_ids: [],
    });
  });

  it('keeps the same objective record for Chinese, English, dated notes and old role comments', () => {
    const ledger = syntheticLedger([{ id: 'old', ts: '2026-08-01', validity: 'void' }]);
    const prose = [
      '这一条路线的近似失效，不能据此推断物理结论。',
      'The approximation in this approach fails and cannot support the conclusion.',
      '2026-08-01: the estimate was superseded after an independent derivation.',
      '<!-- notebook-section-role: log -->\nA useful research history.',
      'The discussion uses none of the old acknowledgment tokens.',
    ];
    let expected: ReturnType<typeof analyzeNotebookRunLinks> | undefined;
    for (const line of prose) {
      writeNotebook(`# Notes\n## Results\n${line} [calculation](artifacts/runs/old/notes.md)`);
      const report = analyzeNotebookRunLinks(projectRoot, ledger, new Set());
      expected ??= report;
      expect(report).toEqual(expected);
    }
  });

  it('does not infer writing quality from chronology, paragraph counts or list layout', () => {
    const ledger = ascendingLedger(9);
    const ids = Array.from({ length: 9 }, (_, i) => runId(i + 1));
    const variants = [
      ids.map(id => `[record](artifacts/runs/${id}/analysis.md)`).join('\n\n'),
      [...ids].reverse().map(id => `[record](artifacts/runs/${id}/analysis.md)`).join('\n\n'),
      ids.map(id => `- [record](artifacts/runs/${id}/analysis.md)`).join('\n'),
    ];
    for (const body of variants) {
      writeNotebook(`# Notes\n## Results\n${body}`);
      const report = analyzeNotebookRunLinks(projectRoot, ledger, new Set());
      expect(report.citations.map(citation => citation.run_id).sort()).toEqual([...ids].sort());
      expect(Object.keys(report).sort()).toEqual(['citations', 'notebook_found', 'unknown_run_ids']);
    }
  });

  it('deduplicates repeated links to a run within a section and retains distinct sections', () => {
    const ledger = ascendingLedger(1);
    writeNotebook(`# Notes\n## Methods\n[a](artifacts/runs/${runId(1)}/a)\n[b](artifacts/runs/${runId(1)}/b)\n`
      + `## Results\n[result](artifacts/runs/${runId(1)}/result.json)`);
    expect(analyzeNotebookRunLinks(projectRoot, ledger, new Set()).citations.map(c => [c.section, c.run_id]))
      .toEqual([['Methods', runId(1)], ['Results', runId(1)]]);
  });

  it('retains historical run paths and reports unknown IDs without assuming validity', () => {
    writeNotebook('# Notes\n## Results\n[historical](team/runs/history/result.json)\n'
      + '[missing](artifacts/runs/missing/result.json)\n[missing again](artifacts/runs/missing/data.csv)\n'
      + '[ledger](artifacts/runs/validity_ledger.jsonl)');
    expect(analyzeNotebookRunLinks(projectRoot, syntheticLedger([]), new Set(['history']))).toEqual({
      notebook_found: true,
      citations: [
        { section: 'Results', run_id: 'history', validity: null, superseded_by: null },
        { section: 'Results', run_id: 'missing', validity: null, superseded_by: null },
      ],
      unknown_run_ids: ['missing'],
    });
  });

  it('uses path hierarchy and known identity rather than filename extensions to identify runs', () => {
    const ledger = syntheticLedger([{ id: 'fit.v1', ts: '2026-08-01' }]);
    writeNotebook('# Notes\n## Results\n[fit](artifacts/runs/fit.v1/output.json)\n'
      + '[fit directory](artifacts/runs/fit.v1)\n[existing directory](team/runs/history.v2)\n'
      + '[missing](artifacts/runs/missing.v3/output.json)\n[missing directory](artifacts/runs/missing.v4/)\n'
      + '[ledger](artifacts/runs/validity_ledger.jsonl)\n[metadata](artifacts/runs/run_metadata.json)');
    const report = analyzeNotebookRunLinks(projectRoot, ledger, new Set(['history.v2']));
    expect(report.citations.map(citation => citation.run_id)).toEqual(['fit.v1', 'history.v2', 'missing.v3', 'missing.v4']);
    expect(report.citations[0]?.validity).toBe('active');
    expect(report.unknown_run_ids).toEqual(['missing.v3', 'missing.v4']);
  });

  it('reads user notes without rewriting their bytes', () => {
    const text = '# Notes\r\n\r\n## Results\r\nA dated [calculation](artifacts/runs/old/result.json).\r\n';
    writeNotebook(text);
    analyzeNotebookRunLinks(projectRoot, syntheticLedger([]), new Set());
    expect(fs.readFileSync(path.join(projectRoot, 'research_notebook.md'), 'utf-8')).toBe(text);
  });

  it('distinguishes an absent notebook and does not hide a file read failure as empty references', () => {
    expect(analyzeNotebookRunLinks(projectRoot, syntheticLedger([]), new Set())).toEqual({
      notebook_found: false, citations: [], unknown_run_ids: [],
    });
    fs.mkdirSync(path.join(projectRoot, 'research_notebook.md'));
    expect(() => analyzeNotebookRunLinks(projectRoot, syntheticLedger([]), new Set())).toThrow();
  });
});

describe('visible notebook reference boundaries', () => {
  it('preserves full and collapsed references, title syntax and first-definition precedence', () => {
    writeNotebook([
      '# Notes', '[outside]: artifacts/runs/old/result.json', '## Results',
      '[full reference][outside]', '[local][]', '[title](<artifacts/runs/titled/result.json> "A title")',
      "[single title](artifacts/runs/single/result.json 'A title')",
      '', '[local]: artifacts/runs/first/result.json', '[LOCAL]: artifacts/runs/second/result.json',
    ].join('\n'));
    expect(analyzeNotebookRunLinks(projectRoot, syntheticLedger([]), new Set()).unknown_run_ids)
      .toEqual(['old', 'first', 'titled', 'single']);
  });

  it('does not promote code, comments, image alt text or unused reference definitions into citations', () => {
    const target = 'artifacts/runs/hidden/result.json';
    writeNotebook([
      '# Notes', '## Results',
      '```md', `[fenced](${target})`, '```',
      `    [indented](${target})`, '',
      '`[inline](' + target + ')`', '',
      '``a ` [long span](' + target + ')``', '',
      `<!-- [comment](${target}) -->`, '',
      `<!--\nA hidden [passage](${target})\n\n[still hidden](${target})\n-->`, '',
      `![image](${target})`, '', `[unused]: ${target}`, '',
      '[visible](artifacts/runs/visible/result.json)',
    ].join('\n'));
    expect(analyzeNotebookRunLinks(projectRoot, syntheticLedger([]), new Set()).unknown_run_ids)
      .toEqual(['visible']);
  });

  it('does not extract raw HTML references or links inside invisible HTML', () => {
    writeNotebook([
      '# Notes', '## Results', '<a href="artifacts/runs/raw/result.json">raw link</a>', '',
      '<script>', '[hidden](artifacts/runs/script/result.json)', '</script>', '',
      '[visible](artifacts/runs/visible/result.json)',
    ].join('\n'));
    expect(analyzeNotebookRunLinks(projectRoot, syntheticLedger([]), new Set()).unknown_run_ids)
      .toEqual(['visible']);
  });

  it('keeps the existing bounded body-link contract separate from heading and shortcut navigation', () => {
    const sections = notebookSectionLinkTargets([
      '# Notes', '[front matter](artifacts/runs/front/result.json)',
      '## [Heading](artifacts/runs/heading/result.json)',
      '[shortcut]', '[shortcut]: artifacts/runs/shortcut/result.json', '',
      '[body](artifacts/runs/body/result.json)',
    ].join('\n'));
    expect(sections).toHaveLength(1);
    expect(sections[0]?.targets).toEqual(['artifacts/runs/body/result.json']);
  });

  it('excludes historical machine blocks from scientific body references without mutating them', () => {
    const notebook = [
      '# Notes', '## Results',
      '<!-- NOTEBOOK_CURRENT_STATE_START -->',
      `<!-- state-digest: ${'a'.repeat(64)} -->`,
      '[old machine state](artifacts/runs/machine/result.json)',
      '<!-- NOTEBOOK_CURRENT_STATE_END -->',
      '[actual discussion](artifacts/runs/science/result.json)',
    ].join('\n');
    writeNotebook(notebook);
    expect(analyzeNotebookRunLinks(projectRoot, syntheticLedger([]), new Set()).unknown_run_ids)
      .toEqual(['science']);
    expect(fs.readFileSync(path.join(projectRoot, 'research_notebook.md'), 'utf-8')).toBe(notebook);
  });
});
