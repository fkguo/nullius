import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { getRunArtifactPath, getRunArtifactsDir } from '../../src/core/paths.js';
import { getRun } from '../../src/core/runs.js';
import { ReferenceManager } from '../../src/tools/writing/reference/referenceManager.js';

const QUALITY_EVAL_OK = {
  version: 1,
  overall: { pass: true, score: 0.9, summary: 'Pass' },
  scores: { structure: 0.9, groundedness: 0.9, relevance: 0.9 },
  issues: [],
  retry_feedback: [],
};

function writeOutlineV2(params: { run_id: string; project_id: string; target_length: 'short' | 'medium' | 'long' }): void {
  fs.writeFileSync(
    getRunArtifactPath(params.run_id, 'writing_outline_v2.json'),
    JSON.stringify(
      {
        version: 2,
        generated_at: '2026-01-12T00:00:00Z',
        run_id: params.run_id,
        project_id: params.project_id,
        request: {
          language: 'en',
          target_length: params.target_length,
          title: 'Test Outline',
          topic: 'Test',
          claims_artifact_name: 'writing_claims_table.json',
        },
        outline_plan: {
          language: 'en',
          title: 'Test Outline',
          sections: [
            {
              number: '1',
              title: 'Intro',
              type: 'introduction',
              semantic_slots: ['abstract', 'introduction', 'background', 'methods', 'results', 'limitations'],
              suggested_word_count: 200,
              key_points: ['Intro'],
              assigned_claim_ids: [],
              secondary_claim_refs: [],
              assigned_asset_ids: [],
              blueprint: {
                purpose: 'Introduce and set context.',
                key_questions: ['What is the topic?'],
                dependencies: { requires_sections: [], defines_terms: [], uses_terms: [] },
                anti_overlap: { must_not_overlap_with_sections: [], avoid_topics: [] },
              },
            },
            {
              number: '2',
              title: 'Bridge',
              type: 'introduction',
              semantic_slots: ['background'],
              suggested_word_count: 200,
              key_points: ['Bridge'],
              assigned_claim_ids: [],
              secondary_claim_refs: [],
              assigned_asset_ids: [],
              blueprint: {
                purpose: 'Provide bridging context.',
                key_questions: ['How does this connect?'],
                dependencies: { requires_sections: [], defines_terms: [], uses_terms: [] },
                anti_overlap: { must_not_overlap_with_sections: [], avoid_topics: [] },
              },
            },
            {
              number: '3',
              title: 'Conclusion',
              type: 'summary',
              semantic_slots: ['conclusion'],
              suggested_word_count: 200,
              key_points: ['Conclusion'],
              assigned_claim_ids: [],
              secondary_claim_refs: [],
              assigned_asset_ids: [],
              blueprint: {
                purpose: 'Conclude.',
                key_questions: ['What are the takeaways?'],
                dependencies: { requires_sections: [], defines_terms: [], uses_terms: [] },
                anti_overlap: { must_not_overlap_with_sections: [], avoid_topics: [] },
              },
            },
          ],
          structure_rationale: 'Test',
          global_narrative: {
            main_thread: 'Test',
            section_order_rationale: 'Test',
            abstract_generation_strategy: 'Test',
          },
          cross_ref_map: { defines: [], uses: [] },
          claim_dependency_graph: { edges: [] },
        },
      },
      null,
      2
    ),
    'utf-8'
  );
}

function writeTokenBudgetPlanV1(params: { run_id: string; project_id: string; max_context_tokens: number }): void {
  fs.writeFileSync(
    getRunArtifactPath(params.run_id, 'writing_token_budget_plan_v1.json'),
    JSON.stringify(
      {
        version: 1,
        generated_at: '2026-01-12T00:00:00Z',
        run_id: params.run_id,
        project_id: params.project_id,
        model_context_hint: { max_context_tokens: params.max_context_tokens },
        safety_margin_tokens: 512,
        overflow_policy: 'fail_fast',
        per_step_budgets: {
          outline: { reserved_output_tokens: 2048 },
          evidence_rerank: { reserved_output_tokens: 512 },
          section_write: { reserved_output_tokens: 4096 },
          review: { reserved_output_tokens: 2048 },
          revise: { reserved_output_tokens: 3072 },
        },
      },
      null,
      2
    ),
    'utf-8'
  );
}

describe('M13: N-best section candidates + judge decision submission', () => {
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

  function pad3(n: number): string {
    return String(n).padStart(3, '0');
  }

  function ensureDummySectionLlmRequest(runId: string, sectionIndex: number): void {
    const name = `llm_request_writing_sections_section_${pad3(sectionIndex)}_round_01.json`;
    const p = getRunArtifactPath(runId, name);
    if (fs.existsSync(p)) return;
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          version: 1,
          generated_at: new Date().toISOString(),
          run_id: runId,
          step: 'writing_sections',
          round: 1,
          mode_used: 'client',
          schema: 'section_output@1',
          prompt_packet: { system_prompt: 'stub', user_prompt: 'stub' },
        },
        null,
        2
      ),
      'utf-8'
    );
  }

  async function runSectionM13Pipeline(params: {
    run_id: string;
    section_index: number;
    candidates: any[];
    quality_eval?: any;
    judge_selected_candidate_index?: number;
  }): Promise<{
    submit: Awaited<ReturnType<typeof handleToolCall>>;
    candidates_uri: string;
    judge_decision_uri: string;
  }> {
    const runId = params.run_id;
    const sectionIndex = params.section_index;
    const nCandidates = params.candidates.length;
    expect(nCandidates).toBeGreaterThanOrEqual(2);

    ensureDummySectionLlmRequest(runId, sectionIndex);
    const packetRes = await handleToolCall('hep_run_writing_create_section_candidates_packet_v1', {
      run_id: runId,
      section_index: sectionIndex,
      n_candidates: nCandidates,
    });
    expect(packetRes.isError).not.toBe(true);

    const stagedCandidates: Array<{ staging_uri: string }> = [];
    for (let i = 0; i < nCandidates; i++) {
      const stageRes = await handleToolCall('hep_run_stage_content', {
        run_id: runId,
        content_type: 'section_output',
        artifact_suffix: `section_${pad3(sectionIndex)}_cand_${String(i).padStart(2, '0')}`,
        content: JSON.stringify(params.candidates[i]),
      });
      expect(stageRes.isError).not.toBe(true);
      stagedCandidates.push(JSON.parse(stageRes.content[0].text) as { staging_uri: string });
    }

    const submitCandidatesRes = await handleToolCall('hep_run_writing_submit_section_candidates_v1', {
      run_id: runId,
      section_index: sectionIndex,
      candidates: stagedCandidates.map((c, idx) => ({
        candidate_index: idx,
        section_output_uri: c.staging_uri,
        client_model: null,
        temperature: null,
        seed: 'unknown',
      })),
    });
    expect(submitCandidatesRes.isError).not.toBe(true);
    const submitCandidatesPayload = JSON.parse(submitCandidatesRes.content[0].text) as { summary?: { candidates_uri?: string } };
    const candidatesUri = submitCandidatesPayload.summary?.candidates_uri;
    if (typeof candidatesUri !== 'string') throw new Error('Expected candidates_uri in submit_section_candidates_v1 summary');

    // TokenGate prerequisite for judge prompt generation.
    const budgetRes = await handleToolCall('hep_run_writing_create_token_budget_plan_v1', {
      run_id: runId,
      model_context_tokens: 32_000,
    });
    expect(budgetRes.isError).not.toBe(true);

    const judgePacketRes = await handleToolCall('hep_run_writing_create_section_judge_packet_v1', {
      run_id: runId,
      section_index: sectionIndex,
      candidates_uri: candidatesUri,
    });
    expect(judgePacketRes.isError).not.toBe(true);

    const selectedIdx = params.judge_selected_candidate_index ?? 0;
    const judgeDecision = {
      version: 1,
      generated_at: new Date().toISOString(),
      run_id: runId,
      candidate_type: 'section_draft',
      candidates_uri: candidatesUri,
      decision: { type: 'select', selected_candidate_index: selectedIdx },
      scores_by_candidate: Array.from({ length: nCandidates }, (_, idx) => ({
        candidate_index: idx,
        structure: idx === selectedIdx ? 0.9 : 0.8,
        groundedness: idx === selectedIdx ? 0.9 : 0.8,
        citation_discipline: idx === selectedIdx ? 0.9 : 0.8,
        relevance: idx === selectedIdx ? 0.9 : 0.8,
        cohesion: idx === selectedIdx ? 0.9 : 0.8,
        overall: idx === selectedIdx ? 0.9 : 0.8,
      })),
      reasoning:
        'Candidate 0 is preferred because it best satisfies structure and groundedness gates, keeps citations within the allowlist, and maintains continuity with the outline.',
      key_differences: ['Candidate 0 has clearer structure and more consistent citation discipline than other candidates.'],
      fix_recommendations: [],
    };

    const stageJudgeRes = await handleToolCall('hep_run_stage_content', {
      run_id: runId,
      content_type: 'judge_decision',
      artifact_suffix: `section_${pad3(sectionIndex)}_judge_decision`,
      content: JSON.stringify(judgeDecision),
    });
    expect(stageJudgeRes.isError).not.toBe(true);
    const stagedJudge = JSON.parse(stageJudgeRes.content[0].text) as { staging_uri: string };

    const submitRes = await handleToolCall('hep_run_writing_submit_section_judge_decision_v1', {
      run_id: runId,
      section_index: sectionIndex,
      judge_decision_uri: stagedJudge.staging_uri,
      ...(params.quality_eval !== undefined ? { quality_eval: params.quality_eval } : {}),
      client_model: null,
      temperature: null,
      seed: 'unknown',
    });

    return { submit: submitRes, candidates_uri: candidatesUri, judge_decision_uri: stagedJudge.staging_uri };
  }

  it('stores section/verification/originality artifacts and updates run manifest steps', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'R2 submit', description: 'r2' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    // Minimal prerequisites for the submit tool: packets + claims + reference map.
    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_claims_table.json'),
      JSON.stringify(
        {
          claims_table: { corpus_snapshot: { recids: ['123'] }, claims: [] },
          warnings: [],
          processing_time_ms: 0,
          references_added: 0,
        },
        null,
        2
      ),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_packets_sections.json'),
      JSON.stringify(
        {
          version: 1,
          run_id: run.run_id,
          target_length: 'medium',
          sections: [
            {
              index: 1,
              section_number: '1',
              section_title: 'Intro',
              packet: { allowed_citations: ['inspire:123'] },
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    writeOutlineV2({ run_id: run.run_id, project_id: project.project_id, target_length: 'medium' });

    // M04/M06: Submit requires EvidencePacketV2 allowlist (fail-fast if missing).
    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_evidence_packet_section_001_v2.json'),
      JSON.stringify({ version: 2, allowed: { paper_ids: ['inspire:123'] } }, null, 2),
      'utf-8'
    );

    const refDir = getRunArtifactsDir(run.run_id);
    const refManager = new ReferenceManager(refDir);
    refManager.addReference(
      '123',
      { title: 'Demo', authors: ['Doe'], year: 2020 },
      '@misc{Doe:2020ab,\n  title={Demo},\n  year={2020}\n}'
    );
    await refManager.saveToDisk();

    const sectionOutput = {
      section_number: '1',
      title: 'Intro',
      content: [
        'First sentence~\\cite{inspire:123}. Second sentence~\\cite{inspire:123}.',
        '',
        'Third sentence~\\cite{inspire:123}. Fourth sentence~\\cite{inspire:123}.',
        '',
        'Fifth sentence~\\cite{inspire:123}. Sixth sentence~\\cite{inspire:123}.',
      ].join('\n'),
      attributions: [
        {
          sentence: 'A sentence',
          sentence_index: 0,
          claim_ids: [],
          evidence_ids: [],
          citations: ['inspire:123'],
          type: 'fact',
          is_grounded: true,
        },
      ],
      figures_used: [],
      equations_used: [],
      tables_used: [],
    };

    const { submit: submitRes } = await runSectionM13Pipeline({
      run_id: run.run_id,
      section_index: 1,
      candidates: [sectionOutput, sectionOutput],
      quality_eval: QUALITY_EVAL_OK,
    });
    expect(submitRes.isError).not.toBe(true);

    const payload = JSON.parse(submitRes.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      summary?: { submit_summary?: { verification?: { issues?: number }; originality?: { level?: string } } };
    };

    const names = payload.artifacts.map(a => a.name);
    expect(names).toContain('writing_quality_policy_v1.json');
    expect(names).toContain('writing_quality_eval_section_001_v1.json');
    expect(names).toContain('writing_originality_001.json');
    expect(names).toContain('writing_quality_001.json');
    expect(names).toContain('writing_section_001.json');
    expect(names).toContain('writing_verification_001.json');
    expect(payload.summary?.submit_summary?.verification?.issues).toBe(0);
    expect(payload.summary?.submit_summary?.originality?.level).toBeTruthy();

    // Manifest reflects step progress (at least sections/verify/originality should exist).
    const manifest = getRun(run.run_id);
    const stepNames = manifest.steps.map(s => s.step);
    expect(stepNames).toContain('writing_sections');
    expect(stepNames).toContain('writing_verify');
    expect(stepNames).toContain('writing_originality');
  });

  it('fails fast when section_output.content is empty', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'R2 submit empty', description: 'r2' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_claims_table.json'),
      JSON.stringify(
        {
          claims_table: { corpus_snapshot: { recids: ['123'] }, claims: [] },
          warnings: [],
          processing_time_ms: 0,
          references_added: 0,
        },
        null,
        2
      ),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_packets_sections.json'),
      JSON.stringify(
        {
          version: 1,
          run_id: run.run_id,
          target_length: 'medium',
          sections: [
            {
              index: 1,
              section_number: '1',
              section_title: 'Intro',
              packet: { allowed_citations: ['inspire:123'] },
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    writeOutlineV2({ run_id: run.run_id, project_id: project.project_id, target_length: 'medium' });

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_evidence_packet_section_001_v2.json'),
      JSON.stringify({ version: 2, allowed: { paper_ids: ['inspire:123'] } }, null, 2),
      'utf-8'
    );

    const refDir = getRunArtifactsDir(run.run_id);
    const refManager = new ReferenceManager(refDir);
    refManager.addReference(
      '123',
      { title: 'Demo', authors: ['Doe'], year: 2020 },
      '@misc{Doe:2020ab,\n  title={Demo},\n  year={2020}\n}'
    );
    await refManager.saveToDisk();

    const sectionOutput = { section_number: '1', title: 'Intro', content: '   ' };
    const { submit: submitRes } = await runSectionM13Pipeline({
      run_id: run.run_id,
      section_index: 1,
      candidates: [sectionOutput, sectionOutput],
      quality_eval: QUALITY_EVAL_OK,
    });
    expect(submitRes.isError).toBe(true);

    const payload = JSON.parse(submitRes.content[0].text) as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(String(payload.error?.message ?? '')).toMatch(/non-empty/i);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_section_001.json'))).toBe(false);
  });

  it('returns retry_advice when post-hoc asset coverage fails', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'R2 submit retry', description: 'r2' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_claims_table.json'),
      JSON.stringify(
        {
          claims_table: { corpus_snapshot: { recids: ['123'] }, claims: [] },
          warnings: [],
          processing_time_ms: 0,
          references_added: 0,
        },
        null,
        2
      ),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_packets_sections.json'),
      JSON.stringify(
        {
          version: 1,
          run_id: run.run_id,
          target_length: 'medium',
          sections: [
            {
              index: 1,
              section_number: '1',
              section_title: 'Intro',
              packet: {
                section: { number: '1', title: 'Intro', type: 'introduction' },
                allowed_citations: ['inspire:123'],
                assigned_assets: { equations: [{ evidence_id: 'eq_abc123', label: 'eq:mass', number: '3' }], figures: [], tables: [] },
                word_budget: { min_words: 0, max_words: 1000 },
              },
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    writeOutlineV2({ run_id: run.run_id, project_id: project.project_id, target_length: 'medium' });

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_evidence_packet_section_001_v2.json'),
      JSON.stringify({ version: 2, allowed: { paper_ids: ['inspire:123'] } }, null, 2),
      'utf-8'
    );

    const refDir = getRunArtifactsDir(run.run_id);
    const refManager = new ReferenceManager(refDir);
    refManager.addReference(
      '123',
      { title: 'Demo', authors: ['Doe'], year: 2020 },
      '@misc{Doe:2020ab,\n  title={Demo},\n  year={2020}\n}'
    );
    await refManager.saveToDisk();

    const sectionOutput = {
      section_number: '1',
      title: 'Intro',
      content: [
        'First sentence~\\cite{inspire:123}. Second sentence~\\cite{inspire:123}.',
        '',
        'Third sentence~\\cite{inspire:123}. Fourth sentence~\\cite{inspire:123}.',
        '',
        'Fifth sentence~\\cite{inspire:123}. Sixth sentence~\\cite{inspire:123}.',
      ].join('\n'),
      attributions: [
        {
          sentence: 'A sentence',
          sentence_index: 0,
          claim_ids: [],
          evidence_ids: [],
          citations: ['inspire:123'],
          type: 'fact',
          is_grounded: true,
        },
      ],
      figures_used: [],
      equations_used: [],
      tables_used: [],
    };

    const { submit: submitRes } = await runSectionM13Pipeline({
      run_id: run.run_id,
      section_index: 1,
      candidates: [sectionOutput, sectionOutput],
      quality_eval: QUALITY_EVAL_OK,
    });
    expect(submitRes.isError).toBe(true);

    const payload = JSON.parse(submitRes.content[0].text) as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(String(payload.error?.message ?? '')).toMatch(/retry required/i);
    expect(typeof payload.error?.data?.retry_advice_uri).toBe('string');
  });

  it('prefers EvidencePacketV2 allowlist when present (unauthorized citation flagged)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'R2 submit allowlist', description: 'r2' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_claims_table.json'),
      JSON.stringify(
        {
          claims_table: { corpus_snapshot: { recids: ['123', '999'] }, claims: [] },
          warnings: [],
          processing_time_ms: 0,
          references_added: 0,
        },
        null,
        2
      ),
      'utf-8'
    );

    // Packets allow both 123 and 999, but EvidencePacketV2 will restrict to 123 only.
    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_packets_sections.json'),
      JSON.stringify(
        {
          version: 1,
          run_id: run.run_id,
          target_length: 'medium',
          sections: [
            {
              index: 1,
              section_number: '1',
              section_title: 'Intro',
              packet: { allowed_citations: ['inspire:123', 'inspire:999'] },
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    writeOutlineV2({ run_id: run.run_id, project_id: project.project_id, target_length: 'medium' });

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_evidence_packet_section_001_v2.json'),
      JSON.stringify(
        {
          version: 2,
          generated_at: '2026-01-12T00:00:00Z',
          run_id: run.run_id,
          project_id: project.project_id,
          section: { index: 1, title: 'Intro', section_type: 'introduction' },
          allowed: { claim_ids: [], chunk_ids: [], paper_ids: ['inspire:123'] },
          budgets: {
            max_context_tokens: 32_000,
            max_chunks: 1,
            reserved_output_tokens: 4096,
            safety_margin_tokens: 512,
            overflow_policy: 'fail_fast',
            max_evidence_tokens: 1000,
            selected_evidence_tokens_estimate: 0,
          },
          coverage: { requirements: { min_chunks_by_type: {}, require_at_least_one_of: [] }, met: true, missing: [], selected_by_type: {} },
          diversity: { max_chunks_per_source: 1, min_sources: 1, min_per_query: 0, selected_sources: 1 },
          selection_trace: {
            candidates_uri: `hep://runs/${encodeURIComponent(run.run_id)}/artifact/writing_retrieval_candidates_section_001_v1.json`,
            candidates_hash: 'x',
            rerank_prompt_uri: `hep://runs/${encodeURIComponent(run.run_id)}/artifact/writing_rerank_prompt_section_001_v1.txt`,
            rerank_raw_uri: `hep://runs/${encodeURIComponent(run.run_id)}/artifact/writing_rerank_raw_section_001_v1.txt`,
            rerank_result_uri: `hep://runs/${encodeURIComponent(run.run_id)}/artifact/writing_rerank_result_section_001_v1.json`,
            selected_indices: [],
          },
          chunks: [],
        },
        null,
        2
      ),
      'utf-8'
    );

    const refDir = getRunArtifactsDir(run.run_id);
    const refManager = new ReferenceManager(refDir);
    refManager.addReference(
      '123',
      { title: 'Demo', authors: ['Doe'], year: 2020 },
      '@misc{Doe:2020ab,\n  title={Demo},\n  year={2020}\n}'
    );
    await refManager.saveToDisk();

    const sectionOutput = {
      section_number: '1',
      title: 'Intro',
      content: [
        'First sentence~\\cite{inspire:999}. Second sentence~\\cite{inspire:999}.',
        '',
        'Third sentence~\\cite{inspire:999}. Fourth sentence~\\cite{inspire:999}.',
        '',
        'Fifth sentence~\\cite{inspire:999}. Sixth sentence~\\cite{inspire:999}.',
      ].join('\n'),
      attributions: [
        {
          sentence: 'A sentence',
          sentence_index: 0,
          claim_ids: [],
          evidence_ids: [],
          citations: ['inspire:999'],
          type: 'fact',
          is_grounded: true,
        },
      ],
      figures_used: [],
      equations_used: [],
      tables_used: [],
    };

    const { submit: submitRes } = await runSectionM13Pipeline({
      run_id: run.run_id,
      section_index: 1,
      candidates: [sectionOutput, sectionOutput],
      quality_eval: QUALITY_EVAL_OK,
    });
    expect(submitRes.isError).toBe(true);

    const payload = JSON.parse(submitRes.content[0].text) as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');

    const ver = JSON.parse(fs.readFileSync(getRunArtifactPath(run.run_id, 'writing_verification_001.json'), 'utf-8')) as any;
    expect(ver?.verification?.pass).toBe(false);
    expect(Array.isArray(ver?.verification?.issues)).toBe(true);
    expect(ver.verification.issues.some((i: any) => i?.type === 'unauthorized_citation')).toBe(true);
  });

  it('fails fast with INVALID_PARAMS when EvidencePacketV2 JSON is malformed', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'R2 submit malformed v2', description: 'r2' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_claims_table.json'),
      JSON.stringify(
        {
          claims_table: { corpus_snapshot: { recids: ['123'] }, claims: [] },
          warnings: [],
          processing_time_ms: 0,
          references_added: 0,
        },
        null,
        2
      ),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_packets_sections.json'),
      JSON.stringify(
        {
          version: 1,
          run_id: run.run_id,
          target_length: 'medium',
          sections: [
            {
              index: 1,
              section_number: '1',
              section_title: 'Intro',
              packet: { allowed_citations: ['inspire:123'] },
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    writeOutlineV2({ run_id: run.run_id, project_id: project.project_id, target_length: 'medium' });

    // Malformed JSON should be caught and converted into a clean INVALID_PARAMS error.
    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_evidence_packet_section_001_v2.json'), '{ not valid json', 'utf-8');

    const sectionOutput = {
      section_number: '1',
      title: 'Intro',
      content: [
        'First sentence~\\cite{inspire:123}. Second sentence~\\cite{inspire:123}.',
        '',
        'Third sentence~\\cite{inspire:123}. Fourth sentence~\\cite{inspire:123}.',
        '',
        'Fifth sentence~\\cite{inspire:123}. Sixth sentence~\\cite{inspire:123}.',
      ].join('\n'),
      attributions: [
        {
          sentence: 'A sentence',
          sentence_index: 0,
          claim_ids: [],
          evidence_ids: [],
          citations: ['inspire:123'],
          type: 'fact',
          is_grounded: true,
        },
      ],
      figures_used: [],
      equations_used: [],
      tables_used: [],
    };

    const { submit: submitRes } = await runSectionM13Pipeline({
      run_id: run.run_id,
      section_index: 1,
      candidates: [sectionOutput, sectionOutput],
      quality_eval: QUALITY_EVAL_OK,
    });
    expect(submitRes.isError).toBe(true);
    const payload = JSON.parse(submitRes.content[0].text) as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(String(payload.error?.message ?? '')).toMatch(/malformed json/i);
  });

  it('derives minimal attributions from LaTeX citations when attributions are missing (and writes derivation artifact)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'R2 submit derive attributions', description: 'r2' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_claims_table.json'),
      JSON.stringify(
        {
          claims_table: { corpus_snapshot: { recids: ['123'] }, claims: [] },
          warnings: [],
          processing_time_ms: 0,
          references_added: 0,
        },
        null,
        2
      ),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_packets_sections.json'),
      JSON.stringify(
        {
          version: 1,
          run_id: run.run_id,
          target_length: 'medium',
          sections: [
            {
              index: 1,
              section_number: '1',
              section_title: 'Intro',
              packet: { allowed_citations: ['inspire:123'] },
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    writeOutlineV2({ run_id: run.run_id, project_id: project.project_id, target_length: 'medium' });

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_evidence_packet_section_001_v2.json'),
      JSON.stringify({ version: 2, allowed: { paper_ids: ['inspire:123'] }, chunks: [] }, null, 2),
      'utf-8'
    );

    const refDir = getRunArtifactsDir(run.run_id);
    const refManager = new ReferenceManager(refDir);
    refManager.addReference(
      '123',
      { title: 'Demo', authors: ['Doe'], year: 2020 },
      '@misc{Doe:2020ab,\n  title={Demo},\n  year={2020}\n}'
    );
    await refManager.saveToDisk();

    const sectionOutput = {
      section_number: '1',
      title: 'Intro',
      content: [
        'Paragraph one~\\cite{inspire:123}. Another sentence~\\cite{inspire:123}.',
        '',
        'Paragraph two~\\cite{inspire:123}. Another sentence~\\cite{inspire:123}.',
        '',
        'Paragraph three~\\cite{inspire:123}. Another sentence~\\cite{inspire:123}.',
      ].join('\n'),
    };

    const { submit: submitRes } = await runSectionM13Pipeline({
      run_id: run.run_id,
      section_index: 1,
      candidates: [sectionOutput, sectionOutput],
      quality_eval: QUALITY_EVAL_OK,
    });
    expect(submitRes.isError).not.toBe(true);

    const payload = JSON.parse(submitRes.content[0].text) as any;
    const names = (payload.artifacts as Array<{ name: string }>).map(a => a.name).sort();
    expect(names).toContain('writing_attributions_derivation_section_001_v1.json');

    const sectionArtifact = JSON.parse(fs.readFileSync(getRunArtifactPath(run.run_id, 'writing_section_001.json'), 'utf-8')) as any;
    expect(Array.isArray(sectionArtifact?.section_output?.attributions)).toBe(true);
    expect(sectionArtifact.section_output.attributions.length).toBeGreaterThan(0);
  });

  it('fails fast when writing_outline_v2.json is missing (outline contract gate)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'R2 submit outline gate', description: 'r2' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const sectionOutput = { content: 'Test' };
    const { submit: submitRes } = await runSectionM13Pipeline({
      run_id: run.run_id,
      section_index: 1,
      candidates: [sectionOutput, sectionOutput],
      quality_eval: QUALITY_EVAL_OK,
    });
    expect(submitRes.isError).toBe(true);

    const payload = JSON.parse(submitRes.content[0].text) as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(typeof payload.error?.data?.outline_contract_failure_uri).toBe('string');
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_outline_missing_or_invalid.json'))).toBe(true);
  });

  it('fails fast when quality_eval is missing (and writes a quality_eval prompt artifact)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'R2 submit quality eval gate', description: 'r2' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    writeTokenBudgetPlanV1({ run_id: run.run_id, project_id: project.project_id, max_context_tokens: 32_000 });
    writeOutlineV2({ run_id: run.run_id, project_id: project.project_id, target_length: 'medium' });

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_claims_table.json'),
      JSON.stringify(
        {
          claims_table: { corpus_snapshot: { recids: ['123'] }, claims: [] },
          warnings: [],
          processing_time_ms: 0,
          references_added: 0,
        },
        null,
        2
      ),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_packets_sections.json'),
      JSON.stringify(
        {
          version: 1,
          run_id: run.run_id,
          target_length: 'medium',
          sections: [
            {
              index: 1,
              section_number: '1',
              section_title: 'Intro',
              packet: { allowed_citations: ['inspire:123'] },
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_evidence_packet_section_001_v2.json'),
      JSON.stringify({ version: 2, allowed: { paper_ids: ['inspire:123'] }, chunks: [] }, null, 2),
      'utf-8'
    );

    const refDir = getRunArtifactsDir(run.run_id);
    const refManager = new ReferenceManager(refDir);
    refManager.addReference(
      '123',
      { title: 'Demo', authors: ['Doe'], year: 2020 },
      '@misc{Doe:2020ab,\n  title={Demo},\n  year={2020}\n}'
    );
    await refManager.saveToDisk();

    const sectionOutput = {
      section_number: '1',
      title: 'Intro',
      content: [
        'First sentence~\\cite{inspire:123}. Second sentence~\\cite{inspire:123}.',
        '',
        'Third sentence~\\cite{inspire:123}. Fourth sentence~\\cite{inspire:123}.',
        '',
        'Fifth sentence~\\cite{inspire:123}. Sixth sentence~\\cite{inspire:123}.',
      ].join('\n'),
      attributions: [
        {
          sentence: 'A sentence',
          sentence_index: 0,
          claim_ids: [],
          evidence_ids: [],
          citations: ['inspire:123'],
          type: 'fact',
          is_grounded: true,
        },
      ],
      figures_used: [],
      equations_used: [],
      tables_used: [],
    };

    const { submit: submitRes } = await runSectionM13Pipeline({
      run_id: run.run_id,
      section_index: 1,
      candidates: [sectionOutput, sectionOutput],
    });
    expect(submitRes.isError).toBe(true);

    const payload = JSON.parse(submitRes.content[0].text) as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(String(payload.error?.message ?? '')).toMatch(/quality_eval/i);
    expect(typeof payload.error?.data?.quality_eval_prompt_uri).toBe('string');

    const promptArtifact = 'writing_quality_eval_prompt_section_001_v1.json';
    const promptPath = getRunArtifactPath(run.run_id, promptArtifact);
    expect(fs.existsSync(promptPath)).toBe(true);

    const promptPayload = JSON.parse(fs.readFileSync(promptPath, 'utf-8')) as any;
    expect(promptPayload?.prompt_packet?.schema_name).toBe('writing_section_quality_eval_v1');
  });

  it('fails hard gate when selected_candidate_index is not overall argmax', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'R2 judge hard gate', description: 'm13' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    ensureDummySectionLlmRequest(run.run_id, 1);
    await handleToolCall('hep_run_writing_create_section_candidates_packet_v1', { run_id: run.run_id, section_index: 1, n_candidates: 2 });

    const stageARes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'section_output',
      artifact_suffix: 'hard_gate_a',
      content: JSON.stringify({ section_number: '1', title: 'Intro', content: 'A' }),
    });
    expect(stageARes.isError).not.toBe(true);
    const stagedA = JSON.parse(stageARes.content[0].text) as { staging_uri: string };

    const stageBRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'section_output',
      artifact_suffix: 'hard_gate_b',
      content: JSON.stringify({ section_number: '1', title: 'Intro', content: 'B' }),
    });
    expect(stageBRes.isError).not.toBe(true);
    const stagedB = JSON.parse(stageBRes.content[0].text) as { staging_uri: string };

    const submitCandidatesRes = await handleToolCall('hep_run_writing_submit_section_candidates_v1', {
      run_id: run.run_id,
      section_index: 1,
      candidates: [
        { candidate_index: 0, section_output_uri: stagedA.staging_uri, client_model: null, temperature: null, seed: 'unknown' },
        { candidate_index: 1, section_output_uri: stagedB.staging_uri, client_model: null, temperature: null, seed: 'unknown' },
      ],
    });
    expect(submitCandidatesRes.isError).not.toBe(true);
    const submitCandidatesPayload = JSON.parse(submitCandidatesRes.content[0].text) as { summary?: { candidates_uri?: string } };
    const candidatesUri = submitCandidatesPayload.summary?.candidates_uri;
    if (typeof candidatesUri !== 'string') throw new Error('Expected candidates_uri in submit_section_candidates_v1 summary');

    const budgetRes = await handleToolCall('hep_run_writing_create_token_budget_plan_v1', { run_id: run.run_id, model_context_tokens: 32_000 });
    expect(budgetRes.isError).not.toBe(true);

    await handleToolCall('hep_run_writing_create_section_judge_packet_v1', { run_id: run.run_id, section_index: 1, candidates_uri: candidatesUri });

    const inconsistentDecision = {
      version: 1,
      generated_at: new Date().toISOString(),
      run_id: run.run_id,
      candidate_type: 'section_draft',
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
      artifact_suffix: 'hard_gate_judge',
      content: JSON.stringify(inconsistentDecision),
    });
    expect(stageJudgeRes.isError).not.toBe(true);
    const stagedJudge = JSON.parse(stageJudgeRes.content[0].text) as { staging_uri: string };

    const submitJudgeRes = await handleToolCall('hep_run_writing_submit_section_judge_decision_v1', {
      run_id: run.run_id,
      section_index: 1,
      judge_decision_uri: stagedJudge.staging_uri,
      client_model: null,
      temperature: null,
      seed: 'unknown',
    });
    expect(submitJudgeRes.isError).toBe(true);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_judge_section_001_v1.json'))).toBe(true);

    const payload = JSON.parse(submitJudgeRes.content[0]?.text ?? '{}') as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(Array.isArray(payload.error?.data?.hard_gate_failures)).toBe(true);
    expect(payload.error.data.hard_gate_failures.some((f: any) => f?.gate === 'selection_consistency_overall_argmax')).toBe(true);
  });
});
