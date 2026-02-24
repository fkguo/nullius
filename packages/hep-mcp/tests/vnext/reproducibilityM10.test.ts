import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { McpError } from '@autoresearch/shared';

import { handleToolCall } from '../../src/tools/index.js';
import { getRun, updateRunManifestAtomic } from '../../src/vnext/runs.js';
import { getRunArtifactPath, getRunDir } from '../../src/vnext/paths.js';
import { parseHepRunArtifactUriOrThrow } from '../../src/vnext/runArtifactUri.js';
import { cachedExternalApiJsonCall } from '../../src/vnext/cache/externalApiCache.js';
import { writeRunJsonArtifact } from '../../src/vnext/citations.js';
import { inferWritingRoundFromArtifacts } from '../../src/vnext/writing/reproducibility.js';

function sha256HexBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function writeClaimsTable(runId: string): void {
  fs.writeFileSync(
    getRunArtifactPath(runId, 'writing_claims_table.json'),
    JSON.stringify(
      {
        claims_table: {
          corpus_snapshot: { paper_count: 1, recids: ['123'], snapshot_date: '2024-01-01' },
          claims: [
            {
              claim_id: 'c1',
              claim_no: '1',
              claim_text: 'A minimal claim for outline planning.',
              category: 'theoretical_prediction',
              status: 'consensus',
              paper_ids: ['123'],
              supporting_evidence: [],
              assumptions: [],
              scope: 'global',
              evidence_grade: 'evidence',
              keywords: ['demo'],
              is_extractive: true,
            },
          ],
          visual_assets: { formulas: [], figures: [], tables: [] },
        },
        warnings: [],
        processing_time_ms: 0,
        references_added: 0,
      },
      null,
      2
    ),
    'utf-8'
  );
}

function makeValidOutlinePlanV2(): any {
  return {
    language: 'en',
    title: 'Demo Title',
    sections: [
      {
        number: '1',
        title: 'Introduction',
        type: 'introduction',
        semantic_slots: ['abstract', 'introduction', 'background'],
        suggested_word_count: 500,
        key_points: ['Motivation and context'],
        assigned_claim_ids: [],
        secondary_claim_refs: ['c1'],
        assigned_asset_ids: [],
        blueprint: {
          purpose: 'Set context and scope.',
          key_questions: ['What is the problem?', 'Why now?'],
          dependencies: { requires_sections: [], defines_terms: [], uses_terms: [] },
          anti_overlap: { must_not_overlap_with_sections: [], avoid_topics: [] },
        },
      },
      {
        number: '2',
        title: 'Methods and Results',
        type: 'body',
        semantic_slots: ['methods', 'results', 'limitations'],
        suggested_word_count: 1300,
        key_points: ['Summarize core methodology and main findings'],
        assigned_claim_ids: ['c1'],
        secondary_claim_refs: [],
        assigned_asset_ids: [],
        blueprint: {
          purpose: 'Present the main technical content.',
          key_questions: ['What is the key method?', 'What are the key results?', 'What are the limitations?'],
          dependencies: { requires_sections: ['1'], defines_terms: [], uses_terms: [] },
          anti_overlap: { must_not_overlap_with_sections: [], avoid_topics: [] },
        },
      },
      {
        number: '3',
        title: 'Conclusion',
        type: 'summary',
        semantic_slots: ['conclusion'],
        suggested_word_count: 400,
        key_points: ['Wrap up and future work'],
        assigned_claim_ids: [],
        secondary_claim_refs: ['c1'],
        assigned_asset_ids: [],
        blueprint: {
          purpose: 'Conclude and propose next questions.',
          key_questions: ['What is concluded?', 'What remains open?'],
          dependencies: { requires_sections: ['2'], defines_terms: [], uses_terms: [] },
          anti_overlap: { must_not_overlap_with_sections: [], avoid_topics: [] },
        },
      },
    ],
    total_suggested_words: 2200,
    suggested_citation_count: 20,
    structure_rationale: 'Intro → main content → conclusion.',
    global_narrative: {
      main_thread: 'From motivation to results to takeaways.',
      section_order_rationale: 'Establish context before detailing results.',
      abstract_generation_strategy: 'Summarize motivation, method, and key result.',
    },
    cross_ref_map: { defines: [], uses: [] },
    claim_dependency_graph: { edges: [] },
  };
}

describe('M10: reproducibility + caching + resume artifacts', () => {
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

  it('writes writing_checkpoint.json + journal with SHA-256 pointers', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'm10 checkpoint', description: 'm10' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    writeClaimsTable(run.run_id);

    const packetRes = await handleToolCall('hep_run_writing_create_outline_candidates_packet_v1', {
      run_id: run.run_id,
      language: 'en',
      target_length: 'short',
      title: 'Demo Title',
      n_candidates: 2,
    });
    expect(packetRes.isError).not.toBe(true);

    const checkpointPath = getRunArtifactPath(run.run_id, 'writing_checkpoint.json');
    expect(fs.existsSync(checkpointPath)).toBe(true);
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8')) as any;
    expect(checkpoint.version).toBe(1);
    expect(checkpoint.run_id).toBe(run.run_id);
    expect(checkpoint.current_step).toBe('writing_outline');
    expect(checkpoint.round).toBe(1);
    expect(typeof checkpoint.last_completed_at).toBe('string');
    expect(typeof checkpoint.pointers).toBe('object');
    expect(typeof checkpoint.hashes).toBe('object');

    const ptrKeys = Object.keys(checkpoint.pointers ?? {});
    expect(ptrKeys).toEqual(expect.arrayContaining(['prompt_packet_uri', 'llm_request_uri', 'claims_table_uri']));
    for (const key of ['prompt_packet_uri', 'llm_request_uri', 'claims_table_uri']) {
      const uri = checkpoint.pointers[key];
      const parsed = parseHepRunArtifactUriOrThrow(uri);
      const bytes = fs.readFileSync(getRunArtifactPath(run.run_id, parsed.artifactName));
      expect(checkpoint.hashes[key]).toBe(sha256HexBytes(bytes));
    }

    const journalPath = getRunArtifactPath(run.run_id, 'writing_journal_writing_outline_round_01.md');
    expect(fs.existsSync(journalPath)).toBe(true);
    const journal = fs.readFileSync(journalPath, 'utf-8');
    expect(journal).toContain('## Outputs');
    expect(journal).toMatch(/sha256=[a-f0-9]{64}/i);
    expect(journal).toContain(checkpoint.hashes.llm_request_uri);
  });

  it('client llm_response artifact includes reproducibility fields', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'm10 llm_response', description: 'm10' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    writeClaimsTable(run.run_id);
    await handleToolCall('hep_run_writing_create_outline_candidates_packet_v1', {
      run_id: run.run_id,
      language: 'en',
      target_length: 'short',
      title: 'Demo Title',
      n_candidates: 2,
    });

    const stagedCandidates: Array<{ staging_uri: string }> = [];
    for (let i = 0; i < 2; i++) {
      const stageRes = await handleToolCall('hep_run_stage_content', {
        run_id: run.run_id,
        content_type: 'outline_plan',
        artifact_suffix: `m10_${i}`,
        content: JSON.stringify(makeValidOutlinePlanV2()),
      });
      expect(stageRes.isError).not.toBe(true);
      stagedCandidates.push(JSON.parse(stageRes.content[0].text) as { staging_uri: string });
    }

    const submitRes = await handleToolCall('hep_run_writing_submit_outline_candidates_v1', {
      run_id: run.run_id,
      candidates: stagedCandidates.map((c, idx) => ({
        candidate_index: idx,
        outline_plan_uri: c.staging_uri,
        client_model: null,
        temperature: null,
        seed: 'unknown',
      })),
    });
    expect(submitRes.isError).not.toBe(true);

    const llmResponsePath = getRunArtifactPath(run.run_id, 'writing_client_llm_response_outline_candidate_00_v1.json');
    expect(fs.existsSync(llmResponsePath)).toBe(true);
    const llmResponse = JSON.parse(fs.readFileSync(llmResponsePath, 'utf-8')) as any;
    expect(llmResponse.version).toBe(1);
    expect(llmResponse.mode_used).toBe('client');
    expect(llmResponse.prompt_packet?.uri).toMatch(/^hep:\/\/runs\//);
    expect(llmResponse.prompt_packet?.sha256).toMatch(/^[a-f0-9]{64}$/i);
    expect(llmResponse.client_raw_output?.uri).toBe(stagedCandidates[0]!.staging_uri);
    expect(llmResponse.client_raw_output?.sha256).toMatch(/^[a-f0-9]{64}$/i);
    expect(llmResponse.client_model).toBeNull();
    expect(llmResponse.temperature).toBeNull();
    expect(llmResponse.seed).toBe('unknown');
    expect(llmResponse.cache_hit).toBe(false);
    expect(llmResponse.cached_response_uri).toBeNull();
    expect(typeof llmResponse.parsed).toBe('object');
  });

  it('inferWritingRoundFromArtifacts detects highest round from artifacts', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'm10 round infer', description: 'm10' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_reviewer_report_round_02.json'), JSON.stringify({ ok: true }, null, 2), 'utf-8');
    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_revision_plan_round_03_v1.json'), JSON.stringify({ ok: true }, null, 2), 'utf-8');

    expect(inferWritingRoundFromArtifacts(run.run_id)).toBe(3);
  });

  it('external API cache hits are auditable and deterministic', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'm10 external cache', description: 'm10' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    let fetchCalls = 0;
    const fetch = async () => {
      fetchCalls += 1;
      return { ok: true, value: 42 };
    };

    const first = await cachedExternalApiJsonCall({
      run_id: run.run_id,
      namespace: 'test',
      operation: 'echo',
      request: { a: 1 },
      fetch,
    });
    expect(first.cache_hit).toBe(false);

    const second = await cachedExternalApiJsonCall({
      run_id: run.run_id,
      namespace: 'test',
      operation: 'echo',
      request: { a: 1 },
      fetch,
    });
    expect(second.cache_hit).toBe(true);
    expect(fetchCalls).toBe(1);

    const responsePath = getRunArtifactPath(run.run_id, second.artifacts[1]!.name);
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as any;
    expect(response.cache_hit).toBe(true);
    expect(typeof response.cached_response_uri).toBe('string');
    expect(response.cached_response_uri).toMatch(/^file:\/\//);
  });

  it('external API cache corruption is fail-fast (writes parse_error artifact)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'm10 cache corrupt', description: 'm10' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const first = await cachedExternalApiJsonCall({
      run_id: run.run_id,
      namespace: 'test',
      operation: 'corrupt',
      request: { a: 1 },
      fetch: async () => ({ ok: true, value: 1 }),
    });
    expect(first.cache_hit).toBe(false);

    const cachePath = fileURLToPath(new URL(first.cached_response_uri));
    fs.writeFileSync(cachePath, '{ not json', 'utf-8');

    const parseErrName = `external_api_cache_parse_error_test_corrupt_${first.request_hash}.json`;
    await expect(
      cachedExternalApiJsonCall({
        run_id: run.run_id,
        namespace: 'test',
        operation: 'corrupt',
        request: { a: 1 },
        fetch: async () => ({ ok: true, value: 2 }),
      })
    ).rejects.toBeInstanceOf(McpError);

    expect(fs.existsSync(getRunArtifactPath(run.run_id, parseErrName))).toBe(true);
  });

  it('external API cache IO failures are fail-fast', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'm10 cache fail', description: 'm10' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const cacheDirPath = path.join(dataDir, 'cache');
    fs.writeFileSync(cacheDirPath, 'not a directory', 'utf-8');

    await expect(
      cachedExternalApiJsonCall({
        run_id: run.run_id,
        namespace: 'test',
        operation: 'io_fail',
        request: { a: 1 },
        fetch: async () => ({ ok: true }),
      })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('updateRunManifestAtomic prevents lost updates under concurrency', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'm10 atomic manifest', description: 'm10' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const total = 12;
    const refs = Array.from({ length: total }, (_, i) =>
      writeRunJsonArtifact(run.run_id, `concurrent_${String(i).padStart(2, '0')}.json`, { i })
    );

    const updates = refs.map((ref, i) =>
      updateRunManifestAtomic({
        run_id: run.run_id,
        update: async current => {
          if (i === 0) await sleepMs(30);
          const now = new Date().toISOString();
          return {
            ...current,
            updated_at: now,
            steps: [
              ...current.steps,
              { step: `concurrent_${String(i).padStart(2, '0')}`, status: 'done', started_at: now, completed_at: now, artifacts: [ref] },
            ],
          };
        },
      })
    );

    await Promise.all(updates);

    const manifest = getRun(run.run_id);
    const concurrentSteps = manifest.steps.filter(s => s.step.startsWith('concurrent_'));
    expect(concurrentSteps).toHaveLength(total);
    for (let i = 0; i < total; i++) {
      const name = `concurrent_${String(i).padStart(2, '0')}`;
      const step = concurrentSteps.find(s => s.step === name);
      expect(step).toBeTruthy();
      expect(step?.artifacts?.some(a => a.name === `concurrent_${String(i).padStart(2, '0')}.json`)).toBe(true);
    }

    const lockPath = path.join(getRunDir(run.run_id), '.manifest.lock');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('updateRunManifestAtomic fails fast on lock timeout', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'm10 lock timeout', description: 'm10' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const lockPath = path.join(getRunDir(run.run_id), '.manifest.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }, null, 2), 'utf-8');

    await expect(
      updateRunManifestAtomic({
        run_id: run.run_id,
        lock_timeout_ms: 50,
        update: current => current,
      })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('hep_run_clear_manifest_lock clears stale locks and refuses active locks without force', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'm10 clear lock', description: 'm10' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const lockPath = path.join(getRunDir(run.run_id), '.manifest.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }, null, 2), 'utf-8');

    const activeRes = await handleToolCall('hep_run_clear_manifest_lock', { run_id: run.run_id, force: false });
    expect(activeRes.isError).toBe(true);
    const activePayload = JSON.parse(activeRes.content[0]?.text ?? '{}') as { error?: { code?: string } };
    expect(activePayload.error?.code).toBe('INVALID_PARAMS');

    const forceRes = await handleToolCall('hep_run_clear_manifest_lock', { run_id: run.run_id, force: true });
    expect(forceRes.isError).not.toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);

    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, created_at: '2000-01-01T00:00:00.000Z' }, null, 2), 'utf-8');
    const staleRes = await handleToolCall('hep_run_clear_manifest_lock', { run_id: run.run_id, force: false });
    expect(staleRes.isError).not.toBe(true);
    const stalePayload = JSON.parse(staleRes.content[0]?.text ?? '{}') as { cleared?: boolean };
    expect(stalePayload.cleared).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
