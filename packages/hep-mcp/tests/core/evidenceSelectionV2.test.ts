import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { getProjectPaperJsonPath, getProjectPaperLatexExtractedDir, getRunArtifactPath } from '../../src/core/paths.js';

vi.mock('../../src/api/client.js', () => ({
  getPaper: vi.fn(() => {
    throw new Error('INSPIRE client should not be called in local-source test');
  }),
}));

vi.mock('@autoresearch/arxiv-mcp/tooling', async () => {
  const actual = await vi.importActual('@autoresearch/arxiv-mcp/tooling');
  return {
    ...actual,
    arxivFetch: vi.fn(() => {
      throw new Error('arxivFetch should not be called in local-source test');
    }),
  };
});

function parseToolJson(res: { content: Array<{ type: string; text: string }>; isError?: boolean }): any {
  return JSON.parse(res.content[0]?.text ?? '{}');
}

describe('M04 retrieval + rerank + evidence packet v2 (run tools)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-mcp-evidence-select-'));
    process.env.HEP_DATA_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.HEP_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('client mode produces rerank packet and requires submit before writing evidence packet', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'proj', description: 'test' }, 'standard');
    const project = parseToolJson(projectRes);
    const projectId = project.project_id as string;

    const runRes = await handleToolCall('hep_run_create', { project_id: projectId, args_snapshot: {} }, 'standard');
    const run = parseToolJson(runRes);
    const runId = run.run_id as string;

    const budgetRes = await handleToolCall(
      'hep_run_writing_create_token_budget_plan_v1',
      { run_id: runId, model_context_tokens: 32_000 },
      'standard'
    );
    expect(budgetRes.isError).toBeFalsy();

    const paperId = 'inspire:123';
    const extractedDir = getProjectPaperLatexExtractedDir(projectId, paperId);

    fs.writeFileSync(
      path.join(extractedDir, 'main.tex'),
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Intro}',
        'The Higgs boson mass is measured to be 125 GeV.~\\\\cite{Key1}',
        '',
        'We discuss calibration and systematic uncertainties for Higgs mass extraction.',
        '',
        '\\begin{thebibliography}{9}',
        '\\bibitem{Key1} Author, Title, 2020.',
        '\\end{thebibliography}',
        '\\end{document}',
        '',
      ].join('\n'),
      'utf-8'
    );

    fs.writeFileSync(
      getProjectPaperJsonPath(projectId, paperId),
      JSON.stringify(
        {
          version: 1,
          project_id: projectId,
          paper_id: paperId,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          source: {
            kind: 'latex',
            identifier: paperId,
            main_tex: 'main.tex',
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    const buildIndexRes = await handleToolCall(
      'hep_run_build_evidence_index_v1',
      { run_id: runId, paper_ids: [paperId] },
      'standard'
    );
    expect(buildIndexRes.isError).toBeFalsy();

    const evidencePacketPath = getRunArtifactPath(runId, 'writing_evidence_packet_section_001_v2.json');
    expect(fs.existsSync(evidencePacketPath)).toBe(false);

    const buildRes = await handleToolCall(
      'hep_run_writing_build_evidence_packet_section_v2',
      {
        run_id: runId,
        section_index: 1,
        llm_mode: 'client',
        section_title: 'Intro',
        section_type: 'conclusion',
        queries: ['Higgs mass measurement', 'systematic uncertainties'],
        max_selected_chunks: 2,
        rerank_top_k: 20,
        rerank_output_top_n: 2,
        min_sources: 1,
        min_per_query: 0,
      },
      'standard'
    );
    expect(buildRes.isError).toBeFalsy();
    const build = parseToolJson(buildRes);
    expect(Array.isArray(build.next_actions)).toBe(true);
    expect(String(build.summary?.rerank_packet_uri ?? '')).toContain('writing_rerank_packet_section_001_v1.json');

    expect(fs.existsSync(evidencePacketPath)).toBe(false);

    const submitRes = await handleToolCall(
      'hep_run_writing_submit_rerank_result_v1',
      {
        run_id: runId,
        section_index: 1,
        ranked_indices: [0, 1],
        output_packet_artifact_name: 'writing_evidence_packet_section_001_v2.json',
      },
      'standard'
    );
    expect(submitRes.isError).toBeFalsy();

    expect(fs.existsSync(evidencePacketPath)).toBe(true);
    const packet = JSON.parse(fs.readFileSync(evidencePacketPath, 'utf-8')) as any;
    expect(packet.version).toBe(2);
    expect(packet.allowed?.paper_ids).toEqual(['inspire:123']);
    expect(Array.isArray(packet.allowed?.chunk_ids)).toBe(true);
    expect(packet.allowed.chunk_ids.length).toBe(2);
  });
});
