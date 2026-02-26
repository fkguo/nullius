import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { getRun } from '../../src/core/runs.js';
import { getRunArtifactPath } from '../../src/core/paths.js';

function makeValidOutlinePlanV2(): any {
  return {
    language: 'en',
    title: 'Mock title',
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

function writePapersetArtifacts(runId: string, projectId: string): void {
  fs.writeFileSync(
    getRunArtifactPath(runId, 'writing_candidate_pool_v1.json'),
    JSON.stringify(
      {
        version: 1,
        generated_at: '2026-01-01T00:00:00Z',
        run_id: runId,
        project_id: projectId,
        seed_identifiers: ['111', '222'],
        candidates: [
          { paper_id: 'inspire:111', inspire_recid: '111', title: 'Paper 111', authors: [], arxiv_categories: [], provenance: [] },
          { paper_id: 'inspire:222', inspire_recid: '222', title: 'Paper 222', authors: [], arxiv_categories: [], provenance: [] },
        ],
      },
      null,
      2
    ),
    'utf-8'
  );

  fs.writeFileSync(
    getRunArtifactPath(runId, 'writing_candidate_pool_expanded_v1.json'),
    JSON.stringify(
      {
        version: 1,
        generated_at: '2026-01-01T00:00:00Z',
        run_id: runId,
        project_id: projectId,
        seed_identifiers: ['111', '222'],
        resolved_seed_recids: ['111', '222'],
        expansion: {
          depth: 1,
          include_references: true,
          include_citations: true,
          references_size: 1,
          citations_size: 1,
          concurrency: 1,
          max_api_calls: 1,
          max_candidates: 10,
          min_candidates: 0,
          enrich_abstracts_top_k: 0,
        },
        edges: [],
        unresolved_identifiers: [],
        stats: {
          seeds_total: 2,
          seeds_resolved: 2,
          api_calls: 0,
          candidates_total: 2,
          references_total: 0,
          citations_total: 0,
          abstracts_enriched: 0,
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  fs.writeFileSync(
    getRunArtifactPath(runId, 'writing_paperset_v1.json'),
    JSON.stringify(
      {
        version: 1,
        generated_at: '2026-01-01T00:00:00Z',
        run_id: runId,
        project_id: projectId,
        request: {
          language: 'auto',
          target_length: 'short',
          title: 'Mock title',
          topic: 'Mock topic',
          seed_identifiers: ['111', '222'],
          candidate_pool_artifact_name: 'writing_candidate_pool_v1.json',
          candidate_count: 2,
        },
        paperset: {
          language: 'en',
          title: 'Mock title',
          topic: 'Mock topic',
          included_papers: [
            { paper_id: 'inspire:111', reason: 'seed', tags: [], cluster_id: 'c0' },
            { paper_id: 'inspire:222', reason: 'seed', tags: [], cluster_id: 'c0' },
          ],
          excluded_papers: [],
          taxonomy: {
            axes: [{ axis_id: 'axis0', label: 'topic', description: 'mock' }],
            clusters: [{ cluster_id: 'c0', label: 'all', description: 'all', paper_ids: ['inspire:111', 'inspire:222'], representative_papers: ['inspire:111'] }],
            perspectives: [],
          },
          quotas: { by_cluster: [{ cluster_id: 'c0', min: 2 }] },
          discovery_plan: { breadth: 1, depth: 1, concurrency: 1, max_api_calls: 1, max_candidates: 10 },
          noise_filters: [{ filter_id: 'nf0', description: 'mock', rationale: 'mock' }],
          notes: [],
        },
        traceability: {
          candidate_pool_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/writing_candidate_pool_v1.json`,
          prompt_packet_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/writing_paperset_curation_packet.json`,
        },
      },
      null,
      2
    ),
    'utf-8'
  );
}

vi.mock('../../src/api/client.js', () => ({
  getPaper: vi.fn().mockResolvedValue({
    title: 'Mock Paper',
    authors: ['Author One'],
    year: 2024,
    arxiv_id: '2401.00001',
    doi: '10.0000/mock',
  }),
  getBibtex: vi.fn().mockResolvedValue(`@article{Mock:2024abc,
  title = {Mock Paper},
  author = {Author, One},
  year = {2024},
  url = {https://inspirehep.net/literature/123}
}`),
}));

vi.mock('../../src/tools/research/conflictDetector.js', () => ({
  detectConflicts: vi.fn().mockResolvedValue({
    success: true,
    conflicts: [],
    compatible_groups: [],
    summary: {
      papers_analyzed: 2,
      total_measurements: 0,
      hard_conflicts: 0,
      soft_conflicts: 0,
      apparent_conflicts: 0,
      compatible_quantities: 0,
    },
  }),
}));

vi.mock('../../src/tools/writing/claimsTable/generator.js', () => ({
  generateClaimsTable: vi.fn().mockResolvedValue({
    claims_table: {
      id: 'mock-claims-table',
      corpus_snapshot: { paper_count: 2, recids: ['111', '222'], date_range: { start: 2024, end: 2024 }, snapshot_date: '2024-01-01' },
      claims: [
        {
          claim_id: 'c1',
          claim_no: '1',
          claim_text: 'Model A predicts something.',
          category: 'theoretical_prediction',
          status: 'consensus',
          paper_ids: ['111'],
          supporting_evidence: [],
          assumptions: [],
          scope: 'global',
          evidence_grade: 'evidence',
          keywords: ['model'],
          is_extractive: true,
        },
      ],
      visual_assets: {
        formulas: [{ evidence_id: 'eq1', latex: 'E=mc^2', importance: 'high' }],
        figures: [{ evidence_id: 'fig1', caption: 'Caption', graphics_paths: [], discussion_contexts: [], importance: 'high' }],
        tables: [{ evidence_id: 'tab1', caption: 'Table', content_summary: 'Summary' }],
      },
      disagreement_graph: { edges: [], clusters: [] },
      notation_table: [],
      glossary: [],
      analysis_dimensions: { methodological_comparisons: [], result_significance: [], open_questions: [] },
      metadata: { created_at: '2024-01-01', processing_time_ms: 1, source_paper_count: 2, version: '2.0' },
      statistics: {
        total_claims: 1,
        claims_by_category: {} as any,
        claims_by_status: {} as any,
        total_formulas: 1,
        total_figures: 1,
        total_tables: 1,
        coverage_ratio: 1.0,
      },
    },
    processing_time_ms: 1,
    warnings: [],
    references_added: 1,
  }),
}));

describe('M12.4: inspire_deep_research(write) quality_level gating', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;
  let texBinDir: string;
  let originalPathEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-'));
    process.env.HEP_DATA_DIR = dataDir;

    // M07: LaTeX compile gate is hard; tests provide a stub TeX toolchain via PATH.
    originalPathEnv = process.env.PATH;
    texBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-tex-bin-'));

    const pdflatexPath = path.join(texBinDir, 'pdflatex');
    const bibtexPath = path.join(texBinDir, 'bibtex');

    fs.writeFileSync(
      pdflatexPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'echo \"stub pdflatex\"',
        // compileRunLatexOrThrow expects main.pdf in cwd
        ': > main.pdf',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      bibtexPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'echo \"stub bibtex\"',
        'exit 0',
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.chmodSync(pdflatexPath, 0o755);
    fs.chmodSync(bibtexPath, 0o755);

    process.env.PATH = `${texBinDir}${path.delimiter}${process.env.PATH ?? ''}`;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });

    if (originalPathEnv !== undefined) process.env.PATH = originalPathEnv;
    else delete process.env.PATH;
    if (texBinDir && fs.existsSync(texBinDir)) fs.rmSync(texBinDir, { recursive: true, force: true });
  });

  it('rejects removed quality_level=draft (fail-fast)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'M12 draft', description: 'm12' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const res = await handleToolCall('inspire_deep_research', {
      identifiers: ['111', '222'],
      mode: 'write',
      run_id: run.run_id,
      options: {
        topic: 'Mock topic',
        title: 'Mock title',
        target_length: 'short',
        llm_mode: 'client',
        quality_level: 'draft',
        language: 'en',
      },
    });
    expect(res.isError).toBe(true);

    const payload = JSON.parse(res.content[0].text) as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
  });

  it('returns outline prompt_packet + next_actions when quality_level=standard (client mode)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'M12 standard', description: 'm12' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    writePapersetArtifacts(run.run_id, project.project_id);

    const res = await handleToolCall('inspire_deep_research', {
      identifiers: ['111', '222'],
      mode: 'write',
      run_id: run.run_id,
      options: {
        topic: 'Mock topic',
        title: 'Mock title',
        target_length: 'short',
        llm_mode: 'client',
        quality_level: 'standard',
        language: 'en',
      },
    });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as any;
    const names = new Set((payload.run?.artifacts ?? []).map((a: any) => a.name));
    expect(names.has('writing_quality_policy_v1.json')).toBe(true);
    expect(names.has('writing_critical_summary.json')).toBe(true);
    expect(names.has('writing_outline_plan_packet.json')).toBe(true);
    expect((payload.run?.next_actions ?? []).some((a: any) => a.tool === 'hep_run_writing_create_outline_candidates_packet_v1')).toBe(true);

    const manifest = getRun(run.run_id);
    expect(manifest.steps.some(s => s.step === 'writing_outline')).toBe(true);
  });

  it('accepts user_outline and persists it in writing_outline_v2.json request', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'M12 user outline', description: 'm12' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    writePapersetArtifacts(run.run_id, project.project_id);

    const res = await handleToolCall('inspire_deep_research', {
      identifiers: ['111', '222'],
      mode: 'write',
      run_id: run.run_id,
      options: {
        topic: 'Mock topic',
        title: 'Mock title',
        target_length: 'short',
        llm_mode: 'client',
        quality_level: 'publication',
        user_outline: `# Introduction\n# Summary and Outlook\n`,
        language: 'en',
      },
    });
    expect(res.isError).not.toBe(true);

    await handleToolCall('hep_run_writing_create_outline_candidates_packet_v1', {
      run_id: run.run_id,
      language: 'en',
      target_length: 'short',
      title: 'Mock title',
      topic: 'Mock topic',
      user_outline: `# Introduction\n# Summary and Outlook\n`,
    });

    const stagedCandidates: Array<{ staging_uri: string }> = [];
    for (let i = 0; i < 3; i++) {
      const stageRes = await handleToolCall('hep_run_stage_content', {
        run_id: run.run_id,
        content_type: 'outline_plan',
        artifact_suffix: `outline_candidate_${i}`,
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

    await handleToolCall('hep_run_writing_create_outline_judge_packet_v1', {
      run_id: run.run_id,
      candidates_uri: candidatesUri,
    });

    const judgeDecision = {
      version: 1,
      generated_at: new Date().toISOString(),
      run_id: run.run_id,
      candidate_type: 'outline_plan_v2',
      candidates_uri: candidatesUri,
      decision: { type: 'select', selected_candidate_index: 0 },
      scores_by_candidate: [
        { candidate_index: 0, structure: 0.9, groundedness: 0.9, citation_discipline: 0.9, relevance: 0.9, cohesion: 0.9, overall: 0.9 },
        { candidate_index: 1, structure: 0.8, groundedness: 0.8, citation_discipline: 0.8, relevance: 0.8, cohesion: 0.8, overall: 0.8 },
        { candidate_index: 2, structure: 0.7, groundedness: 0.7, citation_discipline: 0.7, relevance: 0.7, cohesion: 0.7, overall: 0.7 },
      ],
      reasoning:
        'Candidate 0 is the most coherent overall, assigns claims cleanly, and balances structure and groundedness while matching the requested outline constraints.',
      key_differences: ['Candidate 0 uses a clearer section ordering and avoids overlapping claim assignments compared to others.'],
      fix_recommendations: [],
    };

    const stageJudgeRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'judge_decision',
      artifact_suffix: 'outline_judge_decision',
      content: JSON.stringify(judgeDecision),
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
    expect(submitJudgeRes.isError).not.toBe(true);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_outline_v2.json'))).toBe(true);

    const outlineV2 = JSON.parse(fs.readFileSync(getRunArtifactPath(run.run_id, 'writing_outline_v2.json'), 'utf-8')) as any;
    expect(outlineV2.request?.user_outline).toBe(`# Introduction\n# Summary and Outlook\n`);
    expect(Array.isArray(outlineV2.outline_plan?.sections)).toBe(true);
    expect(outlineV2.outline_plan.sections.some((s: any) => s.type === 'body')).toBe(true);
    const assignedPrimary = outlineV2.outline_plan.sections
      .filter((s: any) => s.type === 'body')
      .reduce((sum: number, s: any) => sum + (Array.isArray(s.assigned_claim_ids) ? s.assigned_claim_ids.length : 0), 0);
    expect(assignedPrimary).toBeGreaterThan(0);
  });
});
