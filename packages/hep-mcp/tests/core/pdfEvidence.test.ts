import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { handleToolCall } from '../../src/tools/index.js';
import { readHepResource } from '../../src/core/resources.js';

async function makeSmallPdfBytes(): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const page1 = pdfDoc.addPage([320, 420]);
  page1.drawText('Hello PDF page 1', { x: 24, y: 380, size: 14, font });

  const page2 = pdfDoc.addPage([320, 420]);
  page2.drawText('Hello PDF page 2', { x: 24, y: 380, size: 14, font });

  return await pdfDoc.save();
}

async function makeHepStylePdfBytes(): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // A4 in points
  const page = pdfDoc.addPage([595.28, 841.89]);

  page.drawText('A Minimal HEP-style PDF Fixture', { x: 50, y: 800, size: 16, font });
  page.drawText('We include a display equation, a figure box, and a table sketch.', { x: 50, y: 775, size: 11, font });

  // "Display equation" (as text; real LaTeX is not required for M9 DoD)
  page.drawText('Equation (1):  E = m c^2', { x: 90, y: 680, size: 14, font });

  // Figure placeholder + caption
  page.drawRectangle({
    x: 70,
    y: 520,
    width: 460,
    height: 120,
    borderColor: rgb(0, 0, 0),
    borderWidth: 1,
  });
  page.drawText('Figure 1: Placeholder figure box.', { x: 70, y: 500, size: 11, font });

  // Table sketch + caption
  page.drawRectangle({
    x: 70,
    y: 340,
    width: 460,
    height: 120,
    borderColor: rgb(0, 0, 0),
    borderWidth: 1,
  });
  for (let i = 1; i <= 3; i++) {
    page.drawLine({
      start: { x: 70 + i * (460 / 4), y: 340 },
      end: { x: 70 + i * (460 / 4), y: 460 },
      thickness: 1,
      color: rgb(0, 0, 0),
    });
  }
  for (let j = 1; j <= 2; j++) {
    page.drawLine({
      start: { x: 70, y: 340 + j * (120 / 3) },
      end: { x: 530, y: 340 + j * (120 / 3) },
      thickness: 1,
      color: rgb(0, 0, 0),
    });
  }
  page.drawText('Table 1: Placeholder table grid.', { x: 70, y: 320, size: 11, font });

  return await pdfDoc.save();
}

function writeTempFile(bytes: Uint8Array, ext: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-m9-'));
  const p = path.join(dir, `fixture${ext}`);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}

function assertPngResource(uri: string): void {
  const res = readHepResource(uri) as any;
  expect(res).toBeTruthy();
  expect(typeof res.text).toBe('string');
  const meta = JSON.parse(String(res.text)) as { file_path: string; size: number; mimeType: string };
  expect(meta.mimeType).toBe('image/png');
  expect(meta.size).toBeGreaterThan(0);
  const buf = fs.readFileSync(meta.file_path);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect(Array.from(buf.subarray(0, 8))).toEqual(sig);
}

describe('vNext M9: hep_run_build_pdf_evidence (PDF→Evidence)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;
  const tempDirs: string[] = [];

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
    for (const d of tempDirs) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('text mode extracts stable page text', async () => {
    const pdfPath = writeTempFile(await makeSmallPdfBytes(), '.pdf');
    tempDirs.push(path.dirname(pdfPath));

    const projectRes = await handleToolCall('hep_project_create', { name: 'M9 text', description: 'm9' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const res = await handleToolCall('hep_run_build_pdf_evidence', {
      run_id: run.run_id,
      pdf_path: pdfPath,
      mode: 'text',
      max_pages: 5,
      output_prefix: 'm9_small',
    });

    expect(res.isError).not.toBe(true);
    const payload = JSON.parse(res.content[0].text) as {
      catalog_uri: string;
      summary: { processed_pages: number };
    };

    const catalogText = String((readHepResource(payload.catalog_uri) as any).text);
    const items = catalogText
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line)) as Array<{ type: string; locator?: { page?: number }; text?: string }>;

    const pages = items.filter(i => i.type === 'pdf_page');
    const regions = items.filter(i => i.type === 'pdf_region');
    expect(regions.length).toBe(0);
    expect(pages.length).toBe(payload.summary.processed_pages);

    const p1 = pages.find(p => p.locator?.page === 1)?.text ?? '';
    const p2 = pages.find(p => p.locator?.page === 2)?.text ?? '';
    expect(p1).toContain('Hello PDF page 1');
    expect(p2).toContain('Hello PDF page 2');
  });

  it('records a diagnostics artifact when a budget (max_pages) truncates processing', async () => {
    const pdfPath = writeTempFile(await makeSmallPdfBytes(), '.pdf');
    tempDirs.push(path.dirname(pdfPath));

    const projectRes = await handleToolCall('hep_project_create', { name: 'M9 budget', description: 'm9' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const res = await handleToolCall('hep_run_build_pdf_evidence', {
      run_id: run.run_id,
      pdf_path: pdfPath,
      mode: 'text',
      max_pages: 1,
      output_prefix: 'm9_budget',
    });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      summary: { total_pages: number; processed_pages: number };
    };
    expect(payload.summary.total_pages).toBe(2);
    expect(payload.summary.processed_pages).toBe(1);

    const diagUri = payload.artifacts.find(a =>
      a.uri.startsWith('hep://runs/')
      && a.name.includes('_pdf_evidence_diagnostics.json')
    )?.uri;
    expect(diagUri).toBeTruthy();

    const diag = JSON.parse(String((readHepResource(diagUri!) as any).text)) as {
      run_id: string;
      step: string;
      budgets: Array<{ key: string; source?: { kind?: string } }>;
      hits: Array<{ key: string; limit: number; observed: number; action: string }>;
      warnings: Array<{ code: string; data?: { key?: string } }>;
      artifacts: { project_diagnostics_uri: string };
    };
    expect(diag.run_id).toBe(run.run_id);
    expect(diag.step).toBe('pdf_evidence');

    const hit = diag.hits.find(h => h.key === 'pdf.max_pages');
    expect(hit).toBeTruthy();
    expect(hit!.action).toBe('truncate');
    expect(hit!.limit).toBe(1);
    expect(hit!.observed).toBe(2);
    expect(diag.warnings.some(w => w.code === 'budget_hit' && w.data?.key === 'pdf.max_pages')).toBe(true);
    expect(diag.budgets.find(b => b.key === 'pdf.max_pages')?.source?.kind).toBe('tool_args');

    const projectDiag = JSON.parse(String((readHepResource(diag.artifacts.project_diagnostics_uri) as any).text)) as {
      run_id: string;
      step: string;
    };
    expect(projectDiag.run_id).toBe(run.run_id);
    expect(projectDiag.step).toBe('pdf_evidence');
  });

  it('visual mode writes at least one page render and one region snippet', async () => {
    const pdfPath = writeTempFile(await makeHepStylePdfBytes(), '.pdf');
    tempDirs.push(path.dirname(pdfPath));

    const projectRes = await handleToolCall('hep_project_create', { name: 'M9 visual', description: 'm9' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const res = await handleToolCall('hep_run_build_pdf_evidence', {
      run_id: run.run_id,
      pdf_path: pdfPath,
      mode: 'visual',
      max_pages: 1,
      render_dpi: 72,
      output_prefix: 'm9_hep',
    });

    expect(res.isError).not.toBe(true);
    const payload = JSON.parse(res.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      catalog_uri: string;
    };

    const pagePng = payload.artifacts.find(a => a.name.includes('_page_') && a.name.endsWith('.png'));
    const regionPng = payload.artifacts.find(a => a.name.includes('_region_') && a.name.endsWith('.png'));
    expect(pagePng?.uri).toBeTruthy();
    expect(regionPng?.uri).toBeTruthy();

    assertPngResource(pagePng!.uri);
    assertPngResource(regionPng!.uri);

    const catalogText = String((readHepResource(payload.catalog_uri) as any).text);
    const items = catalogText
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line)) as Array<{ type: string }>;
    expect(items.some(i => i.type === 'pdf_region')).toBe(true);
  });

  it('zotero_attachment_key loads PDF via Local API and uses .zotero-ft-cache when available', async () => {
    const pdfPath = writeTempFile(await makeSmallPdfBytes(), '.pdf');
    tempDirs.push(path.dirname(pdfPath));

    const zoteroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-data-'));
    tempDirs.push(zoteroDir);

    const attachmentKey = 'ATTACH123';
    const cacheDir = path.join(zoteroDir, 'storage', attachmentKey);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, '.zotero-ft-cache'), 'FT page 1\\fFT page 2\\n', 'utf-8');

    const prevZoteroBaseUrl = process.env.ZOTERO_BASE_URL;
    const prevZoteroDataDir = process.env.ZOTERO_DATA_DIR;
    process.env.ZOTERO_BASE_URL = 'http://127.0.0.1:23119';
    process.env.ZOTERO_DATA_DIR = zoteroDir;

    const pdfUrl = pathToFileURL(pdfPath).toString();
    const originalFetch = globalThis.fetch;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const url = typeof input === 'string' ? input : input?.url;
        const u = new URL(url);
        if (u.pathname === `/api/users/0/items/${attachmentKey}/file`) {
          return new Response('', { status: 302, headers: { location: pdfUrl } });
        }
        return new Response('not found', { status: 404 });
      }) as any
    );

    try {
      const projectRes = await handleToolCall('hep_project_create', { name: 'M9 zotero', description: 'm9' });
      const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
      const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
      const run = JSON.parse(runRes.content[0].text) as { run_id: string };

      const res = await handleToolCall('hep_run_build_pdf_evidence', {
        run_id: run.run_id,
        zotero_attachment_key: attachmentKey,
        mode: 'text',
        max_pages: 5,
        output_prefix: 'm9_zotero',
      });
      expect(res.isError).not.toBe(true);

      const payload = JSON.parse(res.content[0].text) as {
        catalog_uri: string;
        summary: { used_zotero_fulltext: boolean; processed_pages: number };
      };
      expect(payload.summary.used_zotero_fulltext).toBe(true);

      const catalogText = String((readHepResource(payload.catalog_uri) as any).text);
      const items = catalogText
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line)) as Array<{ type: string; locator?: { page?: number }; text?: string }>;

      const pages = items.filter(i => i.type === 'pdf_page');
      expect(pages.length).toBe(payload.summary.processed_pages);

      const p1 = pages.find(p => p.locator?.page === 1)?.text ?? '';
      const p2 = pages.find(p => p.locator?.page === 2)?.text ?? '';
      expect(p1).toContain('FT page 1');
      expect(p2).toContain('FT page 2');
    } finally {
      vi.unstubAllGlobals();
      if (originalFetch) globalThis.fetch = originalFetch;

      if (prevZoteroBaseUrl !== undefined) process.env.ZOTERO_BASE_URL = prevZoteroBaseUrl;
      else delete process.env.ZOTERO_BASE_URL;

      if (prevZoteroDataDir !== undefined) process.env.ZOTERO_DATA_DIR = prevZoteroDataDir;
      else delete process.env.ZOTERO_DATA_DIR;
    }
  });

  it('docling_json_path enables docling-based region proposals (optional backend)', async () => {
    const pdfPath = writeTempFile(await makeHepStylePdfBytes(), '.pdf');
    tempDirs.push(path.dirname(pdfPath));

    const doclingPath = path.join(path.dirname(pdfPath), 'docling.min.json');
    fs.writeFileSync(
      doclingPath,
      JSON.stringify({
        texts: [
          {
            label: 'formula',
            text: 'E = m c^2',
            prov: [
              {
                page_no: 1,
                bbox: { l: 90, t: 710, r: 520, b: 650, coord_origin: 'BOTTOMLEFT' },
              },
            ],
          },
        ],
        tables: [],
        pictures: [],
      }),
      'utf-8'
    );

    const projectRes = await handleToolCall('hep_project_create', { name: 'M9 docling', description: 'm9' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const res = await handleToolCall('hep_run_build_pdf_evidence', {
      run_id: run.run_id,
      pdf_path: pdfPath,
      docling_json_path: doclingPath,
      mode: 'visual',
      max_pages: 1,
      render_dpi: 72,
      output_prefix: 'm9_docling',
    });

    expect(res.isError).not.toBe(true);
    const payload = JSON.parse(res.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
    };

    const region = payload.artifacts.find(a => a.name.includes('_region_formula_') && a.name.endsWith('.png'));
    expect(region?.uri).toBeTruthy();
    assertPngResource(region!.uri);
  });
});
