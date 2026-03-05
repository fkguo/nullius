import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { unzipSync } from 'fflate';

import { handleToolCall } from '../../src/tools/index.js';
import { readHepResource } from '../../src/core/resources.js';
import { getRunArtifactPath } from '../../src/core/paths.js';

describe('vNext M3: hep_export_paper_scaffold (paper/ + paper_scaffold.zip)', () => {
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

  it('exports a portable RevTeX scaffold zip + manifest artifact', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'M3 paper scaffold', description: 'm3' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_integrated.tex'),
      [
        '\\section{Introduction}',
        'We cite a demo reference \\cite{Doe:2020ab}.',
        '',
        '\\section{Conclusion}',
        'Done.',
        '',
      ].join('\n'),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_master.bib'),
      [
        '@misc{Doe:2020ab,',
        '  title = {Demo Reference},',
        '  author = {Doe, John},',
        '  year = {2020}',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    const exportRes = await handleToolCall('hep_export_paper_scaffold', { _confirm: true, run_id: run.run_id });
    expect(exportRes.isError).not.toBe(true);

    const payload = JSON.parse(exportRes.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      summary?: { paper_dir?: string };
    };
    const uriOf = (name: string): string | undefined => payload.artifacts.find(a => a.name === name)?.uri;

    const manifestUri = uriOf('paper_manifest.json');
    const zipUri = uriOf('paper_scaffold.zip');
    expect(manifestUri).toBeTruthy();
    expect(zipUri).toBeTruthy();

    const paperManifest = JSON.parse(String((readHepResource(manifestUri!) as any).text)) as any;
    expect(paperManifest.schemaVersion).toBe(1);
    expect(paperManifest.source?.hepRunId).toBe(run.run_id);
    expect(paperManifest.latex?.mainTex).toBe('main.tex');
    expect(paperManifest.bibliography?.generated).toBe('references_generated.bib');
    expect(paperManifest.bibliography?.manual).toBe('references_manual.bib');
    expect(paperManifest.checksums?.algorithm).toBe('sha256');

    const zipMeta = JSON.parse(String((readHepResource(zipUri!) as any).text)) as {
      file_path: string;
      size: number;
      sha256: string;
      mimeType: string;
    };
    expect(zipMeta.mimeType).toBe('application/zip');
    expect(zipMeta.size).toBeGreaterThan(0);
    const zipBytes = fs.readFileSync(zipMeta.file_path);
    expect(zipBytes.subarray(0, 2).toString('utf-8')).toBe('PK');

    const files = unzipSync(new Uint8Array(zipBytes));
    expect(Object.keys(files)).toContain('paper/main.tex');
    expect(Object.keys(files)).toContain('paper/paper_manifest.json');
    expect(Object.keys(files)).toContain('paper/references_generated.bib');
    expect(Object.keys(files)).toContain('paper/references_manual.bib');
    expect(Object.keys(files).some(k => k.startsWith('paper/sections/section_001_'))).toBe(true);
    expect(Object.keys(files).some(k => k.startsWith('paper/sections/section_002_'))).toBe(true);
    expect(Object.keys(files)).toContain('paper/UNVERIFIED.md');

    const mainTex = Buffer.from(files['paper/main.tex'] as Uint8Array).toString('utf-8');
    expect(mainTex).toContain('\\documentclass[12pt,onecolumn]{revtex4-2}');
    expect(mainTex).toContain('\\bibliography{references_generated,references_manual}');
    expect(mainTex).not.toContain('hep://');

    const genBib = Buffer.from(files['paper/references_generated.bib'] as Uint8Array).toString('utf-8');
    expect(genBib).toContain('@misc{Doe:2020ab');

    // The scaffold is also materialized on disk for local workflows.
    const paperDir = String(payload.summary?.paper_dir ?? '');
    expect(paperDir).toContain(`/runs/${run.run_id}/paper`);
    expect(fs.existsSync(path.join(paperDir, 'main.tex'))).toBe(true);
    expect(fs.existsSync(path.join(paperDir, 'paper_manifest.json'))).toBe(true);
  });

  it('supports versioned paper output and emits a cross-version diff for v2+', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'M3 paper scaffold (versioned)', description: 'm3' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_master.bib'),
      [
        '@misc{Doe:2020ab,',
        '  title = {Demo Reference},',
        '  author = {Doe, John},',
        '  year = {2020}',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_integrated.tex'),
      [
        '\\section{Introduction}',
        'Version one content with \\cite{Doe:2020ab}.',
        '',
      ].join('\n'),
      'utf-8'
    );

    const v1Res = await handleToolCall('hep_export_paper_scaffold', {
      _confirm: true,
      run_id: run.run_id,
      version: 1,
      overwrite: true,
    });
    expect(v1Res.isError).not.toBe(true);

    const v1Payload = JSON.parse(v1Res.content[0].text) as {
      summary?: { paper_dir?: string };
    };
    const v1PaperDir = String(v1Payload.summary?.paper_dir ?? '');
    expect(v1PaperDir).toContain(`/runs/${run.run_id}/paper/v1`);
    expect(fs.existsSync(path.join(v1PaperDir, 'changes_v1_to_v2.diff'))).toBe(false);

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_integrated.tex'),
      [
        '\\section{Introduction}',
        'Version two content with updated wording and \\cite{Doe:2020ab}.',
        '',
      ].join('\n'),
      'utf-8'
    );

    const v2Res = await handleToolCall('hep_export_paper_scaffold', {
      _confirm: true,
      run_id: run.run_id,
      version: 2,
      overwrite: true,
    });
    expect(v2Res.isError).not.toBe(true);

    const v2Payload = JSON.parse(v2Res.content[0].text) as {
      summary?: { paper_dir?: string };
      artifacts: Array<{ name: string; uri: string }>;
    };

    const v2PaperDir = String(v2Payload.summary?.paper_dir ?? '');
    expect(v2PaperDir).toContain(`/runs/${run.run_id}/paper/v2`);

    const diffPath = path.join(v2PaperDir, 'changes_v1_to_v2.diff');
    expect(fs.existsSync(diffPath)).toBe(true);
    const diffText = fs.readFileSync(diffPath, 'utf-8');
    expect(diffText).toContain('--- paper/v1/paper_manifest.json');
    expect(diffText).toContain('+++ paper/v2/paper_manifest.json');

    const manifestUri = v2Payload.artifacts.find(a => a.name === 'paper_manifest.json')?.uri;
    expect(manifestUri).toBeTruthy();
    const paperManifest = JSON.parse(String((readHepResource(manifestUri!) as any).text)) as any;
    expect(paperManifest.schemaVersion).toBe(2);
    expect(paperManifest.version).toBe(2);
    expect(paperManifest.parent_version).toBe(1);
    expect(paperManifest.review_ref).toBe('paper/v2/UNVERIFIED.md');

    const zipUri = v2Payload.artifacts.find(a => a.name === 'paper_scaffold.zip')?.uri;
    expect(zipUri).toBeTruthy();
    const zipMeta = JSON.parse(String((readHepResource(zipUri!) as any).text)) as { file_path: string };
    const zipBytes = fs.readFileSync(zipMeta.file_path);
    const files = unzipSync(new Uint8Array(zipBytes));
    expect(Object.keys(files)).toContain('paper/changes_v1_to_v2.diff');
  });

  it('fails unversioned overwrite when versioned history already exists', async () => {
    const projectRes = await handleToolCall('hep_project_create', {
      name: 'M3 paper scaffold (overwrite history guard)',
      description: 'm3',
    });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_master.bib'),
      [
        '@misc{Doe:2020ab,',
        '  title = {Demo Reference},',
        '  author = {Doe, John},',
        '  year = {2020}',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_integrated.tex'),
      [
        '\\section{Introduction}',
        'Version one content with \\cite{Doe:2020ab}.',
        '',
      ].join('\n'),
      'utf-8'
    );

    const v1Res = await handleToolCall('hep_export_paper_scaffold', {
      _confirm: true,
      run_id: run.run_id,
      version: 1,
      overwrite: true,
    });
    expect(v1Res.isError).not.toBe(true);

    const unversionedOverwriteRes = await handleToolCall('hep_export_paper_scaffold', {
      _confirm: true,
      run_id: run.run_id,
      overwrite: true,
    });
    expect(unversionedOverwriteRes.isError).toBe(true);

    const err = JSON.parse(unversionedOverwriteRes.content[0].text) as {
      error?: { code?: string; message?: string };
    };
    expect(err.error?.code).toBe('INVALID_PARAMS');
    expect(err.error?.message ?? '').toContain('Refusing unversioned overwrite');
  });

  it('rewrites includegraphics hep://run artifacts to paper/figures/', async () => {
    const projectRes = await handleToolCall('hep_project_create', {
      name: 'M3 paper scaffold (includegraphics rewrite)',
      description: 'm3',
    });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'plot.pdf'),
      Buffer.from('%PDF-1.4\n% fake\n', 'utf-8')
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_integrated.tex'),
      [
        '\\section{Introduction}',
        `\\\\includegraphics{hep://runs/${run.run_id}/artifact/plot.pdf}`,
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_master.bib'), '', 'utf-8');

    const exportRes = await handleToolCall('hep_export_paper_scaffold', { _confirm: true, run_id: run.run_id });
    expect(exportRes.isError).not.toBe(true);

    const payload = JSON.parse(exportRes.content[0].text) as { artifacts: Array<{ name: string; uri: string }> };
    const zipUri = payload.artifacts.find(a => a.name === 'paper_scaffold.zip')?.uri;
    expect(zipUri).toBeTruthy();

    const zipMeta = JSON.parse(String((readHepResource(zipUri!) as any).text)) as { file_path: string };
    const zipBytes = fs.readFileSync(zipMeta.file_path);
    const files = unzipSync(new Uint8Array(zipBytes));

    expect(Object.keys(files)).toContain('paper/figures/plot.pdf');
    const sectionKey = Object.keys(files).find(k => k.startsWith('paper/sections/section_001_'));
    expect(sectionKey).toBeTruthy();
    const sectionTex = Buffer.from(files[sectionKey!] as Uint8Array).toString('utf-8');
    expect(sectionTex).toContain('\\\\includegraphics{figures/plot.pdf}');
    expect(sectionTex).not.toContain('hep://');
  });

  it('fails fast when a cited key is missing from bib sources', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'M3 paper scaffold (missing bib)', description: 'm3' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_integrated.tex'), '\\section{Intro}\\nCite \\cite{Missing:2020}.\\n', 'utf-8');
    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_master.bib'), '', 'utf-8');

    const exportRes = await handleToolCall('hep_export_paper_scaffold', { _confirm: true, run_id: run.run_id });
    expect(exportRes.isError).toBe(true);

    const payload = JSON.parse(exportRes.content[0]?.text ?? '{}') as { error?: { code?: string } };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
  });

  it('fails fast when output directory exists (unless overwrite=true)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'M3 paper scaffold (overwrite)', description: 'm3' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_integrated.tex'), '\\section{Intro}\\n', 'utf-8');
    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_master.bib'), '', 'utf-8');

    // First run succeeds only if no cites are present.
    const first = await handleToolCall('hep_export_paper_scaffold', { _confirm: true, run_id: run.run_id, overwrite: true });
    expect(first.isError).not.toBe(true);

    const second = await handleToolCall('hep_export_paper_scaffold', { _confirm: true, run_id: run.run_id });
    expect(second.isError).toBe(true);
  });
});
