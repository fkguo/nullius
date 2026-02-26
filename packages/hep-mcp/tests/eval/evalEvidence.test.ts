import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { assertEvalSnapshot } from './evalSnapshots.js';

const { handleToolCall } = await import('../../src/tools/index.js');
const { readHepResource } = await import('../../src/core/resources.js');

describe('eval: writing evidence (continue_on_error + source status)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-data-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('records per-source status and continues on error', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-tex-'));
    try {
      const goodTex = path.join(tmp, 'main.tex');
      const missingTex = path.join(tmp, 'missing.tex');
      fs.writeFileSync(
        goodTex,
        ['\\documentclass{article}', '\\begin{document}', 'Hello world.', '\\end{document}', ''].join('\n'),
        'utf-8'
      );

      const projectRes = await handleToolCall('hep_project_create', { name: 'Eval Project', description: 'eval-evidence' });
      const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

      const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
      const run = JSON.parse(runRes.content[0].text) as { run_id: string };

      const buildRes = await handleToolCall('hep_run_build_writing_evidence', {
        run_id: run.run_id,
        continue_on_error: true,
        latex_sources: [
          { identifier: 'paper_good', main_tex_path: goodTex },
          { identifier: 'paper_missing', main_tex_path: missingTex },
        ],
        max_evidence_items: 200,
        embedding_dim: 64,
      });

      const buildPayload = JSON.parse(buildRes.content[0].text) as { artifacts: Array<{ name: string; uri: string }>; summary: any };
      const sourceStatusUri = buildPayload.artifacts.find(a => a.name === 'writing_evidence_source_status.json')?.uri;
      expect(sourceStatusUri).toBeTruthy();

      const statusText = (readHepResource(sourceStatusUri!) as any).text as string;
      const status = JSON.parse(statusText) as any;

      const simplifiedSources = Array.isArray(status.sources)
        ? status.sources.map((s: any) => ({
            source_kind: s.source_kind,
            identifier: s.identifier,
            status: s.status,
            error_code: s.error_code ?? null,
          }))
        : [];

      assertEvalSnapshot('writing_evidence_source_status', {
        summary: status.summary,
        sources: simplifiedSources,
        tool_summary: {
          latex_items: buildPayload.summary?.latex_items,
          pdf_included: buildPayload.summary?.pdf_included,
          embedding_dim: buildPayload.summary?.embedding_dim,
          warnings_total: buildPayload.summary?.warnings_total,
        },
      });
    } finally {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
