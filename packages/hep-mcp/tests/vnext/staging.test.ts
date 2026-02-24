import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { getRunArtifactPath } from '../../src/vnext/paths.js';

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

describe('vNext: hep_run_stage_content URI parsing (M13 outline candidates)', () => {
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

  it('staging → submit outline candidates succeeds', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'staging outline ok', description: 'm13' });
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

    const staged: Array<{ staging_uri: string }> = [];
    for (let i = 0; i < 2; i++) {
      const stageRes = await handleToolCall('hep_run_stage_content', {
        run_id: run.run_id,
        content_type: 'outline_plan',
        artifact_suffix: `ok_${i}`,
        content: JSON.stringify(makeValidOutlinePlanV2()),
      });
      expect(stageRes.isError).not.toBe(true);
      staged.push(JSON.parse(stageRes.content[0].text) as { staging_uri: string });
    }

    const submitRes = await handleToolCall('hep_run_writing_submit_outline_candidates_v1', {
      run_id: run.run_id,
      candidates: staged.map((s, idx) => ({
        candidate_index: idx,
        outline_plan_uri: s.staging_uri,
        client_model: null,
        temperature: null,
        seed: 'unknown',
      })),
    });
    expect(submitRes.isError).not.toBe(true);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_candidates_outline_v1.json'))).toBe(true);
  });

  it('rejects cross-run staging URIs', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'staging outline cross', description: 'm13' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runARes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const runA = JSON.parse(runARes.content[0].text) as { run_id: string };
    writeClaimsTable(runA.run_id);
    await handleToolCall('hep_run_writing_create_outline_candidates_packet_v1', {
      run_id: runA.run_id,
      language: 'en',
      target_length: 'short',
      title: 'Demo Title',
      n_candidates: 2,
    });

    const runBRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const runB = JSON.parse(runBRes.content[0].text) as { run_id: string };
    writeClaimsTable(runB.run_id);
    await handleToolCall('hep_run_writing_create_outline_candidates_packet_v1', {
      run_id: runB.run_id,
      language: 'en',
      target_length: 'short',
      title: 'Demo Title',
      n_candidates: 2,
    });

    const stageRes = await handleToolCall('hep_run_stage_content', {
      run_id: runA.run_id,
      content_type: 'outline_plan',
      artifact_suffix: 'cross',
      content: JSON.stringify(makeValidOutlinePlanV2()),
    });
    expect(stageRes.isError).not.toBe(true);
    const staged = JSON.parse(stageRes.content[0].text) as { staging_uri: string };

    const submitRes = await handleToolCall('hep_run_writing_submit_outline_candidates_v1', {
      run_id: runB.run_id,
      candidates: [
        { candidate_index: 0, outline_plan_uri: staged.staging_uri, client_model: null, temperature: null, seed: 'unknown' },
        { candidate_index: 1, outline_plan_uri: staged.staging_uri, client_model: null, temperature: null, seed: 'unknown' },
      ],
    });
    expect(submitRes.isError).toBe(true);

    const payload = JSON.parse(submitRes.content[0]?.text ?? '{}') as { error?: { code?: string } };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
  });

  it('rejects invalid staged content via schema validation (writes parse_error_candidates artifact)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'staging outline invalid', description: 'm13' });
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

    const okStageRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'outline_plan',
      artifact_suffix: 'ok',
      content: JSON.stringify(makeValidOutlinePlanV2()),
    });
    expect(okStageRes.isError).not.toBe(true);
    const okStaged = JSON.parse(okStageRes.content[0].text) as { staging_uri: string };

    const badStageRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'outline_plan',
      artifact_suffix: 'bad',
      content: JSON.stringify({ nope: true }),
    });
    expect(badStageRes.isError).not.toBe(true);
    const badStaged = JSON.parse(badStageRes.content[0].text) as { staging_uri: string };

    const submitRes = await handleToolCall('hep_run_writing_submit_outline_candidates_v1', {
      run_id: run.run_id,
      candidates: [
        { candidate_index: 0, outline_plan_uri: okStaged.staging_uri, client_model: null, temperature: null, seed: 'unknown' },
        { candidate_index: 1, outline_plan_uri: badStaged.staging_uri, client_model: null, temperature: null, seed: 'unknown' },
      ],
    });
    expect(submitRes.isError).toBe(true);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_parse_error_candidates_outline_v1.json'))).toBe(true);

    const payload = JSON.parse(submitRes.content[0]?.text ?? '{}') as { error?: { code?: string } };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
  });

  it('rejects malformed staging URIs (no INTERNAL_ERROR)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'staging outline uri malformed', description: 'm13' });
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

    const submitRes = await handleToolCall('hep_run_writing_submit_outline_candidates_v1', {
      run_id: run.run_id,
      candidates: [
        { candidate_index: 0, outline_plan_uri: 'hep://runs/%E0%A4%A/artifact/staged_outline_plan_001.json', client_model: null, temperature: null, seed: 'unknown' },
        { candidate_index: 1, outline_plan_uri: 'hep://runs/%E0%A4%A/artifact/staged_outline_plan_001.json', client_model: null, temperature: null, seed: 'unknown' },
      ],
    });
    expect(submitRes.isError).toBe(true);

    const payload = JSON.parse(submitRes.content[0]?.text ?? '{}') as { error?: { code?: string } };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
  });

  it('rejects path traversal artifact names in staging URIs', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'staging outline uri traversal', description: 'm13' });
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

    const traversalUri = `hep://runs/${encodeURIComponent(run.run_id)}/artifact/..%2F..%2Fetc%2Fpasswd`;
    const submitRes = await handleToolCall('hep_run_writing_submit_outline_candidates_v1', {
      run_id: run.run_id,
      candidates: [
        { candidate_index: 0, outline_plan_uri: traversalUri, client_model: null, temperature: null, seed: 'unknown' },
        { candidate_index: 1, outline_plan_uri: traversalUri, client_model: null, temperature: null, seed: 'unknown' },
      ],
    });
    expect(submitRes.isError).toBe(true);

    const payload = JSON.parse(submitRes.content[0]?.text ?? '{}') as { error?: { code?: string } };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
  });
});
