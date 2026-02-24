import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { unzipSync } from 'fflate';

import { handleToolCall } from '../../src/tools/index.js';
import { readHepResource } from '../../src/vnext/resources.js';
import { getRunArtifactPath } from '../../src/vnext/paths.js';

function readFixtureJson<T>(fileName: string): T {
  const fixtureDir = new URL('../fixtures/vnext/m7/', import.meta.url);
  const p = new URL(fileName, fixtureDir);
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

describe('vNext M10: hep_export_project (research_pack.zip + notebooklm_pack)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;
  let pdgDataDir: string;
  let originalPdgDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-'));
    process.env.HEP_DATA_DIR = dataDir;

    originalPdgDataDirEnv = process.env.PDG_DATA_DIR;
    pdgDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-data-'));
    process.env.PDG_DATA_DIR = pdgDataDir;
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

    if (originalPdgDataDirEnv !== undefined) {
      process.env.PDG_DATA_DIR = originalPdgDataDirEnv;
    } else {
      delete process.env.PDG_DATA_DIR;
    }
    if (fs.existsSync(pdgDataDir)) {
      fs.rmSync(pdgDataDir, { recursive: true, force: true });
    }
  });

  it('exports master.bib/report.(tex|md) + research_pack.zip with notebooklm_pack splitting', async () => {
    const draft = readFixtureJson<any>('section_draft.min.json');
    const allowed = readFixtureJson<string[]>('allowed_citations.min.json');
    const citeMapping = readFixtureJson<any>('cite_mapping.min.json');

    const projectRes = await handleToolCall('hep_project_create', { name: 'M10 export', description: 'm10' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    // Produce rendered_latex.tex (input for exporter)
    const renderRes = await handleToolCall('hep_render_latex', {
      run_id: run.run_id,
      draft,
      allowed_citations: allowed,
      cite_mapping: citeMapping,
    });
    expect(renderRes.isError).not.toBe(true);

    // P0: exporter requires real bibtex (no placeholder-only master.bib).
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

    // Fake evidence catalog to exercise notebooklm digest chunking (M10 DoD).
    const fakeCatalogName = 'm9_fake_evidence_catalog.jsonl';
    const fakeLines: string[] = [];
    for (let i = 1; i <= 12; i++) {
      fakeLines.push(JSON.stringify({
        version: 1,
        evidence_id: `ev_fake_${i}`,
        run_id: run.run_id,
        project_id: project.project_id,
        type: 'pdf_page',
        locator: { kind: 'pdf', page: i },
        text: `This is a long-ish evidence text block for chunking test ${i}. `.repeat(8).trim(),
      }));
    }
    fs.writeFileSync(getRunArtifactPath(run.run_id, fakeCatalogName), fakeLines.join('\n') + '\n', 'utf-8');

    // P1.2: optional per-source status used for coverage report sources success rate.
    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_evidence_source_status.json'),
      JSON.stringify({
        version: 1,
        generated_at: new Date().toISOString(),
        run_id: run.run_id,
        sources: [
          { source_kind: 'latex', identifier: 'inspire:627760', status: 'success' },
          { source_kind: 'latex', identifier: 'inspire:1258603', status: 'failed', error_code: 'ARXIV_NOT_FOUND' },
        ],
        summary: { total: 2, succeeded: 1, failed: 1, skipped: 0, fallback_count: 0 },
      }, null, 2),
      'utf-8'
    );

    const exportRes = await handleToolCall('hep_export_project', {
      run_id: run.run_id,
      include_evidence_digests: true,
      max_chars_per_notebooklm_file: 600,
    });
    expect(exportRes.isError).not.toBe(true);

    const payload = JSON.parse(exportRes.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      summary: { notebooklm_files: number };
    };

    const getUri = (name: string): string | undefined => payload.artifacts.find(a => a.name === name)?.uri;

    expect(getUri('master.bib')).toBeTruthy();
    expect(getUri('writing_master.bib')).toBeTruthy();
    expect(getUri('report.tex')).toBeTruthy();
    expect(getUri('report.md')).toBeTruthy();
    expect(getUri('rendered_latex_verification.json')).toBeTruthy();
    expect(getUri('coverage_report.json')).toBeTruthy();
    expect(getUri('run_manifest.json')).toBeTruthy();
    expect(getUri('research_pack.zip')).toBeTruthy();
    expect(getUri('notebooklm_pack_report.md')).toBeTruthy();
    expect(getUri('notebooklm_pack_master.bib')).toBeTruthy();
    expect(getUri('notebooklm_pack_run_manifest.json')).toBeTruthy();

    const digest1 = getUri('notebooklm_pack_evidence_digest_001.md');
    const digest2 = getUri('notebooklm_pack_evidence_digest_002.md');
    expect(digest1).toBeTruthy();
    expect(digest2).toBeTruthy();
    expect(payload.summary.notebooklm_files).toBeGreaterThanOrEqual(3);

    const reportTex = String((readHepResource(getUri('report.tex')!) as any).text);
    expect(reportTex).toContain('\\cite{Doe:2020ab}');
    expect(reportTex).toContain('\\bibliography{master}');

    const masterBib = String((readHepResource(getUri('master.bib')!) as any).text);
    expect(masterBib).toContain('@misc{Doe:2020ab');
    expect(masterBib).not.toContain('Placeholder reference');

    const coverage = JSON.parse(String((readHepResource(getUri('coverage_report.json')!) as any).text)) as any;
    expect(coverage.citations?.verification_artifact).toBe('rendered_latex_verification.json');
    expect(coverage.citations?.pass).toBe(true);
    expect(coverage.sources?.source_status_artifact).toBe('writing_evidence_source_status.json');
    expect(coverage.sources?.attempted).toBe(2);
    expect(coverage.sources?.succeeded).toBe(1);
    expect(coverage.sources?.failed).toBe(1);
    expect(coverage.sources?.failed_identifiers).toEqual(['inspire:1258603']);
    expect(coverage.sources?.success_rate).toBe('50.0%');
    expect(String(coverage.human_summary)).toContain('Evidence 1/2 sources (50.0%');

    const runManifestText = String((readHepResource(getUri('run_manifest.json')!) as any).text);
    const notebookRunManifestText = String((readHepResource(getUri('notebooklm_pack_run_manifest.json')!) as any).text);
    expect(runManifestText).toBe(notebookRunManifestText);
    const runManifest = JSON.parse(runManifestText) as { steps?: Array<{ step?: string; status?: string }> };
    expect(runManifest.steps?.some(s => s.step === 'export_project' && s.status === 'done')).toBe(true);

    // Zip is a binary artifact: hep:// returns metadata JSON by default (no base64 payload).
    const zipMeta = JSON.parse(String((readHepResource(getUri('research_pack.zip')!) as any).text)) as {
      file_path: string;
      size: number;
      sha256: string;
      mimeType: string;
    };
    expect(zipMeta.mimeType).toBe('application/zip');
    expect(zipMeta.size).toBeGreaterThan(0);
    // Zip contains a real notebooklm_pack/ directory with split evidence digests.
    const zipBytes = fs.readFileSync(zipMeta.file_path);
    expect(zipBytes.subarray(0, 2).toString('utf-8')).toBe('PK'); // ZIP signature

    const files = unzipSync(new Uint8Array(zipBytes));
    expect(Object.keys(files)).toContain('master.bib');
    expect(Object.keys(files)).toContain('report.tex');
    expect(Object.keys(files)).toContain('report.md');
    expect(Object.keys(files)).toContain('rendered_latex_verification.json');
    expect(Object.keys(files)).toContain('coverage_report.json');
    expect(Object.keys(files)).toContain('writing_master.bib');
    expect(Object.keys(files)).toContain('run_manifest.json');
    expect(Object.keys(files)).toContain('export_manifest.json');
    expect(Object.keys(files)).toContain('notebooklm_pack/report.md');
    expect(Object.keys(files)).toContain('notebooklm_pack/master.bib');
    expect(Object.keys(files)).toContain('notebooklm_pack/run_manifest.json');
    expect(Object.keys(files)).toContain('notebooklm_pack/evidence_digest_001.md');

    const zipRunManifestText = Buffer.from(files['run_manifest.json'] as Uint8Array).toString('utf-8');
    const zipRunManifest = JSON.parse(zipRunManifestText) as { steps?: Array<{ step?: string; status?: string }> };
    expect(zipRunManifest.steps?.some(s => s.step === 'export_project' && s.status === 'done')).toBe(true);
  });

  it('embeds paper bundle in research_pack.zip when include_paper_bundle=true', async () => {
    const draft = readFixtureJson<any>('section_draft.min.json');
    const allowed = readFixtureJson<string[]>('allowed_citations.min.json');
    const citeMapping = readFixtureJson<any>('cite_mapping.min.json');

    const projectRes = await handleToolCall('hep_project_create', { name: 'M10 export (paper bundle)', description: 'm10' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const renderRes = await handleToolCall('hep_render_latex', {
      run_id: run.run_id,
      draft,
      allowed_citations: allowed,
      cite_mapping: citeMapping,
    });
    expect(renderRes.isError).not.toBe(true);

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

    // Minimal paper scaffold (no cites needed here).
    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_integrated.tex'), '\\section{Intro}\\nHello.\\n', 'utf-8');
    const scaffoldRes = await handleToolCall('hep_export_paper_scaffold', { run_id: run.run_id, overwrite: true });
    expect(scaffoldRes.isError).not.toBe(true);

    const paperDir = path.join(dataDir, 'runs', run.run_id, 'paper');
    fs.writeFileSync(path.join(paperDir, 'main.pdf'), Buffer.from('%PDF-1.4\n% demo\n', 'utf-8'));
    const importRes = await handleToolCall('hep_import_paper_bundle', { run_id: run.run_id });
    expect(importRes.isError).not.toBe(true);

    const exportRes = await handleToolCall('hep_export_project', {
      run_id: run.run_id,
      include_paper_bundle: true,
      include_evidence_digests: false,
    });
    expect(exportRes.isError).not.toBe(true);

    const payload = JSON.parse(exportRes.content[0].text) as { artifacts: Array<{ name: string; uri: string }> };
    const zipUri = payload.artifacts.find(a => a.name === 'research_pack.zip')?.uri;
    expect(zipUri).toBeTruthy();

    const zipMeta = JSON.parse(String((readHepResource(zipUri!) as any).text)) as { file_path: string };
    const zipBytes = fs.readFileSync(zipMeta.file_path);
    const files = unzipSync(new Uint8Array(zipBytes));
    expect(Object.keys(files)).toContain('paper/main.tex');
    expect(Object.keys(files)).toContain('paper/paper_manifest.json');
    expect(Object.keys(files)).toContain('paper/main.pdf');
    expect(Object.keys(files)).toContain('paper/paper_bundle_manifest.json');
  });

  it('produces coverage_report without sources section when source_status artifact is missing', async () => {
    const draft = readFixtureJson<any>('section_draft.min.json');
    const allowed = readFixtureJson<string[]>('allowed_citations.min.json');
    const citeMapping = readFixtureJson<any>('cite_mapping.min.json');

    const projectRes = await handleToolCall('hep_project_create', { name: 'M10 export (no source status)', description: 'm10' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const renderRes = await handleToolCall('hep_render_latex', {
      run_id: run.run_id,
      draft,
      allowed_citations: allowed,
      cite_mapping: citeMapping,
    });
    expect(renderRes.isError).not.toBe(true);

    // Exporter requires real bibtex (no placeholder-only master.bib).
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

    const sourceStatusPath = getRunArtifactPath(run.run_id, 'writing_evidence_source_status.json');
    if (fs.existsSync(sourceStatusPath)) fs.rmSync(sourceStatusPath);

    const exportRes = await handleToolCall('hep_export_project', {
      run_id: run.run_id,
      include_evidence_digests: false,
    });
    expect(exportRes.isError).not.toBe(true);

    const payload = JSON.parse(exportRes.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
    };

    const coverageUri = payload.artifacts.find(a => a.name === 'coverage_report.json')?.uri;
    expect(coverageUri).toBeTruthy();

    const coverage = JSON.parse(String((readHepResource(coverageUri!) as any).text)) as any;
    expect(coverage.sources).toBeUndefined();
    expect(String(coverage.human_summary)).toContain('Evidence complete/unknown');
  });

  it('includes PDG artifacts in research_pack.zip when enabled', async () => {
    const pdgArtifactsDir = path.join(pdgDataDir, 'artifacts');
    fs.mkdirSync(pdgArtifactsDir, { recursive: true });
    fs.writeFileSync(path.join(pdgArtifactsDir, 'pdg_sample.json'), JSON.stringify({ hello: 'pdg' }, null, 2), 'utf-8');
    fs.writeFileSync(path.join(pdgArtifactsDir, 'pdg_sample.bin'), Buffer.from([0, 1, 2, 3]));

    const draft = readFixtureJson<any>('section_draft.min.json');
    const allowed = readFixtureJson<string[]>('allowed_citations.min.json');
    const citeMapping = readFixtureJson<any>('cite_mapping.min.json');

    const projectRes = await handleToolCall('hep_project_create', { name: 'M10 export (pdg)', description: 'm10' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const renderRes = await handleToolCall('hep_render_latex', {
      run_id: run.run_id,
      draft,
      allowed_citations: allowed,
      cite_mapping: citeMapping,
    });
    expect(renderRes.isError).not.toBe(true);

    // P0: exporter requires real bibtex (no placeholder-only master.bib).
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

    const exportRes = await handleToolCall('hep_export_project', {
      run_id: run.run_id,
      include_evidence_digests: false,
      include_pdg_artifacts: true,
    });
    expect(exportRes.isError).not.toBe(true);

    const payload = JSON.parse(exportRes.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
    };
    const zipUri = payload.artifacts.find(a => a.name === 'research_pack.zip')?.uri;
    expect(zipUri).toBeTruthy();

    const zipMeta = JSON.parse(String((readHepResource(zipUri!) as any).text)) as {
      file_path: string;
      size: number;
      sha256: string;
      mimeType: string;
    };
    expect(zipMeta.mimeType).toBe('application/zip');
    expect(zipMeta.size).toBeGreaterThan(0);

    const zipBytes = fs.readFileSync(zipMeta.file_path);
    const files = unzipSync(new Uint8Array(zipBytes));

    expect(Object.keys(files)).toContain('pdg/artifacts/pdg_sample.json');
    expect(Object.keys(files)).toContain('pdg/artifacts/pdg_sample.bin');

    const jsonText = Buffer.from(files['pdg/artifacts/pdg_sample.json'] as Uint8Array).toString('utf-8');
    expect(jsonText).toContain('"hello": "pdg"');
    expect(Array.from(files['pdg/artifacts/pdg_sample.bin'] as Uint8Array)).toEqual([0, 1, 2, 3]);

    const exportManifestText = Buffer.from(files['export_manifest.json'] as Uint8Array).toString('utf-8');
    const exportManifest = JSON.parse(exportManifestText) as any;
    expect(exportManifest.files?.pdg_artifacts).toContain('pdg/artifacts/pdg_sample.json');
    expect(exportManifest.pdg_artifacts?.artifacts_dir_exists).toBe(true);
    expect(exportManifest.pdg_artifacts?.files?.some((f: any) => f?.zip_path === 'pdg/artifacts/pdg_sample.bin')).toBe(true);
  });
});
