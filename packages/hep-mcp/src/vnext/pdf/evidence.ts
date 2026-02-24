import * as fs from 'fs';
import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { createCanvas } from '@napi-rs/canvas';
import {
  HEP_RUN_BUILD_PDF_EVIDENCE,
  invalidParams,
} from '@autoresearch/shared';

import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { assertSafePathSegment, getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';
import { BudgetTrackerV1, writeRunStepDiagnosticsArtifact } from '../diagnostics.js';
import { normalizeTextPreserveUnits } from '../../utils/textNormalization.js';
import { zoteroGetBinary } from '@autoresearch/zotero-mcp/shared/zotero';

export type PdfExtractMode = 'text' | 'visual' | 'visual+ocr';

type DoclingCoordOrigin = 'BOTTOMLEFT' | 'TOPLEFT' | string;

interface DoclingBBox {
  l: number;
  t: number;
  r: number;
  b: number;
  coord_origin?: DoclingCoordOrigin;
}

interface DoclingProv {
  page_no: number;
  bbox: DoclingBBox;
}

type DoclingRegionLabel = 'formula' | 'table' | 'picture';

interface DoclingRawRegion {
  label: DoclingRegionLabel;
  page_no: number;
  bbox: DoclingBBox;
  text?: string;
}

export interface PdfBBoxNormalizedV1 {
  coord_origin: 'top_left';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PdfLocatorV1 {
  kind: 'pdf';
  page: number;
  bbox?: PdfBBoxNormalizedV1;
}

export type PdfEvidenceType = 'pdf_page' | 'pdf_region';

export interface PdfEvidenceCatalogItemV1 {
  version: 1;
  evidence_id: string;
  run_id: string;
  project_id: string;
  type: PdfEvidenceType;
  locator: PdfLocatorV1;
  text: string;
  normalized_text?: string;
  meta?: Record<string, unknown>;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256HexString(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeText(text: string): string {
  return normalizeTextPreserveUnits(text);
}

function buildEvidenceId(params: {
  runId: string;
  type: PdfEvidenceType;
  locator: PdfLocatorV1;
  text: string;
}): string {
  const material = JSON.stringify({
    run_id: params.runId,
    type: params.type,
    locator: params.locator,
    text_preview: params.text.slice(0, 200),
  });
  const hash = sha256HexString(material).slice(0, 16);
  return `ev_${params.runId}_${params.type}_${hash}`;
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

async function loadPdfjs(): Promise<any> {
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return (mod as any).default ?? mod;
}

function resolvePdfjsStandardFontDataUrl(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('pdfjs-dist/package.json');
    const fontsDir = path.join(path.dirname(pkgPath), 'standard_fonts/');
    return fontsDir;
  } catch {
    return undefined;
  }
}

async function extractPdfjsTextFromPage(page: any): Promise<string> {
  const textContent = await page.getTextContent();
  const items = Array.isArray(textContent?.items) ? textContent.items : [];
  const parts = items
    .flatMap((it: any) => (typeof it?.str === 'string' ? [it.str] : []))
    .map((s: string) => String(s).trim())
    .filter(Boolean);
  return parts.join(' ');
}

function isZoteroIntegrationEnabled(): boolean {
  const raw = process.env.HEP_ENABLE_ZOTERO;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === '') return true;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  throw invalidParams('Invalid HEP_ENABLE_ZOTERO (expected 0/1/true/false/yes/no/on/off)', {
    raw,
    normalized: v,
  });
}

function resolveZoteroDataDir(): string {
  const raw = process.env.ZOTERO_DATA_DIR;
  if (!raw || !raw.trim()) {
    return path.join(os.homedir(), 'Zotero');
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  if (trimmed === '~') {
    return os.homedir();
  }
  return trimmed;
}

function tryParseZoteroFulltextContent(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { status?: unknown; content?: unknown; text?: unknown };
  if (p.status === 'not_indexed') return null;
  if (typeof p.content === 'string') return p.content;
  if (typeof p.text === 'string') return p.text;
  return null;
}

function splitFulltextToPages(content: string): string[] {
  // Zotero fulltext may encode page breaks as form-feed (`\f`) or the literal sequence `\\f`.
  const rawPages = content.split(/\f|\\f/);
  return rawPages.map(p => p.replace(/\s+/g, ' ').trim());
}

function resolveZoteroFulltextCachePath(attachmentKey: string): string {
  assertSafePathSegment(attachmentKey, 'zotero_attachment_key');
  return path.join(resolveZoteroDataDir(), 'storage', attachmentKey, '.zotero-ft-cache');
}

function tryReadTextFile(p: string): string | null {
  try {
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, 'utf-8');
    return content && content.trim().length > 0 ? content : null;
  } catch {
    return null;
  }
}

function tryLoadFulltextFromArtifact(p: string): string | null {
  const raw = tryReadTextFile(p);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    const extracted = tryParseZoteroFulltextContent(parsed);
    if (extracted) return extracted;
  } catch {
    // Not JSON; treat as plain text artifact.
    return raw;
  }

  return null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseDoclingBBox(value: unknown): DoclingBBox | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const l = toFiniteNumber(v.l);
  const t = toFiniteNumber(v.t);
  const r = toFiniteNumber(v.r);
  const b = toFiniteNumber(v.b);
  if (l === null || t === null || r === null || b === null) return null;
  const coord_origin = typeof v.coord_origin === 'string' ? (v.coord_origin as DoclingCoordOrigin) : undefined;
  return { l, t, r, b, coord_origin };
}

function parseDoclingProv(value: unknown): DoclingProv | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const pageNo = toFiniteNumber(v.page_no);
  if (pageNo === null) return null;
  const bbox = parseDoclingBBox(v.bbox);
  if (!bbox) return null;
  return { page_no: Math.trunc(pageNo), bbox };
}

function isFormulaLabel(label: unknown): boolean {
  if (typeof label !== 'string') return false;
  const s = label.toLowerCase();
  return s === 'formula' || s.includes('formula');
}

function extractDoclingTextByPage(docling: unknown, maxPages: number): Map<number, string> {
  const byPage = new Map<number, string[]>();
  if (!docling || typeof docling !== 'object') return new Map();
  const texts = (docling as any).texts;
  if (!Array.isArray(texts)) return new Map();

  for (const item of texts) {
    const text = typeof item?.text === 'string' ? item.text : '';
    const orig = typeof item?.orig === 'string' ? item.orig : '';
    const chosen = (text || orig).replace(/\s+/g, ' ').trim();
    if (!chosen) continue;

    const prov = Array.isArray(item?.prov) ? item.prov : [];
    for (const p of prov) {
      const parsed = parseDoclingProv(p);
      if (!parsed) continue;
      if (!(parsed.page_no >= 1 && parsed.page_no <= maxPages)) continue;
      const bucket = byPage.get(parsed.page_no) ?? [];
      bucket.push(chosen);
      byPage.set(parsed.page_no, bucket);
    }
  }

  const out = new Map<number, string>();
  for (const [pageNo, parts] of byPage.entries()) {
    out.set(pageNo, parts.join(' ').replace(/\s+/g, ' ').trim());
  }
  return out;
}

function extractDoclingRawRegions(docling: unknown, maxPages: number): Map<number, DoclingRawRegion[]> {
  const byPage = new Map<number, DoclingRawRegion[]>();
  if (!docling || typeof docling !== 'object') return byPage;

  const texts = (docling as any).texts;
  if (Array.isArray(texts)) {
    for (const item of texts) {
      if (!isFormulaLabel(item?.label)) continue;

      const text = typeof item?.text === 'string' ? item.text : '';
      const orig = typeof item?.orig === 'string' ? item.orig : '';
      const chosenText = (text || orig).replace(/\s+/g, ' ').trim() || undefined;

      const prov = Array.isArray(item?.prov) ? item.prov : [];
      for (const p of prov) {
        const parsed = parseDoclingProv(p);
        if (!parsed) continue;
        if (!(parsed.page_no >= 1 && parsed.page_no <= maxPages)) continue;
        const bucket = byPage.get(parsed.page_no) ?? [];
        bucket.push({ label: 'formula', page_no: parsed.page_no, bbox: parsed.bbox, text: chosenText });
        byPage.set(parsed.page_no, bucket);
      }
    }
  }

  const tables = (docling as any).tables;
  if (Array.isArray(tables)) {
    for (const item of tables) {
      const prov = Array.isArray(item?.prov) ? item.prov : [];
      for (const p of prov) {
        const parsed = parseDoclingProv(p);
        if (!parsed) continue;
        if (!(parsed.page_no >= 1 && parsed.page_no <= maxPages)) continue;
        const bucket = byPage.get(parsed.page_no) ?? [];
        bucket.push({ label: 'table', page_no: parsed.page_no, bbox: parsed.bbox });
        byPage.set(parsed.page_no, bucket);
      }
    }
  }

  const pictures = (docling as any).pictures;
  if (Array.isArray(pictures)) {
    for (const item of pictures) {
      const prov = Array.isArray(item?.prov) ? item.prov : [];
      for (const p of prov) {
        const parsed = parseDoclingProv(p);
        if (!parsed) continue;
        if (!(parsed.page_no >= 1 && parsed.page_no <= maxPages)) continue;
        const bucket = byPage.get(parsed.page_no) ?? [];
        bucket.push({ label: 'picture', page_no: parsed.page_no, bbox: parsed.bbox });
        byPage.set(parsed.page_no, bucket);
      }
    }
  }

  return byPage;
}

function doclingBBoxToNormalizedTopLeft(bbox: DoclingBBox, pageWidth: number, pageHeight: number): PdfBBoxNormalizedV1 {
  const w = pageWidth > 0 ? pageWidth : 1;
  const h = pageHeight > 0 ? pageHeight : 1;

  const x0Raw = bbox.l / w;
  const x1Raw = bbox.r / w;

  const origin = (bbox.coord_origin ?? '').toString().toLowerCase();
  const isBottomLeft = origin === 'bottomleft' || origin.includes('bottom');

  const y0Raw = isBottomLeft ? (h - bbox.t) / h : bbox.t / h;
  const y1Raw = isBottomLeft ? (h - bbox.b) / h : bbox.b / h;

  let x0 = clamp01(x0Raw);
  let x1 = clamp01(x1Raw);
  let y0 = clamp01(y0Raw);
  let y1 = clamp01(y1Raw);

  if (x0 > x1) [x0, x1] = [x1, x0];
  if (y0 > y1) [y0, y1] = [y1, y0];

  return { coord_origin: 'top_left', x0, y0, x1, y1 };
}

function writeRunTextArtifact(params: {
  runId: string;
  artifactName: string;
  content: string;
  mimeType: string;
}): RunArtifactRef {
  const artifactPath = getRunArtifactPath(params.runId, params.artifactName);
  fs.writeFileSync(artifactPath, params.content, 'utf-8');
  return {
    name: params.artifactName,
    uri: `hep://runs/${encodeURIComponent(params.runId)}/artifact/${encodeURIComponent(params.artifactName)}`,
    mimeType: params.mimeType,
  };
}

function writeRunBinaryArtifact(params: {
  runId: string;
  artifactName: string;
  bytes: Uint8Array;
  mimeType: string;
}): RunArtifactRef {
  const artifactPath = getRunArtifactPath(params.runId, params.artifactName);
  fs.writeFileSync(artifactPath, Buffer.from(params.bytes));
  return {
    name: params.artifactName,
    uri: `hep://runs/${encodeURIComponent(params.runId)}/artifact/${encodeURIComponent(params.artifactName)}`,
    mimeType: params.mimeType,
  };
}

function computeRunStatus(manifest: RunManifest): RunManifest['status'] {
  const statuses = manifest.steps.map(s => s.status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('pending') || statuses.includes('in_progress')) return 'running';
  return 'done';
}

async function startRunStep(runId: string, stepName: string): Promise<{ manifestStart: RunManifest; stepIndex: number; step: RunStep }> {
  const now = new Date().toISOString();
  const manifestStart = await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: HEP_RUN_BUILD_PDF_EVIDENCE, args: { run_id: runId } },
    update: current => {
      const step: RunStep = { step: stepName, status: 'in_progress', started_at: now };
      const next: RunManifest = {
        ...current,
        updated_at: now,
        steps: [...current.steps, step],
      };
      return { ...next, status: computeRunStatus(next) };
    },
  });
  const stepIndex = manifestStart.steps.length - 1;
  const step = manifestStart.steps[stepIndex]!;
  return { manifestStart, stepIndex, step };
}

async function finishRunStep(params: {
  runId: string;
  stepIndex: number;
  stepStart: RunStep;
  status: 'done' | 'failed';
  artifacts: RunArtifactRef[];
  notes?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await updateRunManifestAtomic({
    run_id: params.runId,
    tool: { name: HEP_RUN_BUILD_PDF_EVIDENCE, args: { run_id: params.runId } },
    update: current => {
      const idx = current.steps[params.stepIndex]?.step === params.stepStart.step
        ? params.stepIndex
        : current.steps.findIndex(s => s.step === params.stepStart.step && s.started_at === params.stepStart.started_at);
      if (idx < 0) {
        throw invalidParams('Internal: unable to locate run step for completion (fail-fast)', {
          run_id: params.runId,
          step: params.stepStart.step,
          started_at: params.stepStart.started_at ?? null,
        });
      }

      const byName = new Map<string, RunArtifactRef>();
      for (const a of current.steps[idx]?.artifacts ?? []) byName.set(a.name, a);
      for (const a of params.artifacts) byName.set(a.name, a);
      const merged = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));

      const step: RunStep = {
        ...current.steps[idx]!,
        status: params.status,
        started_at: current.steps[idx]!.started_at ?? params.stepStart.started_at,
        completed_at: now,
        artifacts: merged,
        notes: params.notes,
      };
      const next: RunManifest = {
        ...current,
        updated_at: now,
        steps: current.steps.map((s, i) => (i === idx ? step : s)),
      };
      return { ...next, status: computeRunStatus(next) };
    },
  });
}

function chooseFallbackRegionBBoxNormalized(pageWidth: number, pageHeight: number): PdfBBoxNormalizedV1 {
  // A conservative "equation-like" band around the upper-middle region.
  const x0 = 0.15;
  const x1 = 0.85;
  const y0 = 0.18;
  const y1 = 0.35;

  // Defensive against degenerate page sizes.
  if (!(pageWidth > 0 && pageHeight > 0)) {
    return { coord_origin: 'top_left', x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.3 };
  }

  return { coord_origin: 'top_left', x0, y0, x1, y1 };
}

function renderPageToCanvas(params: {
  page: any;
  scale: number;
}): { canvas: any; ctx: any; width: number; height: number; viewport: any } {
  const viewport = params.page.getViewport({ scale: params.scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  return { canvas, width, height, viewport: { ...viewport, width, height }, ctx };
}

export async function buildRunPdfEvidence(params: {
  run_id: string;
  pdf_path?: string;
  pdf_artifact_name?: string;
  zotero_attachment_key?: string;
  fulltext_artifact_name?: string;
  docling_json_path?: string;
  docling_json_artifact_name?: string;
  mode: PdfExtractMode;
  max_pages: number;
  render_dpi: number;
  output_prefix: string;
  max_regions_total?: number;
  budget_hints?: {
    max_pages_provided?: boolean;
    max_regions_total_provided?: boolean;
  };
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  catalog_uri: string;
  summary: {
    pdf_sha256: string;
    total_pages: number;
    processed_pages: number;
    regions: number;
    mode: PdfExtractMode;
    used_zotero_fulltext: boolean;
    used_docling_json: boolean;
    warnings: string[];
  };
}> {
  const runId = params.run_id;
  const run = getRun(runId);

  const { stepIndex, step } = await startRunStep(runId, 'pdf_evidence');
  const artifacts: RunArtifactRef[] = [];

  try {
    if (params.mode === 'visual+ocr') {
      throw invalidParams('visual+ocr mode is not implemented in M9 (stub only)');
    }

    const pdfBytes = await (async () => {
      if (params.zotero_attachment_key) {
        const attachmentKey = params.zotero_attachment_key.trim();
        if (!attachmentKey) throw invalidParams('zotero_attachment_key cannot be empty');
        assertSafePathSegment(attachmentKey, 'zotero_attachment_key');

        if (!isZoteroIntegrationEnabled()) {
          throw invalidParams(
            'Zotero integration is disabled (HEP_ENABLE_ZOTERO=0). Provide pdf_path or pdf_artifact_name instead.'
          );
        }

        const res = await zoteroGetBinary(`/users/0/items/${encodeURIComponent(attachmentKey)}/file`);
        if (res.kind === 'file') {
          if (!fs.existsSync(res.filePath)) {
            throw invalidParams('Zotero attachment file not found on disk', {
              zotero_attachment_key: attachmentKey,
              file_path: res.filePath,
            });
          }
          return new Uint8Array(fs.readFileSync(res.filePath));
        }
        return res.bytes;
      }
      if (params.pdf_artifact_name) {
        return new Uint8Array(fs.readFileSync(getRunArtifactPath(runId, params.pdf_artifact_name)));
      }
      if (params.pdf_path) {
        return new Uint8Array(fs.readFileSync(params.pdf_path));
      }
      throw invalidParams('Either pdf_path, pdf_artifact_name, or zotero_attachment_key is required');
    })();

    const pdfSha = sha256Hex(pdfBytes);
    const warnings: string[] = [];
    const budget = new BudgetTrackerV1();

    const doclingJson = (() => {
      const artifactName = params.docling_json_artifact_name?.trim();
      if (artifactName) {
        const p = getRunArtifactPath(runId, artifactName);
        if (fs.existsSync(p)) {
          try {
            return JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
          } catch (err) {
            warnings.push(`docling_json_parse_error:${artifactName}`);
          }
        }
      }

      const doclingPath = params.docling_json_path?.trim();
      if (doclingPath) {
        try {
          const payload = JSON.parse(fs.readFileSync(doclingPath, 'utf-8')) as unknown;

          const name = artifactName ?? `${params.output_prefix}_docling.json`;
          const copied = writeRunTextArtifact({
            runId,
            artifactName: name,
            content: JSON.stringify(payload),
            mimeType: 'application/json',
          });
          artifacts.push(copied);

          return payload;
        } catch {
          warnings.push('docling_json_load_error');
        }
      }

      return null;
    })();

    const fulltextContent = (() => {
      const explicit = params.fulltext_artifact_name?.trim();
      if (explicit) {
        const p = getRunArtifactPath(runId, explicit);
        return tryLoadFulltextFromArtifact(p);
      }

      const att = params.zotero_attachment_key?.trim();
      if (!att) return null;
      assertSafePathSegment(att, 'zotero_attachment_key');

      if (!isZoteroIntegrationEnabled()) return null;

      // Fallback: read Zotero on-disk fulltext cache (no HTTP endpoint exists).
      const cachePath = resolveZoteroFulltextCachePath(att);
      return tryReadTextFile(cachePath);
    })();

    const pagesFromFulltext = fulltextContent ? splitFulltextToPages(fulltextContent) : null;
    const usedZoteroFulltext = Boolean(pagesFromFulltext);

    const pdfjs = await loadPdfjs();
    const standardFontDataUrl = resolvePdfjsStandardFontDataUrl();
    const task = pdfjs.getDocument({
      data: pdfBytes,
      disableWorker: true,
      ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
    });
    const doc = await task.promise;
    const totalPages: number = doc.numPages;
    const maxPages = budget.resolveInt({
      key: 'pdf.max_pages',
      dimension: 'breadth',
      unit: 'pages',
      arg_path: 'max_pages',
      tool_value: params.max_pages,
      tool_value_present: params.budget_hints?.max_pages_provided ?? true,
      env_var: 'HEP_BUDGET_PDF_MAX_PAGES',
      default_value: params.max_pages,
      min: 1,
    });
    const processedPages = Math.min(totalPages, maxPages);
    if (totalPages > processedPages) {
      const msg = `PDF pages truncated at max_pages=${maxPages} (total_pages=${totalPages}).`;
      warnings.push(msg);
      budget.recordHit({
        key: 'pdf.max_pages',
        dimension: 'breadth',
        unit: 'pages',
        limit: maxPages,
        observed: totalPages,
        action: 'truncate',
        message: msg,
        data: { total_pages: totalPages, processed_pages: processedPages },
      });
    }

    const items: PdfEvidenceCatalogItemV1[] = [];
    const pageRecords: Array<{ page: number; text: string; source: string }> = [];
    const scale = params.render_dpi / 72;

    const doclingTextByPage = doclingJson
      ? extractDoclingTextByPage(doclingJson, processedPages)
      : new Map<number, string>();
    const doclingRegionsByPage = doclingJson
      ? extractDoclingRawRegions(doclingJson, processedPages)
      : new Map<number, DoclingRawRegion[]>();
    const usedDoclingJson = Boolean(doclingJson);

    const maxRegionsTotal = budget.resolveInt({
      key: 'pdf.max_regions_total',
      dimension: 'breadth',
      unit: 'regions',
      arg_path: 'max_regions_total',
      tool_value: params.max_regions_total,
      tool_value_present: params.budget_hints?.max_regions_total_provided ?? true,
      env_var: 'HEP_BUDGET_PDF_MAX_REGIONS_TOTAL',
      default_value: 25,
      min: 0,
    });
    let regionsCreated = 0;
    let regionProposalsTotal = 0;

    for (let pageNum = 1; pageNum <= processedPages; pageNum++) {
      let text = '';
      let pageTextSource: string = 'pdfjs_text';

      if (pagesFromFulltext && pageNum <= pagesFromFulltext.length) {
        text = pagesFromFulltext[pageNum - 1] ?? '';
        pageTextSource = 'zotero_fulltext';
      } else if (doclingTextByPage.has(pageNum)) {
        text = doclingTextByPage.get(pageNum) ?? '';
        pageTextSource = 'docling_json';
      }

      let page: any | null = null;
      if (pageTextSource === 'pdfjs_text' || params.mode === 'visual') {
        page = await doc.getPage(pageNum);
        if (pageTextSource === 'pdfjs_text') {
          text = await extractPdfjsTextFromPage(page);
        }
      }

      if (!text) warnings.push(`empty_text_page:${pageNum}`);

      const pageEvidence: PdfEvidenceCatalogItemV1 = {
        version: 1,
        evidence_id: 'placeholder',
        run_id: runId,
        project_id: run.project_id,
        type: 'pdf_page',
        locator: { kind: 'pdf', page: pageNum },
        text,
        normalized_text: text ? normalizeText(text) : undefined,
        meta: {
          pdf_sha256: pdfSha,
          char_count: text.length,
          source: pageTextSource,
          docling_json: usedDoclingJson ? (params.docling_json_artifact_name ?? `${params.output_prefix}_docling.json`) : undefined,
        },
      };
      pageEvidence.evidence_id = buildEvidenceId({ runId, type: 'pdf_page', locator: pageEvidence.locator, text });
      items.push(pageEvidence);
      pageRecords.push({ page: pageNum, text, source: pageTextSource });

      if (params.mode !== 'visual') continue;

      if (!page) page = await doc.getPage(pageNum);
      const { canvas, width, height, viewport, ctx } = renderPageToCanvas({ page, scale });
      const renderTask = page.render({ canvasContext: ctx, viewport });
      await renderTask.promise;

      const pagePng = canvas.toBuffer('image/png') as Buffer;
      const pageRenderName = `${params.output_prefix}_page_${pad4(pageNum)}.png`;
      const pageRenderRef = writeRunBinaryArtifact({
        runId,
        artifactName: pageRenderName,
        bytes: new Uint8Array(pagePng),
        mimeType: 'image/png',
      });
      artifacts.push(pageRenderRef);

      pageEvidence.meta = {
        ...(pageEvidence.meta ?? {}),
        page_render_uri: pageRenderRef.uri,
        page_render: { width, height, dpi: params.render_dpi },
      };

      const pageRegions = doclingRegionsByPage.get(pageNum) ?? [];
      const pageViewportPoints = page.getViewport({ scale: 1 });
      const pageW = Number(pageViewportPoints.width) > 0 ? Number(pageViewportPoints.width) : 1;
      const pageH = Number(pageViewportPoints.height) > 0 ? Number(pageViewportPoints.height) : 1;

      const proposals: Array<{ bbox: PdfBBoxNormalizedV1; label: DoclingRegionLabel | 'fallback'; text?: string; strategy: string }> =
        pageRegions.map(r => ({
          bbox: doclingBBoxToNormalizedTopLeft(r.bbox, pageW, pageH),
          label: r.label,
          text: r.text,
          strategy: 'docling_prov',
        }));

      if (proposals.length === 0 && pageNum === 1) {
        proposals.push({
          bbox: chooseFallbackRegionBBoxNormalized(width, height),
          label: 'fallback',
          strategy: 'fallback_center_band',
        });
      }

      regionProposalsTotal += proposals.length;
      if (regionsCreated >= maxRegionsTotal) continue;

      for (let idx = 0; idx < proposals.length && regionsCreated < maxRegionsTotal; idx++) {
        const proposal = proposals[idx]!;
        const bbox = proposal.bbox;

        const rx0 = Math.floor(clamp01(bbox.x0) * width);
        const ry0 = Math.floor(clamp01(bbox.y0) * height);
        const rx1 = Math.ceil(clamp01(bbox.x1) * width);
        const ry1 = Math.ceil(clamp01(bbox.y1) * height);
        const rw = Math.max(1, rx1 - rx0);
        const rh = Math.max(1, ry1 - ry0);

        const regionCanvas = createCanvas(rw, rh);
        const rctx = regionCanvas.getContext('2d');
        rctx.drawImage(canvas, rx0, ry0, rw, rh, 0, 0, rw, rh);

        const regionPng = regionCanvas.toBuffer('image/png') as Buffer;
        const labelPart = proposal.label === 'fallback' ? 'fallback' : proposal.label;
        const regionName = `${params.output_prefix}_region_${labelPart}_p${pad4(pageNum)}_${pad3(idx + 1)}.png`;
        const regionRef = writeRunBinaryArtifact({
          runId,
          artifactName: regionName,
          bytes: new Uint8Array(regionPng),
          mimeType: 'image/png',
        });
        artifacts.push(regionRef);

        const regionText = proposal.text ?? '';
        const regionEvidence: PdfEvidenceCatalogItemV1 = {
          version: 1,
          evidence_id: 'placeholder',
          run_id: runId,
          project_id: run.project_id,
          type: 'pdf_region',
          locator: { kind: 'pdf', page: pageNum, bbox },
          text: regionText,
          normalized_text: regionText ? normalizeText(regionText) : undefined,
          meta: {
            pdf_sha256: pdfSha,
            region_uri: regionRef.uri,
            label: proposal.label,
            bbox_pixels: { x0: rx0, y0: ry0, x1: rx1, y1: ry1, width: rw, height: rh },
            strategy: proposal.strategy,
          },
        };
        regionEvidence.evidence_id = buildEvidenceId({
          runId,
          type: 'pdf_region',
          locator: regionEvidence.locator,
          text: regionText,
        });
        items.push(regionEvidence);
        regionsCreated++;
      }
    }

    if (params.mode === 'visual' && regionProposalsTotal > regionsCreated) {
      const msg = `PDF regions truncated at max_regions_total=${maxRegionsTotal} (proposed_regions=${regionProposalsTotal}, created_regions=${regionsCreated}).`;
      warnings.push(msg);
      budget.recordHit({
        key: 'pdf.max_regions_total',
        dimension: 'breadth',
        unit: 'regions',
        limit: maxRegionsTotal,
        observed: regionProposalsTotal,
        action: 'truncate',
        message: msg,
        data: { proposed_regions: regionProposalsTotal, created_regions: regionsCreated },
      });
    }

    const byType: Record<string, number> = {};
    for (const it of items) byType[it.type] = (byType[it.type] || 0) + 1;

    const pagesRef = writeRunJsonArtifact(runId, `${params.output_prefix}_pages.json`, {
      version: 1,
      generated_at: new Date().toISOString(),
      pdf_sha256: pdfSha,
      total_pages: totalPages,
      processed_pages: processedPages,
      used_zotero_fulltext: usedZoteroFulltext,
      used_docling_json: usedDoclingJson,
      pages: pageRecords,
      warnings,
    });
    artifacts.push(pagesRef);

    const catalogName = `${params.output_prefix}_evidence_catalog.jsonl`;
    const catalogContent = items.map(it => JSON.stringify(it)).join('\n') + '\n';
    const catalogRef = writeRunTextArtifact({
      runId,
      artifactName: catalogName,
      content: catalogContent,
      mimeType: 'application/x-ndjson',
    });
    artifacts.push(catalogRef);

    const metaRef = writeRunJsonArtifact(runId, `${params.output_prefix}_meta.json`, {
      version: 1,
      generated_at: new Date().toISOString(),
      pdf_sha256: pdfSha,
      mode: params.mode,
      by_type: byType,
      total_pages: totalPages,
      processed_pages: processedPages,
      used_zotero_fulltext: usedZoteroFulltext,
      used_docling_json: usedDoclingJson,
      max_regions_total: maxRegionsTotal,
      warnings,
    });
    artifacts.push(metaRef);

    const diag = writeRunStepDiagnosticsArtifact({
      run_id: runId,
      project_id: run.project_id,
      step: step.step,
      step_index: stepIndex,
      ...budget.snapshot(),
    });
    artifacts.push(diag.run, diag.project);

    await finishRunStep({
      runId,
      stepIndex,
      stepStart: step,
      status: 'done',
      artifacts,
    });

    return {
      run_id: runId,
      project_id: run.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
      artifacts,
      catalog_uri: catalogRef.uri,
      summary: {
        pdf_sha256: pdfSha,
        total_pages: totalPages,
        processed_pages: processedPages,
        regions: byType.pdf_region || 0,
        mode: params.mode,
        used_zotero_fulltext: usedZoteroFulltext,
        used_docling_json: usedDoclingJson,
        warnings,
      },
    };
  } catch (err) {
    try {
      await finishRunStep({
        runId,
        stepIndex,
        stepStart: step,
        status: 'failed',
        artifacts,
        notes: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // Ignore manifest update errors and rethrow original error.
    }
    throw err;
  }
}
