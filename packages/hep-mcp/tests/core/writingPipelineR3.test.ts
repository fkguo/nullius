import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { readHepResource } from '../../src/core/resources.js';
import { getRunArtifactPath } from '../../src/core/paths.js';

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
          target_length: 'long',
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
  year = {2024}
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
          claim_text: 'Intro claim.',
          category: 'summary',
          status: 'consensus',
          paper_ids: ['111'],
          supporting_evidence: [],
          assumptions: [],
          scope: 'global',
          evidence_grade: 'evidence',
          keywords: ['intro'],
          is_extractive: true,
        },
        {
          claim_id: 'c2',
          claim_no: '2',
          claim_text: 'Main result claim.',
          category: 'experimental_result',
          status: 'disputed',
          paper_ids: ['222'],
          supporting_evidence: [],
          assumptions: [],
          scope: 'global',
          evidence_grade: 'hint',
          keywords: ['result'],
          is_extractive: true,
        },
        {
          claim_id: 'c3',
          claim_no: '3',
          claim_text: 'Summary claim.',
          category: 'interpretation',
          status: 'emerging',
          paper_ids: ['111', '222'],
          supporting_evidence: [],
          assumptions: [],
          scope: 'global',
          evidence_grade: 'indirect',
          keywords: ['summary'],
          is_extractive: false,
        },
      ],
      visual_assets: {
        formulas: [{ evidence_id: 'eq1' }, { evidence_id: 'eq2' }, { evidence_id: 'eq3' }],
        figures: [{ evidence_id: 'fig1' }, { evidence_id: 'fig2' }],
        tables: [{ evidence_id: 'tab1' }],
      },
      disagreement_graph: { edges: [], clusters: [] },
      notation_table: [],
      glossary: [],
      analysis_dimensions: { methodological_comparisons: [], result_significance: [], open_questions: [] },
      metadata: { created_at: '2024-01-01', processing_time_ms: 1, source_paper_count: 2, version: '2.0' },
      statistics: {
        total_claims: 3,
        claims_by_category: {} as any,
        claims_by_status: {} as any,
        total_formulas: 3,
        total_figures: 2,
        total_tables: 1,
        coverage_ratio: 1.0,
      },
    },
    processing_time_ms: 1,
    warnings: [],
  }),
}));

vi.mock('../../src/tools/writing/outline/generator.js', () => ({
  generateOutline: vi.fn().mockReturnValue({
    outline: [
      {
        number: '1',
        title: 'Introduction',
        type: 'introduction',
        assigned_claims: ['c1'],
        assigned_figures: [],
        assigned_equations: [],
        assigned_tables: [],
      },
      {
        number: '2',
        title: 'Main Results',
        type: 'body',
        assigned_claims: ['c2'],
        assigned_figures: ['fig1'],
        assigned_equations: ['eq1'],
        assigned_tables: ['tab1'],
      },
      {
        number: '3',
        title: 'Summary',
        type: 'summary',
        assigned_claims: ['c3'],
        assigned_figures: [],
        assigned_equations: [],
        assigned_tables: [],
      },
    ],
    total_claims_assigned: 3,
    total_assets_assigned: 3,
  }),
}));

describe('Open Roadmap R3: run-based writing pipeline integrates critical + quotas + incremental outlines', () => {
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

  it('stops at outline prompt_packet and returns next_actions (client mode)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'R3 pipeline', description: 'r3' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    writePapersetArtifacts(run.run_id, project.project_id);

    const deepRes = await handleToolCall('inspire_deep_research', {
      identifiers: ['111', '222'],
      mode: 'write',
      run_id: run.run_id,
      options: {
        topic: 'Mock topic',
        title: 'Mock title',
        target_length: 'long',
        llm_mode: 'client',
        language: 'en',
      },
    });
    expect(deepRes.isError).not.toBe(true);

    const payload = JSON.parse(deepRes.content[0].text) as {
      run?: {
        artifacts?: Array<{ name: string; uri: string }>;
        next_actions?: Array<{ tool: string }>;
        summary?: { waiting_for?: string };
      };
    };
    const names = new Set(payload.run?.artifacts?.map(a => a.name) ?? []);

    expect(names.has('writing_critical_summary.json')).toBe(true);
    expect(names.has('writing_outline_plan_packet.json')).toBe(true);
    expect(names.has('writing_packets_sections.json')).toBe(false);

    expect(payload.run?.summary?.waiting_for).toBe('outline_plan_submission');
    expect((payload.run?.next_actions ?? []).some(a => a.tool === 'hep_run_writing_create_outline_candidates_packet_v1')).toBe(true);

    const packetUri = payload.run?.artifacts?.find(a => a.name === 'writing_outline_plan_packet.json')?.uri;
    expect(packetUri).toBeTruthy();
    const packet = JSON.parse(String((readHepResource(packetUri!) as any).text)) as any;
    expect(packet.prompt_packet?.schema_name).toBe('outline_plan_v2');
  });
});
