import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { getRun } from '../../src/core/runs.js';
import { getRunArtifactPath } from '../../src/core/paths.js';

function writeCandidatePool(runId: string, projectId: string): void {
  fs.writeFileSync(
    getRunArtifactPath(runId, 'writing_candidate_pool_v1.json'),
    JSON.stringify(
      {
        version: 1,
        generated_at: '2026-01-01T00:00:00Z',
        run_id: runId,
        project_id: projectId,
        seed_identifiers: ['111'],
        candidates: [
          {
            paper_id: 'inspire:111',
            inspire_recid: '111',
            title: 'Seed Paper',
            authors: ['A. Author'],
            year: 2024,
            abstract: 'Seed abstract.',
            arxiv_categories: ['hep-ph'],
            citation_count: 10,
            provenance: [{ kind: 'seed', source_paper_id: 'inspire:111' }],
          },
          {
            paper_id: 'inspire:222',
            inspire_recid: '222',
            title: 'Related Paper',
            authors: ['B. Author'],
            year: 2023,
            abstract: 'Related abstract.',
            arxiv_categories: ['hep-th'],
            citation_count: 5,
            provenance: [{ kind: 'reference', source_paper_id: 'inspire:111' }],
          },
        ],
        meta: { test: true },
      },
      null,
      2
    ),
    'utf-8'
  );
}

function makeValidPaperSetCuration(): any {
  return {
    language: 'en',
    title: 'Demo Title',
    topic: 'Demo Topic',
    included_papers: [
      { paper_id: 'inspire:111', reason: 'Seed', tags: ['seed'], cluster_id: 'c0' },
      { paper_id: 'inspire:222', reason: 'Coverage', tags: ['related'], cluster_id: 'c0' },
    ],
    excluded_papers: [],
    taxonomy: {
      axes: [{ axis_id: 'axis0', label: 'topic', description: 'Single-axis taxonomy.' }],
      clusters: [
        {
          cluster_id: 'c0',
          label: 'Core',
          description: 'Core papers for this topic.',
          paper_ids: ['inspire:111', 'inspire:222'],
          representative_papers: ['inspire:111'],
        },
      ],
      perspectives: [],
    },
    quotas: { by_cluster: [{ cluster_id: 'c0', min: 2 }] },
    discovery_plan: { breadth: 1, depth: 1, concurrency: 1, max_api_calls: 10, max_candidates: 10 },
    noise_filters: [{ filter_id: 'nf0', description: 'No noise', rationale: 'Seeded set is already filtered.' }],
    notes: ['test'],
  };
}

describe('M02: PaperSetCuration prompt packet + submit (staging-aware)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('create packet → stage paperset_curation → submit via URI writes writing_paperset_v1.json', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'paperset curation', description: 'm02' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    writeCandidatePool(run.run_id, project.project_id);

    const packetRes = await handleToolCall('hep_run_writing_create_paperset_curation_packet', {
      run_id: run.run_id,
      language: 'en',
      target_length: 'short',
      title: 'Demo Title',
      topic: 'Demo Topic',
      seed_identifiers: ['111'],
    });
    expect(packetRes.isError).not.toBe(true);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_paperset_curation_packet.json'))).toBe(true);

    const stageRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'paperset_curation',
      artifact_suffix: 'm02',
      content: JSON.stringify(makeValidPaperSetCuration()),
    });
    expect(stageRes.isError).not.toBe(true);
    const staged = JSON.parse(stageRes.content[0].text) as { staging_uri: string; artifact_name: string };
    expect(fs.existsSync(getRunArtifactPath(run.run_id, staged.artifact_name))).toBe(true);

    const submitRes = await handleToolCall('hep_run_writing_submit_paperset_curation', {
      run_id: run.run_id,
      paperset_uri: staged.staging_uri,
    });
    expect(submitRes.isError).not.toBe(true);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_paperset_v1.json'))).toBe(true);

    const manifest = getRun(run.run_id);
    const step = manifest.steps.find(s => s.step === 'writing_paperset');
    expect(step?.status).toBe('done');
  });

  it('rejects paperset submission when staging content_type mismatches', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'paperset mismatch', description: 'm02' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    writeCandidatePool(run.run_id, project.project_id);
    await handleToolCall('hep_run_writing_create_paperset_curation_packet', {
      run_id: run.run_id,
      language: 'en',
      target_length: 'short',
      title: 'Demo Title',
      seed_identifiers: ['111'],
    });

    const stageRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      // default content_type is section_output; keep it to trigger mismatch.
      artifact_suffix: 'mismatch',
      content: JSON.stringify(makeValidPaperSetCuration()),
    });
    expect(stageRes.isError).not.toBe(true);
    const staged = JSON.parse(stageRes.content[0].text) as { staging_uri: string };

    const submitRes = await handleToolCall('hep_run_writing_submit_paperset_curation', {
      run_id: run.run_id,
      paperset_uri: staged.staging_uri,
    });
    expect(submitRes.isError).toBe(true);

    const payload = JSON.parse(submitRes.content[0]?.text ?? '{}') as { error?: { code?: string } };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
  });

  it('rejects cross-run paperset staging URIs', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'paperset cross', description: 'm02' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runARes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const runA = JSON.parse(runARes.content[0].text) as { run_id: string };
    writeCandidatePool(runA.run_id, project.project_id);
    await handleToolCall('hep_run_writing_create_paperset_curation_packet', {
      run_id: runA.run_id,
      language: 'en',
      target_length: 'short',
      title: 'Demo Title',
      seed_identifiers: ['111'],
    });

    const runBRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const runB = JSON.parse(runBRes.content[0].text) as { run_id: string };
    writeCandidatePool(runB.run_id, project.project_id);
    await handleToolCall('hep_run_writing_create_paperset_curation_packet', {
      run_id: runB.run_id,
      language: 'en',
      target_length: 'short',
      title: 'Demo Title',
      seed_identifiers: ['111'],
    });

    const stageRes = await handleToolCall('hep_run_stage_content', {
      run_id: runA.run_id,
      content_type: 'paperset_curation',
      artifact_suffix: 'cross',
      content: JSON.stringify(makeValidPaperSetCuration()),
    });
    expect(stageRes.isError).not.toBe(true);
    const staged = JSON.parse(stageRes.content[0].text) as { staging_uri: string };

    const submitRes = await handleToolCall('hep_run_writing_submit_paperset_curation', {
      run_id: runB.run_id,
      paperset_uri: staged.staging_uri,
    });
    expect(submitRes.isError).toBe(true);
    const payload = JSON.parse(submitRes.content[0]?.text ?? '{}') as { error?: { code?: string } };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
  });

  it('writes writing_parse_error_paperset_v1.json when schema invalid', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'paperset invalid', description: 'm02' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    writeCandidatePool(run.run_id, project.project_id);
    await handleToolCall('hep_run_writing_create_paperset_curation_packet', {
      run_id: run.run_id,
      language: 'en',
      target_length: 'short',
      title: 'Demo Title',
      seed_identifiers: ['111'],
    });

    const stageRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'paperset_curation',
      artifact_suffix: 'invalid',
      content: JSON.stringify({ language: 'en', title: 'bad', included_papers: [] }),
    });
    expect(stageRes.isError).not.toBe(true);
    const staged = JSON.parse(stageRes.content[0].text) as { staging_uri: string };

    const submitRes = await handleToolCall('hep_run_writing_submit_paperset_curation', {
      run_id: run.run_id,
      paperset_uri: staged.staging_uri,
    });
    expect(submitRes.isError).toBe(true);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_parse_error_paperset_v1.json'))).toBe(true);
  });
});

