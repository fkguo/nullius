import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runEvalSet, type EvalCase } from '../../src/eval/index.js';
import { assertEvalSnapshot } from './evalSnapshots.js';
import { readEvalSetFixture } from './evalSnapshots.js';

const { handleToolCall } = await import('../../src/tools/index.js');
const { readHepResource } = await import('../../src/core/resources.js');

type EvidenceInput = { continue_on_error: boolean };

type WritingEvidenceSummary = {
  latex_items?: number;
  pdf_included?: boolean;
  embedding_dim?: number;
  warnings_total?: number;
};

type WritingEvidencePayload = {
  artifacts: Array<{ name: string; uri: string }>;
  summary?: WritingEvidenceSummary;
};

type SourceStatusEntry = {
  source_kind: string;
  identifier: string;
  status: string;
  error_code?: string | null;
};

type SourceStatusPayload = {
  summary?: { total?: number; failed?: number };
  sources?: SourceStatusEntry[];
};

function readResourceText(uri: string): string {
  const resource = readHepResource(uri);
  if (!('text' in resource)) {
    throw new Error(`Expected text resource: ${uri}`);
  }
  return resource.text;
}

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
    const evalSet = readEvalSetFixture('evidence_eval_set.json');
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

      const report = await runEvalSet<
        EvidenceInput,
        { buildPayload: WritingEvidencePayload; status: SourceStatusPayload }
      >(evalSet, {
        run: async (input: EvidenceInput) => {
          const buildRes = await handleToolCall('hep_run_build_writing_evidence', {
            run_id: run.run_id,
            continue_on_error: input.continue_on_error,
            latex_sources: [
              { identifier: 'paper_good', main_tex_path: goodTex },
              { identifier: 'paper_missing', main_tex_path: missingTex },
            ],
            max_evidence_items: 200,
            embedding_dim: 64,
          });
          const buildPayload = JSON.parse(buildRes.content[0].text) as WritingEvidencePayload;
          const sourceStatusUri = buildPayload.artifacts.find(a => a.name === 'writing_evidence_source_status.json')?.uri;
          if (!sourceStatusUri) {
            throw new Error('Missing writing_evidence_source_status.json artifact');
          }
          const statusText = readResourceText(sourceStatusUri);
          const status = JSON.parse(statusText) as SourceStatusPayload;
          return { buildPayload, status };
        },
        judge: (expected, actual, evalCase: EvalCase) => {
          const expectedSnapshot = String((expected as { snapshot?: string }).snapshot ?? evalCase.id);
          const simplifiedSources = Array.isArray(actual.status.sources)
            ? actual.status.sources.map(source => ({
                source_kind: source.source_kind,
                identifier: source.identifier,
                status: source.status,
                error_code: source.error_code ?? null,
              }))
            : [];
          assertEvalSnapshot(expectedSnapshot, {
            summary: actual.status.summary,
            sources: simplifiedSources,
            tool_summary: {
              latex_items: actual.buildPayload.summary?.latex_items,
              pdf_included: actual.buildPayload.summary?.pdf_included,
              embedding_dim: actual.buildPayload.summary?.embedding_dim,
              warnings_total: actual.buildPayload.summary?.warnings_total,
            },
          });
          return {
            passed: true,
            metrics: {
              source_total: Number(actual.status.summary?.total ?? 0),
              source_failed: Number(actual.status.summary?.failed ?? 0),
            },
          };
        },
      });

      expect(report.summary.total).toBe(1);
      expect(report.summary.failed).toBe(0);
    } finally {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
