import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { readHepResource } from '../../src/core/resources.js';
import { getRunArtifactPath } from '../../src/core/paths.js';

function writeMeasurementsArtifact(params: {
  run_id: string;
  project_id: string;
  artifact_name: string;
  value: number;
  uncertainty: number;
  quantity_normalized?: string;
  unit?: string;
  measurement_id?: string;
  paper_id?: string;
}): void {
  const quantity = params.quantity_normalized ?? 'higgs mass';
  const row = {
    version: 1,
    measurement_id: params.measurement_id ?? `m_${params.artifact_name}`,
    run_id: params.run_id,
    project_id: params.project_id,
    paper_id: params.paper_id ?? 'paper_1',
    evidence_id: `ev_${params.artifact_name}`,
    evidence_type: 'paragraph',
    locator: { kind: 'latex', file: 'main.tex', offset: 10, line: 2, column: 1 },
    quantity_hint: quantity,
    quantity_normalized: quantity,
    value: params.value,
    uncertainty: params.uncertainty,
    unit: params.unit,
    is_percentage: false,
    raw_match: `${params.value} \\pm ${params.uncertainty} ${params.unit ?? ''}`.trim(),
    source_text_preview: 'measurement fixture',
  };

  fs.writeFileSync(getRunArtifactPath(params.run_id, params.artifact_name), `${JSON.stringify(row)}\n`, 'utf-8');
}

describe('vNext Phase4: hep_project_compare_measurements', () => {
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

  it('flags cross-run pairwise tensions (flagging-only)', async () => {
    const p1Res = await handleToolCall('hep_project_create', { name: 'cmp-a', description: 'phase4 compare' });
    const p1 = JSON.parse(p1Res.content[0].text) as { project_id: string };
    const r1Res = await handleToolCall('hep_run_create', { project_id: p1.project_id });
    const r1 = JSON.parse(r1Res.content[0].text) as { run_id: string };

    const p2Res = await handleToolCall('hep_project_create', { name: 'cmp-b', description: 'phase4 compare' });
    const p2 = JSON.parse(p2Res.content[0].text) as { project_id: string };
    const r2Res = await handleToolCall('hep_run_create', { project_id: p2.project_id });
    const r2 = JSON.parse(r2Res.content[0].text) as { run_id: string };

    writeMeasurementsArtifact({
      run_id: r1.run_id,
      project_id: p1.project_id,
      artifact_name: 'hep_measurements_manual_a.jsonl',
      value: 125.0,
      uncertainty: 0.2,
      unit: 'GeV',
    });
    writeMeasurementsArtifact({
      run_id: r2.run_id,
      project_id: p2.project_id,
      artifact_name: 'hep_measurements_manual_b.jsonl',
      value: 126.0,
      uncertainty: 0.2,
      unit: 'GeV',
    });

    const res = await handleToolCall('hep_project_compare_measurements', {
      run_id: r1.run_id,
      input_runs: [
        { run_id: r1.run_id, measurements_artifact_name: 'hep_measurements_manual_a.jsonl', label: 'ATLAS' },
        { run_id: r2.run_id, measurements_artifact_name: 'hep_measurements_manual_b.jsonl', label: 'CMS' },
      ],
      min_tension_sigma: 2,
      max_flags: 20,
      include_not_comparable: true,
    });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as {
      compare_uri: string;
      summary: { flagged_pairs: number; comparable_pairs: number };
    };
    expect(payload.summary.comparable_pairs).toBe(1);
    expect(payload.summary.flagged_pairs).toBe(1);

    const artifact = JSON.parse(String((readHepResource(payload.compare_uri) as any).text)) as {
      policy: { flagging_only: boolean; min_tension_sigma: number };
      flags: Array<{ quantity_normalized: string; z_score: number; lhs: { source: { label: string } }; rhs: { source: { label: string } } }>;
    };

    expect(artifact.policy.flagging_only).toBe(true);
    expect(artifact.policy.min_tension_sigma).toBe(2);
    expect(artifact.flags.length).toBe(1);
    expect(artifact.flags[0]!.quantity_normalized).toBe('higgs mass');
    expect(artifact.flags[0]!.z_score).toBeGreaterThan(3);
    expect([artifact.flags[0]!.lhs.source.label, artifact.flags[0]!.rhs.source.label].sort()).toEqual(['ATLAS', 'CMS']);
  });

  it('treats same paper+measurement across runs as duplicate_source (not comparable)', async () => {
    const p1Res = await handleToolCall('hep_project_create', { name: 'cmp-dup-a', description: 'phase4 compare' });
    const p1 = JSON.parse(p1Res.content[0].text) as { project_id: string };
    const r1Res = await handleToolCall('hep_run_create', { project_id: p1.project_id });
    const r1 = JSON.parse(r1Res.content[0].text) as { run_id: string };

    const p2Res = await handleToolCall('hep_project_create', { name: 'cmp-dup-b', description: 'phase4 compare' });
    const p2 = JSON.parse(p2Res.content[0].text) as { project_id: string };
    const r2Res = await handleToolCall('hep_run_create', { project_id: p2.project_id });
    const r2 = JSON.parse(r2Res.content[0].text) as { run_id: string };

    writeMeasurementsArtifact({
      run_id: r1.run_id,
      project_id: p1.project_id,
      artifact_name: 'hep_measurements_dup_a.jsonl',
      measurement_id: 'm_shared',
      paper_id: 'paper_shared',
      value: 125.0,
      uncertainty: 0.2,
      unit: 'GeV',
    });
    writeMeasurementsArtifact({
      run_id: r2.run_id,
      project_id: p2.project_id,
      artifact_name: 'hep_measurements_dup_b.jsonl',
      measurement_id: 'm_shared',
      paper_id: 'paper_shared',
      value: 127.0,
      uncertainty: 0.2,
      unit: 'GeV',
    });

    const res = await handleToolCall('hep_project_compare_measurements', {
      run_id: r1.run_id,
      input_runs: [
        { run_id: r1.run_id, measurements_artifact_name: 'hep_measurements_dup_a.jsonl' },
        { run_id: r2.run_id, measurements_artifact_name: 'hep_measurements_dup_b.jsonl' },
      ],
      include_not_comparable: true,
    });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as {
      compare_uri: string;
      summary: { flagged_pairs: number; comparable_pairs: number; not_comparable_pairs: number };
    };
    expect(payload.summary.comparable_pairs).toBe(0);
    expect(payload.summary.flagged_pairs).toBe(0);
    expect(payload.summary.not_comparable_pairs).toBe(1);

    const artifact = JSON.parse(String((readHepResource(payload.compare_uri) as any).text)) as {
      summary: { reason_counts: Record<string, number> };
      not_comparable?: Array<{ reason: string }>;
    };
    expect((artifact.summary.reason_counts.duplicate_source ?? 0)).toBe(1);
    expect(artifact.not_comparable?.[0]?.reason).toBe('duplicate_source');
  });

  it('returns actionable next_actions when source measurements artifact is missing', async () => {
    const p1Res = await handleToolCall('hep_project_create', { name: 'cmp-miss-a', description: 'phase4 compare' });
    const p1 = JSON.parse(p1Res.content[0].text) as { project_id: string };
    const r1Res = await handleToolCall('hep_run_create', { project_id: p1.project_id });
    const r1 = JSON.parse(r1Res.content[0].text) as { run_id: string };

    const p2Res = await handleToolCall('hep_project_create', { name: 'cmp-miss-b', description: 'phase4 compare' });
    const p2 = JSON.parse(p2Res.content[0].text) as { project_id: string };
    const r2Res = await handleToolCall('hep_run_create', { project_id: p2.project_id });
    const r2 = JSON.parse(r2Res.content[0].text) as { run_id: string };

    const res = await handleToolCall('hep_project_compare_measurements', {
      run_id: r1.run_id,
      input_runs: [{ run_id: r1.run_id }, { run_id: r2.run_id }],
    });
    expect(res.isError).toBe(true);

    const err = JSON.parse(res.content[0].text) as {
      error: { code: string; data?: { next_actions?: Array<{ tool: string }> } };
    };
    expect(err.error.code).toBe('INVALID_PARAMS');
    const nextTools = (err.error.data?.next_actions ?? []).map(a => a.tool);
    expect(nextTools).toContain('hep_run_build_measurements');
  });

  it('auto-selects latest hep_measurements_*.jsonl and records non-comparable pairs', async () => {
    const p1Res = await handleToolCall('hep_project_create', { name: 'cmp-latest-a', description: 'phase4 compare' });
    const p1 = JSON.parse(p1Res.content[0].text) as { project_id: string };
    const r1Res = await handleToolCall('hep_run_create', { project_id: p1.project_id });
    const r1 = JSON.parse(r1Res.content[0].text) as { run_id: string };

    const p2Res = await handleToolCall('hep_project_create', { name: 'cmp-latest-b', description: 'phase4 compare' });
    const p2 = JSON.parse(p2Res.content[0].text) as { project_id: string };
    const r2Res = await handleToolCall('hep_run_create', { project_id: p2.project_id });
    const r2 = JSON.parse(r2Res.content[0].text) as { run_id: string };

    writeMeasurementsArtifact({
      run_id: r1.run_id,
      project_id: p1.project_id,
      artifact_name: 'hep_measurements_older.jsonl',
      value: 125.0,
      uncertainty: 0.2,
      unit: 'GeV',
    });
    writeMeasurementsArtifact({
      run_id: r1.run_id,
      project_id: p1.project_id,
      artifact_name: 'hep_measurements_latest.jsonl',
      value: 125.1,
      uncertainty: 0.2,
      unit: 'GeV',
    });

    const olderPath = getRunArtifactPath(r1.run_id, 'hep_measurements_older.jsonl');
    const latestPath = getRunArtifactPath(r1.run_id, 'hep_measurements_latest.jsonl');
    const now = Date.now() / 1000;
    fs.utimesSync(olderPath, now - 3600, now - 3600);
    fs.utimesSync(latestPath, now, now);

    writeMeasurementsArtifact({
      run_id: r2.run_id,
      project_id: p2.project_id,
      artifact_name: 'hep_measurements_other.jsonl',
      value: 11,
      uncertainty: 0.5,
      unit: 'pb',
    });

    const res = await handleToolCall('hep_project_compare_measurements', {
      run_id: r1.run_id,
      input_runs: [{ run_id: r1.run_id }, { run_id: r2.run_id }],
      include_not_comparable: true,
      min_tension_sigma: 2,
    });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as {
      compare_uri: string;
      summary: { flagged_pairs: number; not_comparable_pairs: number };
    };
    expect(payload.summary.flagged_pairs).toBe(0);
    expect(payload.summary.not_comparable_pairs).toBe(1);

    const artifact = JSON.parse(String((readHepResource(payload.compare_uri) as any).text)) as {
      inputs: Array<{ run_id: string; measurements_artifact_name: string }>;
      summary: { reason_counts: Record<string, number> };
      not_comparable?: Array<{ reason: string }>;
    };

    const inputA = artifact.inputs.find(item => item.run_id === r1.run_id);
    expect(inputA?.measurements_artifact_name).toBe('hep_measurements_latest.jsonl');
    expect((artifact.summary.reason_counts.unit_mismatch ?? 0)).toBeGreaterThan(0);
    expect(artifact.not_comparable?.[0]?.reason).toBe('unit_mismatch');
  });
});
