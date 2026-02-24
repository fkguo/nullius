import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { readHepResource } from '../../src/vnext/resources.js';
import { getRunArtifactPath } from '../../src/vnext/paths.js';

describe('vNext R6: hep_run_build_measurements', () => {
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

  it('extracts units and records a reproducible truncation diagnostics artifact (no silent truncation)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'R6 measurements', description: 'r6' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const catalogName = 'latex_evidence_catalog.jsonl';
    const paperId = 'paper_test';
    const makeItem = (id: number, text: string) => ({
      version: 1,
      evidence_id: `ev_${id}`,
      project_id: project.project_id,
      paper_id: paperId,
      type: 'paragraph',
      locator: { kind: 'latex', file: 'main.tex', offset: id * 100, line: id, column: 1 },
      text,
    });

    const lines = [
      makeItem(1, 'The Higgs mass is 125.0 \\pm 0.4 GeV/c².'),
      makeItem(2, 'The integrated luminosity is 5 \\pm 1 fb^{-1}.'),
      makeItem(3, 'The cross section is 10 \\pm 2 pb.'),
    ].map(v => JSON.stringify(v));

    fs.writeFileSync(getRunArtifactPath(run.run_id, catalogName), lines.join('\n') + '\n', 'utf-8');

    const res = await handleToolCall('hep_run_build_measurements', { run_id: run.run_id, max_results: 2 });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as {
      measurements_uri: string;
      meta_uri: string;
      artifacts: Array<{ name: string; uri: string }>;
    };

    const measurementsText = String((readHepResource(payload.measurements_uri) as any).text);
    const measurements = measurementsText
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line)) as Array<{ evidence_id: string; unit?: string; locator?: { kind?: string } }>;

    expect(measurements.length).toBe(2);
    expect(measurements[0].evidence_id).toBe('ev_1');
    expect(measurements[0].locator?.kind).toBe('latex');
    expect(measurements[0].unit).toBe('GeV/c^2');
    expect(measurements[1].evidence_id).toBe('ev_2');
    expect(measurements[1].unit).toBe('/fb');

    const meta = JSON.parse(String((readHepResource(payload.meta_uri) as any).text)) as {
      stats: { measurements_found: number; measurements_written: number };
      warnings: string[];
    };
    expect(meta.stats.measurements_found).toBe(3);
    expect(meta.stats.measurements_written).toBe(2);
    expect(meta.warnings.some(w => w.includes('Measurements truncated'))).toBe(true);

    const diagUri = payload.artifacts.find(a =>
      a.uri.startsWith('hep://runs/')
      && a.name.includes('hep_measurements_diagnostics.json')
    )?.uri;
    expect(diagUri).toBeTruthy();

    const diag = JSON.parse(String((readHepResource(diagUri!) as any).text)) as {
      run_id: string;
      step: string;
      budgets: Array<{ key: string; source?: { kind?: string } }>;
      hits: Array<{ key: string; limit: number; observed: number; action: string }>;
      warnings: Array<{ code: string; data?: { key?: string } }>;
      artifacts: { project_diagnostics_uri: string };
    };
    expect(diag.run_id).toBe(run.run_id);
    expect(diag.step).toBe('hep_measurements');

    const hit = diag.hits.find(h => h.key === 'hep.measurements.max_results');
    expect(hit).toBeTruthy();
    expect(hit!.action).toBe('truncate');
    expect(hit!.limit).toBe(2);
    expect(hit!.observed).toBe(3);
    expect(diag.warnings.some(w => w.code === 'budget_hit' && w.data?.key === 'hep.measurements.max_results')).toBe(true);
    expect(diag.budgets.find(b => b.key === 'hep.measurements.max_results')?.source?.kind).toBe('tool_args');

    const projectDiag = JSON.parse(String((readHepResource(diag.artifacts.project_diagnostics_uri) as any).text)) as {
      run_id: string;
      step: string;
    };
    expect(projectDiag.run_id).toBe(run.run_id);
    expect(projectDiag.step).toBe('hep_measurements');
  });
});
