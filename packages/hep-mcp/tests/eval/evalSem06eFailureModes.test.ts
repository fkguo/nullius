import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createProject } from '../../src/core/projects.js';
import { createRun } from '../../src/core/runs.js';
import { getRunArtifactPath } from '../../src/core/paths.js';
import { queryProjectEvidenceSemantic } from '../../src/core/evidenceSemantic.js';
import { buildRunWritingEvidence } from '../../src/core/writing/evidence.js';
import { buildSem06eLatex, previewHasMarker } from './sem06eEvalSupport.js';

describe('eval: SEM-06e failure modes', () => {
  it('reports unavailable page localization when no PDF page surface exists', async () => {
    const originalDataDir = process.env.HEP_DATA_DIR;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-sem06e-failure-data-'));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-sem06e-failure-tex-'));
    process.env.HEP_DATA_DIR = dataDir;
    try {
      const texPath = path.join(tmpDir, 'main.tex');
      fs.writeFileSync(texPath, buildSem06eLatex(), 'utf-8');
      const project = createProject({ name: 'SEM06e Failure Modes', description: 'eval-sem06e-failure' });
      const { manifest } = createRun({ project_id: project.project_id });
      await buildRunWritingEvidence({
        run_id: manifest.run_id,
        continue_on_error: false,
        latex_sources: [{ identifier: 'paper_sem06e_failure', main_tex_path: texPath, include_inline_math: true }],
        latex_types: ['paragraph', 'equation', 'figure', 'table', 'citation_context'],
        max_evidence_items: 400,
        embedding_dim: 256,
        latex_catalog_artifact_name: 'latex_evidence_catalog.jsonl',
        latex_embeddings_artifact_name: 'latex_evidence_embeddings.jsonl',
        latex_enrichment_artifact_name: 'latex_evidence_enrichment.jsonl',
      });

      const result = await queryProjectEvidenceSemantic({
        run_id: manifest.run_id,
        project_id: project.project_id,
        query: 'what page contains the branching fractions evidence?',
        limit: 10,
      });
      const artifactPath = getRunArtifactPath(manifest.run_id, result.artifacts[0]!.name);
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as {
        localization: { availability: string };
        result: { hits: Array<{ text_preview: string; localization?: { unit?: string; status?: string } }> };
      };
      const top = artifact.result.hits[0]!;

      expect(artifact.localization.availability).toBe('unavailable');
      expect(top.localization?.unit).toBe('chunk');
      expect(top.localization?.status).toBe('fallback_available');
      expect(previewHasMarker(top.text_preview, 'CHUNK_GOLD')).toBe(true);
    } finally {
      if (originalDataDir !== undefined) process.env.HEP_DATA_DIR = originalDataDir;
      else delete process.env.HEP_DATA_DIR;
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
