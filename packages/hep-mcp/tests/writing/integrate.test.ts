import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { getRun, type RunManifest } from '../../src/core/runs.js';
import { getRunArtifactPath } from '../../src/core/paths.js';
import { integrateWritingSections } from '../../src/core/writing/integrate.js';
import { detectTerminologyVariants, detectUnusedMaterials } from '../../src/core/writing/globalChecks.js';

describe('M12.3: Phase 2 Integration (internal stage)', () => {
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

  it('detects terminology variants (hyphen vs space)', () => {
    const variants = detectTerminologyVariants({
      sections: [
        { section_number: '1', content: 'We discuss cross-section data in experiments.' },
        { section_number: '2', content: 'We discuss cross section data in experiments.' },
      ],
      min_total_occurrences: 1,
    });

    expect(variants.some(v => v.canonical.includes('cross section data'))).toBe(true);
  });

  it('detects unused assets by evidence_id in integrated text', () => {
    const res = detectUnusedMaterials({
      assigned_claim_ids: ['c1'],
      used_claim_ids: ['c1'],
      assigned_asset_ids: ['eq_abc123'],
      document_text: 'No asset markers here.',
    });
    expect(res.unused_assets.map(a => a.evidence_id)).toContain('eq_abc123');
  });

  it('integrates sections into a single LaTeX document and updates manifest step', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'phase2', description: 'phase2' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    // Minimal prerequisites: packets + outline + section artifacts.
    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_packets_sections.json'),
      JSON.stringify(
        {
          version: 1,
          run_id: run.run_id,
          sections: [
            {
              index: 1,
              section_number: '1',
              section_title: 'Intro',
              packet: {
                section: { number: '1', title: 'Intro', type: 'introduction' },
                assigned_assets: { equations: [{ evidence_id: 'eq_abc123' }], figures: [], tables: [] },
                global_context: { cross_ref_hints: { this_section_defines: [] } },
              },
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_outline_v2.json'),
      JSON.stringify(
        {
          version: 2,
          generated_at: '2024-01-01T00:00:00.000Z',
          run_id: run.run_id,
          request: { target_length: 'short' },
          outline_plan: { total_suggested_words: 40 },
        },
        null,
        2
      ),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_section_001.json'),
      JSON.stringify(
        {
          version: 1,
          run_id: run.run_id,
          section_index: 1,
          section_number: '1',
          section_title: 'Intro',
          section_output: {
            content: 'We reference Eq[eq_abc123] and discuss it substantively. This paragraph adds enough words to pass the heuristic check by providing context, comparison, and interpretation of the equation terms.',
            attributions: [{ claim_ids: ['c1'] }],
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    // M07: LaTeX compile gate requires a BibTeX artifact when run_bibtex=true.
    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_master.bib'), '% stub bibtex\\n', 'utf-8');

    const res = await integrateWritingSections({ run_id: run.run_id });
    const names = new Set(res.artifacts.map(a => a.name));
    expect(names.has('writing_integrated.tex')).toBe(true);
    expect(names.has('writing_integrate_diagnostics_v1.json')).toBe(true);

    const manifest: RunManifest = getRun(run.run_id);
    const step = manifest.steps.find(s => s.step === 'writing_integrate');
    expect(step).toBeTruthy();
  });
});
