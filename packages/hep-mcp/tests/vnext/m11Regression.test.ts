import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { getRun } from '../../src/vnext/runs.js';
import { getRunArtifactPath, getRunArtifactsDir } from '../../src/vnext/paths.js';
import { ReferenceManager } from '../../src/tools/writing/reference/referenceManager.js';

const QUALITY_EVAL_OK = {
  version: 1,
  overall: { pass: true, score: 0.9, summary: 'Pass' },
  scores: { structure: 0.9, groundedness: 0.9, relevance: 0.9 },
  issues: [],
  retry_feedback: [],
};

const REVIEWER_REPORT_OK = {
  version: 2,
  severity: 'minor',
  summary: 'Looks mostly good.',
  major_issues: [],
  minor_issues: [],
  notation_changes: [],
  asset_pointer_issues: [],
  follow_up_evidence_queries: [],
  structure_issues: [],
  grounding_risks: [],
};

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
              claim_text: 'A minimal claim to satisfy OutlinePlanV2 validation.',
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

function writePacketsSections(runId: string): void {
  fs.writeFileSync(
    getRunArtifactPath(runId, 'writing_packets_sections.json'),
    JSON.stringify(
      {
        version: 1,
        run_id: runId,
        target_length: 'short',
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
}

function writeOutlineV2(runId: string, projectId: string): void {
  fs.writeFileSync(
    getRunArtifactPath(runId, 'writing_outline_v2.json'),
    JSON.stringify(
      {
        version: 2,
        generated_at: '2026-01-12T00:00:00Z',
        run_id: runId,
        project_id: projectId,
        request: {
          language: 'en',
          target_length: 'short',
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
              semantic_slots: ['abstract', 'introduction', 'background'],
              suggested_word_count: 60,
              key_points: ['Set context'],
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
              title: 'Body',
              type: 'body',
              semantic_slots: ['methods', 'results', 'limitations'],
              suggested_word_count: 60,
              key_points: ['Summarize main points'],
              assigned_claim_ids: ['c1'],
              secondary_claim_refs: [],
              assigned_asset_ids: [],
              blueprint: {
                purpose: 'Present main content.',
                key_questions: ['What is the key result?'],
                dependencies: { requires_sections: ['1'], defines_terms: [], uses_terms: [] },
                anti_overlap: { must_not_overlap_with_sections: [], avoid_topics: [] },
              },
            },
            {
              number: '3',
              title: 'Conclusion',
              type: 'summary',
              semantic_slots: ['conclusion'],
              suggested_word_count: 60,
              key_points: ['Conclude'],
              assigned_claim_ids: [],
              secondary_claim_refs: [],
              assigned_asset_ids: [],
              blueprint: {
                purpose: 'Conclude.',
                key_questions: ['What are the takeaways?'],
                dependencies: { requires_sections: ['2'], defines_terms: [], uses_terms: [] },
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

function writeEvidencePacketV2(runId: string): void {
  fs.writeFileSync(
    getRunArtifactPath(runId, 'writing_evidence_packet_section_001_v2.json'),
    JSON.stringify(
      {
        version: 2,
        generated_at: '2026-01-12T00:00:00Z',
        run_id: runId,
        section: { index: 1, title: 'Intro', section_type: 'introduction' },
        allowed: { paper_ids: ['inspire:123'], chunk_ids: ['chunk_1'], claim_ids: [] },
        chunks: [
          {
            id: 'chunk_1',
            type: 'text',
            text: 'Evidence text placeholder.',
            locator: { paper_id: 'inspire:123', section_path: ['intro'] },
          },
        ],
      },
      null,
      2
    ),
    'utf-8'
  );
}

function writeStubBibtex(runId: string): void {
  fs.writeFileSync(getRunArtifactPath(runId, 'writing_master.bib'), '% stub bibtex\n', 'utf-8');
}

function installStubTexToolchain(): { binDir: string; originalPath: string | undefined } {
  const originalPath = process.env.PATH;
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-tex-bin-'));
  const pdflatexPath = path.join(binDir, 'pdflatex');
  const bibtexPath = path.join(binDir, 'bibtex');

  fs.writeFileSync(
    pdflatexPath,
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'echo \"stub pdflatex\"', ': > main.pdf', 'exit 0', ''].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(
    bibtexPath,
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'echo \"stub bibtex\"', 'exit 0', ''].join('\n'),
    'utf-8'
  );
  fs.chmodSync(pdflatexPath, 0o755);
  fs.chmodSync(bibtexPath, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;

  return { binDir, originalPath };
}

describe('M11 regression: submit section → integrate → review → revision plan', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;
  let texBinDir: string;
  let originalPathEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-'));
    process.env.HEP_DATA_DIR = dataDir;

    const toolchain = installStubTexToolchain();
    texBinDir = toolchain.binDir;
    originalPathEnv = toolchain.originalPath;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });

    if (originalPathEnv !== undefined) process.env.PATH = originalPathEnv;
    else delete process.env.PATH;
    if (texBinDir && fs.existsSync(texBinDir)) fs.rmSync(texBinDir, { recursive: true, force: true });
  });

  it('runs a minimal closed loop without external LLM calls', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'M11 regression', description: 'm11' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    writeClaimsTable(run.run_id);
    writePacketsSections(run.run_id);
    writeOutlineV2(run.run_id, project.project_id);
    writeEvidencePacketV2(run.run_id);
    writeStubBibtex(run.run_id);

    ensureDummySectionLlmRequest(run.run_id, 1);

    const refManager = new ReferenceManager(getRunArtifactsDir(run.run_id));
    refManager.addReference(
      '123',
      { title: 'Demo', authors: ['Doe'], year: 2020 },
      '@misc{Doe:2020ab,\n  title={Demo},\n  year={2020}\n}'
    );
    await refManager.saveToDisk();

    const content = [
      'We review the key idea of this topic in a compact way~\\cite{inspire:123}. ' +
        'The discussion sets notation and clarifies the scope of the section~\\cite{inspire:123}. ' +
        'We emphasize what will be established and what remains outside the review~\\cite{inspire:123}.',
      '',
      'We summarize a representative result and its interpretation, keeping each claim traceable~\\cite{inspire:123}. ' +
        'We compare it against a simple limiting case to highlight the physical meaning~\\cite{inspire:123}. ' +
        'We also note the main assumptions that control the conclusion~\\cite{inspire:123}.',
      '',
      'We close with a brief synthesis and point to the next section for details~\\cite{inspire:123}. ' +
        'The takeaway is framed conservatively and avoids over-generalization~\\cite{inspire:123}. ' +
        'This ends the section while maintaining continuity with the overall outline~\\cite{inspire:123}.',
    ].join('\n');

    const sectionOutput = {
      section_number: '1',
      title: 'Intro',
      content,
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

    const stagedCandidates: Array<{ staging_uri: string }> = [];
    for (let i = 0; i < 2; i++) {
      const stageRes = await handleToolCall('hep_run_stage_content', {
        run_id: run.run_id,
        content_type: 'section_output',
        artifact_suffix: `m11_section_001_candidate_${i}`,
        content: JSON.stringify(sectionOutput),
      });
      expect(stageRes.isError).not.toBe(true);
      stagedCandidates.push(JSON.parse(stageRes.content[0].text) as { staging_uri: string });
    }

    const sectionCandidatesPacketRes = await handleToolCall('hep_run_writing_create_section_candidates_packet_v1', {
      run_id: run.run_id,
      section_index: 1,
      n_candidates: stagedCandidates.length,
    });
    expect(sectionCandidatesPacketRes.isError).not.toBe(true);

    const submitCandidatesRes = await handleToolCall('hep_run_writing_submit_section_candidates_v1', {
      run_id: run.run_id,
      section_index: 1,
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
    expect(typeof candidatesUri).toBe('string');

    const budgetRes = await handleToolCall('hep_run_writing_create_token_budget_plan_v1', {
      run_id: run.run_id,
      model_context_tokens: 32_000,
    });
    expect(budgetRes.isError).not.toBe(true);

    const judgePacketRes = await handleToolCall('hep_run_writing_create_section_judge_packet_v1', {
      run_id: run.run_id,
      section_index: 1,
      candidates_uri: candidatesUri,
    });
    expect(judgePacketRes.isError).not.toBe(true);

    const judgeDecision = {
      version: 1,
      generated_at: new Date().toISOString(),
      run_id: run.run_id,
      candidate_type: 'section_draft',
      candidates_uri: candidatesUri,
      decision: { type: 'select', selected_candidate_index: 0 },
      scores_by_candidate: [
        { candidate_index: 0, structure: 0.9, groundedness: 0.9, citation_discipline: 0.9, relevance: 0.9, cohesion: 0.9, overall: 0.9 },
        { candidate_index: 1, structure: 0.8, groundedness: 0.8, citation_discipline: 0.8, relevance: 0.8, cohesion: 0.8, overall: 0.8 },
      ],
      reasoning:
        'Candidate 0 is more coherent overall, keeps claims traceable to allowed citations, and maintains continuity with the outline while meeting structure and groundedness gates.',
      key_differences: ['Candidate 0 has better narrative flow and clearer traceable citations than candidate 1.'],
      fix_recommendations: [],
    };

    const stageJudgeRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'judge_decision',
      artifact_suffix: 'm11_section_001_judge',
      content: JSON.stringify(judgeDecision),
    });
    expect(stageJudgeRes.isError).not.toBe(true);
    const stagedJudge = JSON.parse(stageJudgeRes.content[0].text) as { staging_uri: string };

    const submitRes = await handleToolCall('hep_run_writing_submit_section_judge_decision_v1', {
      run_id: run.run_id,
      section_index: 1,
      judge_decision_uri: stagedJudge.staging_uri,
      quality_eval: QUALITY_EVAL_OK,
      client_model: null,
      temperature: null,
      seed: 'unknown',
    });
    expect(submitRes.isError).not.toBe(true);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_section_001.json'))).toBe(true);

    const integrateRes = await handleToolCall('hep_run_writing_integrate_sections_v1', { run_id: run.run_id });
    expect(integrateRes.isError).not.toBe(true);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_integrated.tex'))).toBe(true);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_integrate_diagnostics_v1.json'))).toBe(true);

    const manifestAfterIntegrate = getRun(run.run_id);
    expect(manifestAfterIntegrate.steps.some(s => s.step === 'writing_integrate' && s.status === 'done')).toBe(true);

    const reviewRes = await handleToolCall('hep_run_writing_submit_review', {
      run_id: run.run_id,
      round: 1,
      reviewer_report: REVIEWER_REPORT_OK,
    });
    expect(reviewRes.isError).not.toBe(true);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_reviewer_report.json'))).toBe(true);

    const reviewerReportUri = `hep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('writing_reviewer_report_round_01.json')}`;
    const manifestUri = `hep://runs/${encodeURIComponent(run.run_id)}/manifest`;

    const packetRes = await handleToolCall('hep_run_writing_create_revision_plan_packet_v1', {
      reviewer_report_uri: reviewerReportUri,
      manifest_uri: manifestUri,
      round: 1,
    });
    expect(packetRes.isError).not.toBe(true);

    const packetPayload = JSON.parse(packetRes.content[0].text) as any;
    expect(Array.isArray(packetPayload.next_actions)).toBe(true);
    expect(packetPayload.next_actions.some((a: any) => a.tool === 'hep_run_writing_submit_revision_plan_v1')).toBe(true);

    const plan = {
      version: 1,
      round: 1,
      max_rounds: 1,
      actions: [
        {
          type: 'rewrite_section',
          target_section_index: 1,
          inputs: [reviewerReportUri],
          rewrite_instructions: 'Tighten the intro and improve clarity while staying grounded in allowed evidence.',
          expected_verifications: ['citations', 'structure'],
        },
      ],
    };

    const stageRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'revision_plan',
      artifact_suffix: 'm11',
      content: JSON.stringify(plan),
    });
    expect(stageRes.isError).not.toBe(true);
    const staged = JSON.parse(stageRes.content[0].text) as { staging_uri: string };

    const submitPlanRes = await handleToolCall('hep_run_writing_submit_revision_plan_v1', {
      run_id: run.run_id,
      revision_plan_uri: staged.staging_uri,
    });
    expect(submitPlanRes.isError).not.toBe(true);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_revision_plan_round_01_v1.json'))).toBe(true);

    const manifestAfterRevise = getRun(run.run_id);
    expect(manifestAfterRevise.steps.some(s => s.step === 'writing_revise')).toBe(true);
  });
});
