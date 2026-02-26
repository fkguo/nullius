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

vi.mock('../../src/api/rateLimiter.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/rateLimiter.js')>('../../src/api/rateLimiter.js');
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

describe('M03 evidence ingestion + chunking (run evidence index v1)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-mcp-evidence-index-'));
    process.env.HEP_DATA_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.HEP_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('builds evidence_index_v1.json from project LaTeX sources with stable chunk ids', async () => {
    const projectRes = await handleToolCall(
      'hep_project_create',
      { name: 'proj', description: 'test' },
      'standard'
    );
    const project = parseToolJson(projectRes);
    const projectId = project.project_id as string;

    const runRes = await handleToolCall('hep_run_create', { project_id: projectId, args_snapshot: {} }, 'standard');
    const run = parseToolJson(runRes);
    const runId = run.run_id as string;

    const paperId = 'inspire:123';
    const extractedDir = getProjectPaperLatexExtractedDir(projectId, paperId);

    fs.writeFileSync(
      path.join(extractedDir, 'sec1.tex'),
      [
        '\\begin{equation}',
        'E = mc^2',
        '\\label{eq:einstein}',
        '\\end{equation}',
        '',
      ].join('\n'),
      'utf-8'
    );

    fs.writeFileSync(
      path.join(extractedDir, 'main.tex'),
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Intro}',
        'This is a paragraph with a citation \\cite{Key1}.',
        '\\input{sec1}',
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

    const buildRes1 = await handleToolCall(
      'hep_run_build_evidence_index_v1',
      { run_id: runId, paper_ids: [paperId] },
      'standard'
    );
    expect(buildRes1.isError).toBeFalsy();

    const indexPath = getRunArtifactPath(runId, 'evidence_index_v1.json');
    expect(fs.existsSync(indexPath)).toBe(true);
    const index1 = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as { chunks: Array<{ id: string; type: string }> };

    const ids1 = index1.chunks.map(c => c.id).sort();
    expect(ids1.length).toBeGreaterThan(0);
    expect(index1.chunks.some(c => c.type === 'equation')).toBe(true);
    expect(index1.chunks.some(c => c.type === 'equation_context')).toBe(true);
    expect(index1.chunks.some(c => c.type === 'citation_context')).toBe(true);
    expect(index1.chunks.some(c => c.type === 'bibliography_entry')).toBe(true);

    const ctx = index1.chunks.find(c => c.type === 'equation_context') as any;
    expect(ctx).toBeTruthy();
    expect(typeof ctx.locator?.byte_start).toBe('number');
    expect(typeof ctx.locator?.byte_end).toBe('number');

    const mergedPath = getRunArtifactPath(runId, String(ctx.locator.file_path));
    const mergedContent = fs.readFileSync(mergedPath, 'utf-8');
    const replayed = mergedContent.slice(ctx.locator.byte_start, ctx.locator.byte_end);
    expect(replayed).toBe(ctx.content_latex);

    const buildRes2 = await handleToolCall(
      'hep_run_build_evidence_index_v1',
      { run_id: runId, paper_ids: [paperId] },
      'standard'
    );
    expect(buildRes2.isError).toBeFalsy();

    const index2 = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as { chunks: Array<{ id: string }> };
    const ids2 = index2.chunks.map(c => c.id).sort();
    expect(ids2).toEqual(ids1);

    // Corrupted metrics cache should not crash; it should rebuild and overwrite.
    const metricsPath = getRunArtifactPath(runId, 'evidence_index_metrics_v1.json');
    fs.writeFileSync(metricsPath, '{', 'utf-8');

    const buildRes3 = await handleToolCall(
      'hep_run_build_evidence_index_v1',
      { run_id: runId, paper_ids: [paperId] },
      'standard'
    );
    expect(buildRes3.isError).toBeFalsy();
    const build3 = parseToolJson(buildRes3);
    expect(build3.summary?.cache?.index_cache_hit).toBe(false);
  });

  it('fails fast when citations exist but bibliography is missing', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'proj2' }, 'standard');
    const project = parseToolJson(projectRes);
    const projectId = project.project_id as string;

    const runRes = await handleToolCall('hep_run_create', { project_id: projectId, args_snapshot: {} }, 'standard');
    const run = parseToolJson(runRes);
    const runId = run.run_id as string;

    const paperId = 'inspire:124';
    const extractedDir = getProjectPaperLatexExtractedDir(projectId, paperId);

    fs.writeFileSync(
      path.join(extractedDir, 'main.tex'),
      [
        '\\documentclass{article}',
        '\\begin{document}',
        'This cites \\cite{Key1} but has no bibliography.',
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

    const res = await handleToolCall('hep_run_build_evidence_index_v1', { run_id: runId, paper_ids: [paperId] }, 'standard');
    expect(res.isError).toBe(true);
    const payload = parseToolJson(res) as { error?: { code?: string } };
    expect(payload.error?.code).toBe('INVALID_PARAMS');

    const errPath = getRunArtifactPath(runId, 'evidence_ingestion_error_v1.json');
    expect(fs.existsSync(errPath)).toBe(true);
    const errArtifact = JSON.parse(fs.readFileSync(errPath, 'utf-8')) as { failures?: Array<{ paper_id?: string }> };
    expect(errArtifact.failures?.[0]?.paper_id).toBe(paperId);
  });
});
