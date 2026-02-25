import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { unzipSync } from 'fflate';

import { handleToolCall } from '../../src/tools/index.js';
import { readHepResource } from '../../src/vnext/resources.js';
import { getRunArtifactPath, getRunDir } from '../../src/vnext/paths.js';

describe('vNext M4: hep_import_paper_bundle (paper_bundle.zip)', () => {
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

  it('imports a local paper/ directory into run artifacts (+ optional paper_final.pdf)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'M4 paper import', description: 'm4' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_integrated.tex'), '\\section{Intro}\\nHello.\\n', 'utf-8');
    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_master.bib'), '', 'utf-8');

    const scaffoldRes = await handleToolCall('hep_export_paper_scaffold', { _confirm: true, run_id: run.run_id, overwrite: true });
    expect(scaffoldRes.isError).not.toBe(true);

    const paperDir = path.join(getRunDir(run.run_id), 'paper');
    fs.writeFileSync(path.join(paperDir, 'build_trace.jsonl'), '{"event":"demo"}\n', 'utf-8');
    fs.writeFileSync(path.join(paperDir, 'main.pdf'), Buffer.from('%PDF-1.4\n% demo\n', 'utf-8'));

    const importRes = await handleToolCall('hep_import_paper_bundle', { run_id: run.run_id });
    expect(importRes.isError).not.toBe(true);

    const payload = JSON.parse(importRes.content[0].text) as { artifacts: Array<{ name: string; uri: string }> };
    const uriOf = (name: string): string | undefined => payload.artifacts.find(a => a.name === name)?.uri;

    const manifestUri = uriOf('paper_bundle_manifest.json');
    const zipUri = uriOf('paper_bundle.zip');
    const pdfUri = uriOf('paper_final.pdf');
    expect(manifestUri).toBeTruthy();
    expect(zipUri).toBeTruthy();
    expect(pdfUri).toBeTruthy();

    const bundleManifest = JSON.parse(String((readHepResource(manifestUri!) as any).text)) as any;
    expect(bundleManifest.schemaVersion).toBe('1.0');
    expect(bundleManifest.source?.hepRunId).toBe(run.run_id);
    expect(Array.isArray(bundleManifest.pdfs)).toBe(true);
    expect(bundleManifest.pdfs).toContain('main.pdf');

    const pdfMeta = JSON.parse(String((readHepResource(pdfUri!) as any).text)) as { file_path: string; mimeType?: string };
    expect(String(pdfMeta.mimeType)).toBe('application/pdf');
    expect(fs.readFileSync(pdfMeta.file_path).subarray(0, 4).toString('utf-8')).toBe('%PDF');

    const zipMeta = JSON.parse(String((readHepResource(zipUri!) as any).text)) as { file_path: string; size: number; mimeType?: string };
    expect(String(zipMeta.mimeType)).toBe('application/zip');
    expect(zipMeta.size).toBeGreaterThan(0);
    const zipBytes = fs.readFileSync(zipMeta.file_path);
    expect(zipBytes.subarray(0, 2).toString('utf-8')).toBe('PK');

    const files = unzipSync(new Uint8Array(zipBytes));
    expect(Object.keys(files)).toContain('paper/main.tex');
    expect(Object.keys(files)).toContain('paper/paper_manifest.json');
    expect(Object.keys(files)).toContain('paper/build_trace.jsonl');
    expect(Object.keys(files)).toContain('paper/main.pdf');
  });

  it('dereferences directory symlinks when dereference_symlinks=true', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'M4 paper import (symlink)', description: 'm4' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_integrated.tex'), '\\section{Intro}\\nHello.\\n', 'utf-8');
    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_master.bib'), '', 'utf-8');
    const scaffoldRes = await handleToolCall('hep_export_paper_scaffold', { _confirm: true, run_id: run.run_id, overwrite: true });
    expect(scaffoldRes.isError).not.toBe(true);

    const paperDir = path.join(getRunDir(run.run_id), 'paper');
    const figures = path.join(paperDir, 'figures');
    const figuresReal = path.join(paperDir, 'figures_real');
    fs.rmSync(figures, { recursive: true, force: true });
    fs.mkdirSync(figuresReal, { recursive: true });
    fs.writeFileSync(path.join(figuresReal, 'plot.pdf'), Buffer.from('%PDF-1.4\n% fig\n', 'utf-8'));
    fs.symlinkSync('figures_real', figures, 'dir');

    const importRes = await handleToolCall('hep_import_paper_bundle', { run_id: run.run_id, dereference_symlinks: true });
    expect(importRes.isError).not.toBe(true);

    const payload = JSON.parse(importRes.content[0].text) as { artifacts: Array<{ name: string; uri: string }> };
    const zipUri = payload.artifacts.find(a => a.name === 'paper_bundle.zip')?.uri;
    expect(zipUri).toBeTruthy();
    const zipMeta = JSON.parse(String((readHepResource(zipUri!) as any).text)) as { file_path: string };
    const zipBytes = fs.readFileSync(zipMeta.file_path);
    const files = unzipSync(new Uint8Array(zipBytes));
    expect(Object.keys(files)).toContain('paper/figures/plot.pdf');
  });

  it('fails fast if paper contains hep:// URIs in .tex files', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'M4 paper import (hep uri)', description: 'm4' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_integrated.tex'), '\\section{Intro}\\nHello.\\n', 'utf-8');
    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_master.bib'), '', 'utf-8');
    const scaffoldRes = await handleToolCall('hep_export_paper_scaffold', { _confirm: true, run_id: run.run_id, overwrite: true });
    expect(scaffoldRes.isError).not.toBe(true);

    const paperDir = path.join(getRunDir(run.run_id), 'paper');
    fs.appendFileSync(path.join(paperDir, 'main.tex'), '% hep://runs/demo/artifact/x\\n', 'utf-8');

    const importRes = await handleToolCall('hep_import_paper_bundle', { run_id: run.run_id });
    expect(importRes.isError).toBe(true);
  });
});

