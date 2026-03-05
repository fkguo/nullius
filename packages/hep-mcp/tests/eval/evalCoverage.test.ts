import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runEvalSet } from '../../src/eval/index.js';
import { assertEvalSnapshot, readEvalFixture } from './evalSnapshots.js';
import { readEvalSetFixture } from './evalSnapshots.js';

const { handleToolCall } = await import('../../src/tools/index.js');
const { readHepResource } = await import('../../src/core/resources.js');

type CoverageInput = { draft_fixture: string };
type CoverageExpected = { snapshot?: string };

type CoverageReport = {
  version?: number;
  sources?: { attempted?: number; failed?: number; [key: string]: unknown };
  dataset?: { meta_artifact?: string | null; has_more?: boolean | null; max_results?: number | null };
  evidence?: {
    latex_total_items?: number | null;
    pdf_included?: boolean | null;
    max_evidence_items_hit?: boolean | null;
  };
  citations?: Record<string, unknown>;
  human_summary?: string;
};

function readResourceText(uri: string): string {
  const resource = readHepResource(uri);
  if (!('text' in resource)) {
    throw new Error(`Expected text resource: ${uri}`);
  }
  return resource.text;
}

describe('eval: coverage_report completeness (local-only)', () => {
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

  it('produces coverage_report with dataset/evidence/citations/sources + human_summary', async () => {
    const evalSet = readEvalSetFixture('coverage_eval_set.json');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-tex-'));
    try {
      const goodTex = path.join(tmp, 'main.tex');
      fs.writeFileSync(
        goodTex,
        ['\\documentclass{article}', '\\begin{document}', 'Hello world.', '\\end{document}', ''].join('\n'),
        'utf-8'
      );

      const projectRes = await handleToolCall('hep_project_create', { name: 'Eval Project', description: 'eval-coverage' });
      const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

      const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
      const run = JSON.parse(runRes.content[0].text) as { run_id: string };

      const report = await runEvalSet<CoverageInput, CoverageReport>(evalSet, {
        run: async (input: CoverageInput) => {
          const draft = readEvalFixture<unknown>(String(input.draft_fixture ?? 'draft_minimal.json'));
          await handleToolCall('hep_run_build_writing_evidence', {
            run_id: run.run_id,
            continue_on_error: false,
            latex_sources: [{ identifier: 'paper_good', main_tex_path: goodTex }],
            max_evidence_items: 200,
            embedding_dim: 64,
          });
          await handleToolCall('hep_render_latex', {
            run_id: run.run_id,
            draft,
            allowed_citations: [],
          });
          const exportRes = await handleToolCall('hep_export_project', {
            _confirm: true,
            run_id: run.run_id,
            include_evidence_digests: false,
          });
          const exportPayload = JSON.parse(exportRes.content[0].text) as {
            artifacts: Array<{ name: string; uri: string }>;
          };
          const coverageUri = exportPayload.artifacts.find(a => a.name === 'coverage_report.json')?.uri;
          if (!coverageUri) {
            throw new Error('Missing coverage_report.json artifact');
          }
          const coverageText = readResourceText(coverageUri);
          const coverage = JSON.parse(coverageText) as CoverageReport;
          return coverage;
        },
        judge: (expected, coverage) => {
          const snapshotName = String((expected as CoverageExpected).snapshot ?? 'coverage_report_minimal');
          expect(coverage.dataset).toBeTruthy();
          expect(coverage.evidence).toBeTruthy();
          expect(coverage.citations).toBeTruthy();
          expect(coverage.human_summary).toEqual(expect.any(String));
          expect(String(coverage.human_summary).length).toBeGreaterThan(10);
          assertEvalSnapshot(snapshotName, {
            version: coverage.version,
            sources: coverage.sources,
            dataset: {
              meta_artifact: coverage.dataset?.meta_artifact ?? null,
              has_more: coverage.dataset?.has_more ?? null,
              max_results: coverage.dataset?.max_results ?? null,
            },
            evidence: {
              latex_total_items: coverage.evidence?.latex_total_items ?? null,
              pdf_included: coverage.evidence?.pdf_included ?? null,
              max_evidence_items_hit: coverage.evidence?.max_evidence_items_hit ?? null,
            },
            citations: coverage.citations,
            human_summary: coverage.human_summary,
          });
          return {
            passed: true,
            metrics: {
              source_attempted: Number(coverage.sources?.attempted ?? 0),
              source_failed: Number(coverage.sources?.failed ?? 0),
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
