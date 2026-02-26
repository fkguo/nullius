import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { getRun } from '../../src/core/runs.js';
import { getRunArtifactPath } from '../../src/core/paths.js';

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

describe('M13: OutlinePlanV2 N-best + judge selection', () => {
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

  it('create candidates packet → submit candidates → judge-select writes writing_outline_v2.json', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'outline v2', description: 'm13' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    writeClaimsTable(run.run_id);

    const packetRes = await handleToolCall('hep_run_writing_create_outline_candidates_packet_v1', {
      run_id: run.run_id,
      language: 'en',
      target_length: 'short',
      title: 'Demo Title',
      topic: 'Demo Topic',
      n_candidates: 2,
    });
    expect(packetRes.isError).not.toBe(true);

    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_outline_candidates_packet_v1.json'))).toBe(true);

    const stagedCandidates: Array<{ staging_uri: string }> = [];
    for (let i = 0; i < 2; i++) {
      const stageRes = await handleToolCall('hep_run_stage_content', {
        run_id: run.run_id,
        content_type: 'outline_plan',
        artifact_suffix: `m13_outline_candidate_${i}`,
        content: JSON.stringify(makeValidOutlinePlanV2()),
      });
      expect(stageRes.isError).not.toBe(true);
      stagedCandidates.push(JSON.parse(stageRes.content[0].text) as { staging_uri: string });
    }

    const submitCandidatesRes = await handleToolCall('hep_run_writing_submit_outline_candidates_v1', {
      run_id: run.run_id,
      candidates: stagedCandidates.map((c, idx) => ({
        candidate_index: idx,
        outline_plan_uri: c.staging_uri,
        client_model: null,
        temperature: null,
        seed: 'unknown',
      })),
    });
    expect(submitCandidatesRes.isError).not.toBe(true);

    const submitCandidatesPayload = JSON.parse(submitCandidatesRes.content[0].text) as { summary?: { candidates_uri?: string } };
    const candidatesUri = submitCandidatesPayload.summary?.candidates_uri;
    expect(typeof candidatesUri).toBe('string');

    await handleToolCall('hep_run_writing_create_outline_judge_packet_v1', { run_id: run.run_id, candidates_uri: candidatesUri });

    const judgeDecision = {
      version: 1,
      generated_at: new Date().toISOString(),
      run_id: run.run_id,
      candidate_type: 'outline_plan_v2',
      candidates_uri: candidatesUri,
      decision: { type: 'select', selected_candidate_index: 0 },
      scores_by_candidate: [
        { candidate_index: 0, structure: 0.9, groundedness: 0.9, citation_discipline: 0.9, relevance: 0.9, cohesion: 0.9, overall: 0.9 },
        { candidate_index: 1, structure: 0.85, groundedness: 0.85, citation_discipline: 0.85, relevance: 0.85, cohesion: 0.85, overall: 0.85 },
      ],
      reasoning:
        'Candidate 0 is the most coherent overall, covers required semantic slots cleanly, and aligns best with the quality policy thresholds while remaining internally consistent.',
      key_differences: ['Candidate 0 has clearer section ordering and more consistent dependencies than candidate 1.'],
      fix_recommendations: [],
    };

    const stageJudgeRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'judge_decision',
      artifact_suffix: 'm13_outline_judge',
      content: JSON.stringify(judgeDecision),
    });
    expect(stageJudgeRes.isError).not.toBe(true);
    const stagedJudge = JSON.parse(stageJudgeRes.content[0].text) as { staging_uri: string };

    const submitRes = await handleToolCall('hep_run_writing_submit_outline_judge_decision_v1', {
      run_id: run.run_id,
      judge_decision_uri: stagedJudge.staging_uri,
      client_model: null,
      temperature: null,
      seed: 'unknown',
    });
    expect(submitRes.isError).not.toBe(true);

    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_outline_v2.json'))).toBe(true);
    const outlineArtifact = JSON.parse(fs.readFileSync(getRunArtifactPath(run.run_id, 'writing_outline_v2.json'), 'utf-8')) as any;
    expect(outlineArtifact.version).toBe(2);
    expect(outlineArtifact.outline_plan?.sections?.length).toBe(3);

    const manifest = getRun(run.run_id);
    const step = manifest.steps.find(s => s.step === 'writing_outline');
    expect(step?.status).toBe('done');
  });

  it('rejects outline candidates when staging content_type mismatches', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'outline v2 mismatch', description: 'm13' });
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

    const stageRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      // default content_type is section_output; keep it to trigger mismatch.
      artifact_suffix: 'mismatch',
      content: JSON.stringify(makeValidOutlinePlanV2()),
    });
    expect(stageRes.isError).not.toBe(true);
    const staged = JSON.parse(stageRes.content[0].text) as { staging_uri: string };

    const submitRes = await handleToolCall('hep_run_writing_submit_outline_candidates_v1', {
      run_id: run.run_id,
      candidates: [
        { candidate_index: 0, outline_plan_uri: staged.staging_uri, client_model: null, temperature: null, seed: 'unknown' },
        { candidate_index: 1, outline_plan_uri: staged.staging_uri, client_model: null, temperature: null, seed: 'unknown' },
      ],
    });
    expect(submitRes.isError).toBe(true);

    const payload = JSON.parse(submitRes.content[0]?.text ?? '{}') as { error?: { code?: string } };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
  });

  it('rejects cross-run outline_plan staging URIs', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'outline v2 cross', description: 'm13' });
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

  it('rejects outline_plan when cross_ref_map uses a concept before it is defined', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'outline v2 xref order', description: 'm13' });
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

    const bad = makeValidOutlinePlanV2();
    bad.cross_ref_map = {
      defines: [{ section: '2', concept: 'alpha' }],
      uses: [{ section: '1', concept: 'alpha', defined_in: '2' }],
    };

    const okStageRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'outline_plan',
      artifact_suffix: 'xref-order-ok',
      content: JSON.stringify(makeValidOutlinePlanV2()),
    });
    expect(okStageRes.isError).not.toBe(true);
    const okStaged = JSON.parse(okStageRes.content[0].text) as { staging_uri: string };

    const badStageRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'outline_plan',
      artifact_suffix: 'xref-order-bad',
      content: JSON.stringify(bad),
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

    const payload = JSON.parse(submitRes.content[0]?.text ?? '{}') as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_parse_error_candidates_outline_v1.json'))).toBe(true);

    const parseErr = JSON.parse(fs.readFileSync(getRunArtifactPath(run.run_id, 'writing_parse_error_candidates_outline_v1.json'), 'utf-8')) as any;
    const failures = Array.isArray(parseErr.failures) ? parseErr.failures : [];
    const candidateFailures = failures.map((f: any) => f.issues?.data?.issues).flat().filter(Boolean);
    expect(candidateFailures.some((i: any) => i.kind === 'cross_ref_order_conflict')).toBe(true);
  });

  it('rejects outline_plan when requires_sections references a later section', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'outline v2 requires order', description: 'm13' });
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

    const bad = makeValidOutlinePlanV2();
    bad.sections[1].blueprint.dependencies.requires_sections = ['3'];

    const okStageRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'outline_plan',
      artifact_suffix: 'requires-order-ok',
      content: JSON.stringify(makeValidOutlinePlanV2()),
    });
    expect(okStageRes.isError).not.toBe(true);
    const okStaged = JSON.parse(okStageRes.content[0].text) as { staging_uri: string };

    const badStageRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'outline_plan',
      artifact_suffix: 'requires-order-bad',
      content: JSON.stringify(bad),
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

    const payload = JSON.parse(submitRes.content[0]?.text ?? '{}') as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_parse_error_candidates_outline_v1.json'))).toBe(true);

    const parseErr = JSON.parse(fs.readFileSync(getRunArtifactPath(run.run_id, 'writing_parse_error_candidates_outline_v1.json'), 'utf-8')) as any;
    const failures = Array.isArray(parseErr.failures) ? parseErr.failures : [];
    const candidateFailures = failures.map((f: any) => f.issues?.data?.issues).flat().filter(Boolean);
    expect(candidateFailures.some((i: any) => i.kind === 'requires_sections_invalid')).toBe(true);
  });

  it('fails fast when judge_decision schema mismatches (writes parse_error_judge_outline_v1.json)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'outline judge parse', description: 'm13' });
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

    const stageARes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'outline_plan',
      artifact_suffix: 'judge-parse-a',
      content: JSON.stringify(makeValidOutlinePlanV2()),
    });
    expect(stageARes.isError).not.toBe(true);
    const stagedA = JSON.parse(stageARes.content[0].text) as { staging_uri: string };

    const stageBRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'outline_plan',
      artifact_suffix: 'judge-parse-b',
      content: JSON.stringify(makeValidOutlinePlanV2()),
    });
    expect(stageBRes.isError).not.toBe(true);
    const stagedB = JSON.parse(stageBRes.content[0].text) as { staging_uri: string };

    const submitCandidatesRes = await handleToolCall('hep_run_writing_submit_outline_candidates_v1', {
      run_id: run.run_id,
      candidates: [
        { candidate_index: 0, outline_plan_uri: stagedA.staging_uri, client_model: null, temperature: null, seed: 'unknown' },
        { candidate_index: 1, outline_plan_uri: stagedB.staging_uri, client_model: null, temperature: null, seed: 'unknown' },
      ],
    });
    expect(submitCandidatesRes.isError).not.toBe(true);

    const candidatesPayload = JSON.parse(submitCandidatesRes.content[0].text) as { summary?: { candidates_uri?: string } };
    const candidatesUri = candidatesPayload.summary?.candidates_uri;
    expect(typeof candidatesUri).toBe('string');

    await handleToolCall('hep_run_writing_create_outline_judge_packet_v1', { run_id: run.run_id, candidates_uri: candidatesUri });

    const badDecision = { version: 1, nope: true };
    const stageJudgeRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'judge_decision',
      artifact_suffix: 'judge-parse-bad',
      content: JSON.stringify(badDecision),
    });
    expect(stageJudgeRes.isError).not.toBe(true);
    const stagedJudge = JSON.parse(stageJudgeRes.content[0].text) as { staging_uri: string };

    const submitJudgeRes = await handleToolCall('hep_run_writing_submit_outline_judge_decision_v1', {
      run_id: run.run_id,
      judge_decision_uri: stagedJudge.staging_uri,
      client_model: null,
      temperature: null,
      seed: 'unknown',
    });
    expect(submitJudgeRes.isError).toBe(true);

    const payload = JSON.parse(submitJudgeRes.content[0]?.text ?? '{}') as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_parse_error_judge_outline_v1.json'))).toBe(true);
  });

  it('fails hard gate when selected_candidate_index is not overall argmax', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'outline judge hard gate', description: 'm13' });
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

    const stageARes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'outline_plan',
      artifact_suffix: 'judge-hard-a',
      content: JSON.stringify(makeValidOutlinePlanV2()),
    });
    expect(stageARes.isError).not.toBe(true);
    const stagedA = JSON.parse(stageARes.content[0].text) as { staging_uri: string };

    const stageBRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'outline_plan',
      artifact_suffix: 'judge-hard-b',
      content: JSON.stringify(makeValidOutlinePlanV2()),
    });
    expect(stageBRes.isError).not.toBe(true);
    const stagedB = JSON.parse(stageBRes.content[0].text) as { staging_uri: string };

    const submitCandidatesRes = await handleToolCall('hep_run_writing_submit_outline_candidates_v1', {
      run_id: run.run_id,
      candidates: [
        { candidate_index: 0, outline_plan_uri: stagedA.staging_uri, client_model: null, temperature: null, seed: 'unknown' },
        { candidate_index: 1, outline_plan_uri: stagedB.staging_uri, client_model: null, temperature: null, seed: 'unknown' },
      ],
    });
    expect(submitCandidatesRes.isError).not.toBe(true);

    const candidatesPayload = JSON.parse(submitCandidatesRes.content[0].text) as { summary?: { candidates_uri?: string } };
    const candidatesUri = candidatesPayload.summary?.candidates_uri;
    if (typeof candidatesUri !== 'string') throw new Error('Expected candidates_uri in submit_outline_candidates_v1 summary');

    await handleToolCall('hep_run_writing_create_outline_judge_packet_v1', { run_id: run.run_id, candidates_uri: candidatesUri });

    const inconsistentDecision = {
      version: 1,
      generated_at: new Date().toISOString(),
      run_id: run.run_id,
      candidate_type: 'outline_plan_v2',
      candidates_uri: candidatesUri,
      decision: { type: 'select', selected_candidate_index: 0 },
      scores_by_candidate: [
        { candidate_index: 0, structure: 0.9, groundedness: 0.9, citation_discipline: 0.9, relevance: 0.9, cohesion: 0.9, overall: 0.8 },
        { candidate_index: 1, structure: 0.9, groundedness: 0.9, citation_discipline: 0.9, relevance: 0.9, cohesion: 0.9, overall: 0.9 },
      ],
      reasoning:
        'This decision is intentionally inconsistent: it selects candidate 0 even though candidate 1 has a higher overall score, to verify hard gate enforcement.',
      key_differences: ['Candidate 1 has higher overall score, but the decision incorrectly selects candidate 0.'],
      fix_recommendations: [],
    };

    const stageJudgeRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'judge_decision',
      artifact_suffix: 'judge-hard-inconsistent',
      content: JSON.stringify(inconsistentDecision),
    });
    expect(stageJudgeRes.isError).not.toBe(true);
    const stagedJudge = JSON.parse(stageJudgeRes.content[0].text) as { staging_uri: string };

    const submitJudgeRes = await handleToolCall('hep_run_writing_submit_outline_judge_decision_v1', {
      run_id: run.run_id,
      judge_decision_uri: stagedJudge.staging_uri,
      client_model: null,
      temperature: null,
      seed: 'unknown',
    });
    expect(submitJudgeRes.isError).toBe(true);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_judge_outline_v1.json'))).toBe(true);

    const payload = JSON.parse(submitJudgeRes.content[0]?.text ?? '{}') as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(Array.isArray(payload.error?.data?.hard_gate_failures)).toBe(true);
    expect(payload.error.data.hard_gate_failures.some((f: any) => f?.gate === 'selection_consistency_overall_argmax')).toBe(true);
  });
});
