import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { readHepResource } from '../../src/core/resources.js';
import { getRunArtifactPath } from '../../src/core/paths.js';

vi.mock('../../src/api/client.js', () => ({
  getPaper: vi.fn().mockImplementation(async (recid: string) => ({
    title: `Paper ${recid}`,
    year: 2024,
  })),
}));

vi.mock('../../src/tools/research/measurementExtractor.js', () => ({
  extractMeasurements: vi.fn().mockImplementation(async ({ identifier }: { identifier: string }) => {
    const base = identifier === '111' ? 10 : 15;
    const width = identifier === '111' ? 1.0 : 1.05;

    return {
      identifier,
      success: true,
      measurements: [
        {
          quantity_hint: 'mass',
          value: base,
          uncertainty: 1,
          unit: 'GeV',
          source_context: 'mass measurement',
          source_location: 'text',
          raw_match: `${base} \\pm 1 GeV`,
        },
        {
          quantity_hint: 'width',
          value: width,
          uncertainty: 0.1,
          unit: 'GeV',
          source_context: 'width measurement',
          source_location: 'text',
          raw_match: `${width} \\pm 0.1 GeV`,
        },
      ],
      summary: {
        total_found: 2,
        from_abstract: 0,
        from_text: 2,
        from_tables: 0,
      },
    };
  }),
}));

describe('Open Roadmap R3/W4: hep_run_build_writing_critical', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) {
      process.env.HEP_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.HEP_DATA_DIR;
    }
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('writes conflicts/stance/evidence_grades/summary artifacts and updates manifest step', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'W4 critical', description: 'w4' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    // Minimal claims artifact required by critical builder.
    const claimsArtifact = {
      claims_table: {
        corpus_snapshot: { paper_count: 2, recids: ['111', '222'], date_range: { start: 2024, end: 2024 }, snapshot_date: '2024-01-01' },
        claims: [
          { claim_id: 'c1', claim_no: '1', category: 'experimental_result', paper_ids: ['111'], evidence_grade: 'evidence', keywords: ['mass'] },
          { claim_id: 'c2', claim_no: '2', category: 'experimental_result', paper_ids: ['222'], evidence_grade: 'hint', keywords: ['mass'] },
        ],
      },
    };
    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_claims_table.json'), JSON.stringify(claimsArtifact, null, 2), 'utf-8');

    const res = await handleToolCall('hep_run_build_writing_critical', { run_id: run.run_id, recids: ['111', '222'], min_tension_sigma: 2 });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as { artifacts: Array<{ name: string; uri: string }>; summary: any };
    const byName = new Map(payload.artifacts.map(a => [a.name, a] as const));

    expect(byName.has('writing_conflicts.json')).toBe(true);
    expect(byName.has('writing_stance.jsonl')).toBe(true);
    expect(byName.has('writing_evidence_grades.json')).toBe(true);
    expect(byName.has('writing_critical_summary.json')).toBe(true);

    const conflictsText = String((readHepResource(byName.get('writing_conflicts.json')!.uri) as any).text);
    const conflicts = JSON.parse(conflictsText) as { result: { conflicts: Array<{ conflict_type: string; quantity: string }> } };
    expect(conflicts.result.conflicts.length).toBe(1);
    expect(conflicts.result.conflicts[0]!.conflict_type).toBe('soft');
    expect(conflicts.result.conflicts[0]!.quantity).toBe('mass');

    const stanceText = String((readHepResource(byName.get('writing_stance.jsonl')!.uri) as any).text);
    const stanceLines = stanceText.split('\n').filter(Boolean).map(l => JSON.parse(l) as { stance: string });
    expect(stanceLines.map(l => l.stance).sort()).toEqual(['confirming', 'contradicting']);

    const gradesText = String((readHepResource(byName.get('writing_evidence_grades.json')!.uri) as any).text);
    const grades = JSON.parse(gradesText) as { counts: Record<string, number> };
    expect(grades.counts.evidence).toBe(1);
    expect(grades.counts.hint).toBe(1);

    const manifestText = String((readHepResource(`hep://runs/${encodeURIComponent(run.run_id)}/manifest`) as any).text);
    const manifest = JSON.parse(manifestText) as { steps: Array<{ step: string; status: string; artifacts?: Array<{ name: string }> }> };
    const step = manifest.steps.find(s => s.step === 'writing_critical');
    expect(step?.status).toBe('done');
    expect(step?.artifacts?.some(a => a.name === 'writing_critical_summary.json')).toBe(true);
  });
});
