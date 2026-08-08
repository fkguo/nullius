import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ValidityEventV1 } from '@nullius/shared';
import {
  analyzeNotebookRunLinks,
  segmentCitationBlocks,
  DRIFT_FLOOR_CITING_PARAGRAPHS,
} from '../src/notebook-run-links.js';
import type { ValidityLedgerView, RunValidity } from '../src/validity-ledger.js';

/** Negative controls proving the drift/dead-citation analysis fires on the
 *  measured field failure shape and stays silent on every legitimate shape
 *  the design panel attacked it with. */

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

function paragraphCiting(index: number): string {
  return `The run [record](artifacts/runs/${runId(index)}/analysis.md) established a value.`;
}

describe('append-drift detection', () => {
  it('fires on the field failure shape: many single-run paragraphs in run order', () => {
    const ledger = ascendingLedger(9);
    writeNotebook([
      '# Memo', '## Results',
      ...Array.from({ length: 9 }, (_, i) => `${paragraphCiting(i + 1)}\n`),
    ].join('\n'));
    const report = analyzeNotebookRunLinks(projectRoot, ledger, new Set());
    const section = report.sections.find(entry => entry.heading === 'Results')!;
    expect(section.verdict).toBe('drifted');
    expect(section.ascending_share).toBe(1);
    expect(section.assessed).toBe(true);
    expect(report.drifted_sections).toContain('Results');
  });

  it('reports insufficient_signal, never a guessed verdict, when every stamp shares one timestamp', () => {
    const ledger = syntheticLedger(Array.from({ length: 9 }, (_, i) => ({
      id: runId(i + 1),
      ts: '2026-08-08T01:00:00.000Z', // one burst: minted ULID order is not chronology
    })));
    writeNotebook([
      '# Memo', '## Results',
      ...Array.from({ length: 9 }, (_, i) => `${paragraphCiting(i + 1)}\n`),
    ].join('\n'));
    const section = analyzeNotebookRunLinks(projectRoot, ledger, new Set())
      .sections.find(entry => entry.heading === 'Results')!;
    expect(section.comparable_pairs).toBe(0);
    expect(section.verdict).toBe('insufficient_signal');
    expect(section.assessed).toBe(false);
  });

  it('does not flag a curated ascending evidence list — tight or loose, a list is one block', () => {
    const ledger = ascendingLedger(9);
    const tight = Array.from({ length: 9 }, (_, i) => `- [run ${i + 1}](artifacts/runs/${runId(i + 1)}/out.tsv)`).join('\n');
    const loose = Array.from({ length: 9 }, (_, i) => `- [run ${i + 1}](artifacts/runs/${runId(i + 1)}/out.tsv)\n`).join('\n');
    for (const list of [tight, loose]) {
      writeNotebook(`# Memo\n## Evidence\nOne paragraph of prose framing the curated list.\n\n${list}\n`);
      const section = analyzeNotebookRunLinks(projectRoot, ledger, new Set())
        .sections.find(entry => entry.heading === 'Evidence')!;
      expect(section.citing_paragraphs).toBeLessThan(DRIFT_FLOOR_CITING_PARAGRAPHS);
      expect(section.verdict).toBe('insufficient_signal');
    }
  });

  it('stays under the floors on a young notebook and on non-run-bound prose', () => {
    const ledger = ascendingLedger(5);
    writeNotebook([
      '# Memo', '## Results',
      ...Array.from({ length: 5 }, (_, i) => `${paragraphCiting(i + 1)}\n`),
      '## Setup', 'Pure prose with no run links at all.', 'More prose.',
    ].join('\n'));
    const report = analyzeNotebookRunLinks(projectRoot, ledger, new Set());
    expect(report.sections.find(entry => entry.heading === 'Results')!.verdict).toBe('insufficient_signal');
    const setup = report.sections.find(entry => entry.heading === 'Setup')!;
    expect(setup.citing_paragraphs).toBe(0);
    expect(setup.verdict).toBe('insufficient_signal');
  });

  it('does not flag floors-met sections whose order is not chronological', () => {
    const ledger = ascendingLedger(9);
    writeNotebook([
      '# Memo', '## Results',
      ...Array.from({ length: 9 }, (_, i) => `${paragraphCiting(9 - i)}\n`), // descending
    ].join('\n'));
    const section = analyzeNotebookRunLinks(projectRoot, ledger, new Set())
      .sections.find(entry => entry.heading === 'Results')!;
    expect(section.assessed).toBe(true);
    expect(section.verdict).toBe('not_drifted');
  });

  it('exempts a declared log-role section, visibly', () => {
    const ledger = ascendingLedger(9);
    writeNotebook([
      '# Memo', '## Chronicle',
      '<!-- notebook-section-role: log -->',
      ...Array.from({ length: 9 }, (_, i) => `${paragraphCiting(i + 1)}\n`),
    ].join('\n'));
    const section = analyzeNotebookRunLinks(projectRoot, ledger, new Set())
      .sections.find(entry => entry.heading === 'Chronicle')!;
    expect(section.verdict).toBe('exempt_declared_log');
    expect(section.declared_log_role).toBe(true);
  });
});

describe('dead-citation acknowledgment union', () => {
  const dead = runId(1);
  const replacement = runId(2);

  function ledgerWithDead(validity: 'superseded' | 'void'): ValidityLedgerView {
    return syntheticLedger([
      { id: dead, ts: '2026-08-08T01:00:00.000Z', validity, supersededBy: validity === 'superseded' ? replacement : null },
      { id: replacement, ts: '2026-08-08T02:00:00.000Z' },
    ]);
  }

  it('lists an unacknowledged superseded citation presented as live prose', () => {
    writeNotebook(`# Memo\n## Results\nThe clearance was established by [this run](artifacts/runs/${dead}/out.tsv).\n`);
    const report = analyzeNotebookRunLinks(projectRoot, ledgerWithDead('superseded'), new Set());
    expect(report.unacknowledged_dead).toHaveLength(1);
    expect(report.unacknowledged_dead[0]!.run_id).toBe(dead);
    expect(report.unacknowledged_dead[0]!.section).toBe('Results');
  });

  it('accepts the replacement-link channel (language-neutral)', () => {
    writeNotebook([
      '# Memo', '## Results',
      `An earlier estimate ([old record](artifacts/runs/${dead}/out.tsv)) was refined by`,
      `[the later run](artifacts/runs/${replacement}/out.tsv).`,
    ].join('\n'));
    const report = analyzeNotebookRunLinks(projectRoot, ledgerWithDead('superseded'), new Set());
    expect(report.dead_citations).toHaveLength(1);
    expect(report.dead_citations[0]!.acknowledged).toBe(true);
    expect(report.dead_citations[0]!.ack_channel).toBe('replacement-link');
    expect(report.unacknowledged_dead).toHaveLength(0);
  });

  it('accepts the token channel — the charter-exact lesson sentence linking the OLD run record', () => {
    writeNotebook(`# Memo\n## Results\nThat estimate was superseded (sign error); see [the old record](artifacts/runs/${dead}/out.tsv).\n`);
    const report = analyzeNotebookRunLinks(projectRoot, ledgerWithDead('superseded'), new Set());
    expect(report.dead_citations[0]!.ack_channel).toBe('token');
    expect(report.unacknowledged_dead).toHaveLength(0);
  });

  it('accepts a token for a VOID run, which has no replacement chain at all', () => {
    writeNotebook(`# Memo\n## Results\nThe attempt was voided (configuration defect): [record](artifacts/runs/${dead}/out.tsv).\n`);
    const report = analyzeNotebookRunLinks(projectRoot, ledgerWithDead('void'), new Set());
    expect(report.dead_citations[0]!.validity).toBe('void');
    expect(report.dead_citations[0]!.ack_channel).toBe('token');
  });

  it('does not let "avoid" masquerade as a void acknowledgment (word boundary)', () => {
    writeNotebook(`# Memo\n## Results\nTo avoid the issue we use [this run](artifacts/runs/${dead}/out.tsv).\n`);
    const report = analyzeNotebookRunLinks(projectRoot, ledgerWithDead('void'), new Set());
    expect(report.unacknowledged_dead).toHaveLength(1);
  });

  it('a run slug containing a token word never self-acknowledges (link destinations are blanked)', () => {
    const slugDead = '20260808-m1-r007-void-check';
    const ledger = syntheticLedger([
      { id: slugDead, ts: '2026-08-08T01:00:00.000Z', validity: 'void' },
    ]);
    writeNotebook(`# Memo\n## Results\nThe clearance came from [this run](artifacts/runs/${slugDead}/out.tsv).\n`);
    const report = analyzeNotebookRunLinks(projectRoot, ledger, new Set());
    expect(report.unacknowledged_dead).toHaveLength(1);
    expect(report.unacknowledged_dead[0]!.run_id).toBe(slugDead);
  });

  it('accepts the present-tense charter idiom: "run B supersedes the earlier estimate"', () => {
    writeNotebook(`# Memo\n## Results\nA later run supersedes the earlier estimate; see [the old record](artifacts/runs/${dead}/out.tsv).\n`);
    const report = analyzeNotebookRunLinks(projectRoot, ledgerWithDead('superseded'), new Set());
    expect(report.dead_citations[0]!.ack_channel).toBe('token');
  });

  it('detects a dead run cited only via a reference-style link', () => {
    writeNotebook([
      '# Memo', '## Results',
      'The [old result][r] anchored the first estimate.',
      '',
      `[r]: artifacts/runs/${dead}/out.json`,
    ].join('\n'));
    const report = analyzeNotebookRunLinks(projectRoot, ledgerWithDead('void'), new Set());
    expect(report.unacknowledged_dead).toHaveLength(1);
    expect(report.unacknowledged_dead[0]!.run_id).toBe(dead);
  });

  it('ignores dead-run links inside inline code and HTML comments — documentation, not prose evidence', () => {
    writeNotebook([
      '# Memo', '## Results',
      `Paths look like \`[example](artifacts/runs/${dead}/out.json)\` in run records.`,
      '',
      `<!-- [hidden](artifacts/runs/${dead}/out.json) -->`,
    ].join('\n'));
    const report = analyzeNotebookRunLinks(projectRoot, ledgerWithDead('void'), new Set());
    expect(report.dead_citations).toHaveLength(0);
  });

  it('a token acknowledging one dead run does not blanket-acknowledge another block\'s dead run', () => {
    const deadB = runId(3);
    const ledger = syntheticLedger([
      { id: dead, ts: '2026-08-08T01:00:00.000Z', validity: 'void' },
      { id: deadB, ts: '2026-08-08T01:30:00.000Z', validity: 'void' },
    ]);
    writeNotebook([
      '# Memo', '## Results',
      `Run [B](artifacts/runs/${deadB}/out.tsv) was voided (bad configuration).`,
      '',
      `Run [A](artifacts/runs/${dead}/out.tsv) established the clearance.`,
    ].join('\n'));
    const report = analyzeNotebookRunLinks(projectRoot, ledger, new Set());
    const byRun = Object.fromEntries(report.dead_citations.map(entry => [entry.run_id, entry]));
    expect(byRun[deadB]!.acknowledged).toBe(true);
    expect(byRun[dead]!.acknowledged).toBe(false);
    expect(report.unacknowledged_dead.map(entry => entry.run_id)).toEqual([dead]);
  });

  it('acknowledges through the declared log role', () => {
    writeNotebook([
      '# Memo', '## History',
      '<!-- notebook-section-role: log -->',
      `Attempt one: [record](artifacts/runs/${dead}/out.tsv).`,
    ].join('\n'));
    const report = analyzeNotebookRunLinks(projectRoot, ledgerWithDead('void'), new Set());
    expect(report.dead_citations[0]!.ack_channel).toBe('declared-log');
  });
});

describe('citation extraction boundaries', () => {
  it('reports run-shaped unknown links, ignores files under the runs root, counts dir-only runs', () => {
    const ledger = syntheticLedger([]);
    writeNotebook([
      '# Memo', '## Results',
      'A [typo link](artifacts/runs/20260808-m1-r999-missing/out.tsv) and the',
      '[ledger itself](artifacts/runs/validity_ledger.jsonl) and a',
      '[dir-only run](artifacts/runs/20260808-m1-r001-dironly/notes.md).',
    ].join('\n'));
    const report = analyzeNotebookRunLinks(
      projectRoot, ledger, new Set(['20260808-m1-r001-dironly']),
    );
    expect(report.unknown_run_ids).toEqual(['20260808-m1-r999-missing']);
    const section = report.sections.find(entry => entry.heading === 'Results')!;
    expect(section.distinct_runs).toBe(1);
  });

  it('never reads citations out of fenced code examples', () => {
    const ledger = ascendingLedger(1);
    writeNotebook([
      '# Memo', '## Methods',
      '```', `[example](artifacts/runs/${runId(1)}/out.tsv)`, '```',
      'Prose without links.',
    ].join('\n'));
    const section = analyzeNotebookRunLinks(projectRoot, ledger, new Set())
      .sections.find(entry => entry.heading === 'Methods')!;
    expect(section.citing_paragraphs).toBe(0);
  });
});

describe('segmentCitationBlocks', () => {
  it('splits on blank lines and merges contiguous list blocks', () => {
    const blocks = segmentCitationBlocks([
      'para one', '', '- item a', '- item b', '', '- item c', '', 'para two',
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toContain('item a');
    expect(blocks[1]).toContain('item c');
  });
});
