import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import * as tar from 'tar';
import pLimit from 'p-limit';
import { createHash } from 'crypto';

import { arxivFetch } from '../../api/rateLimiter.js';
import { resolveArxivId } from '../../tools/research/arxivSource.js';
import { ensureDir } from '../../data/dataDir.js';
import { resolvePathWithinParent } from '../../data/pathGuard.js';
import type { StyleCorpusManifestEntry } from './schemas.js';
import { getCorpusDir, getCorpusPdfDir, getCorpusSourcesDir } from './paths.js';
import { paperKeyForRecid } from './paperKey.js';

const ARXIV_EXPORT_BASE = 'https://export.arxiv.org';

type ArxivSourceKind = 'tar.gz' | 'gz' | 'pdf' | 'unknown';

function normalizeRelPath(p: string): string {
  const normalized = p.split(path.sep).join('/');
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function sha256FileHex(filePath: string): string {
  const h = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      offset += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const tmpPath = `${destPath}.tmp`;
  if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });

  const response = await arxivFetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  if (!response.body) throw new Error('No response body');

  ensureDir(path.dirname(destPath));

  const fileStream = fs.createWriteStream(tmpPath);
  const readable = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  try {
    await pipeline(readable, fileStream);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }

  try {
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

async function detectArxivSourceKind(arxivId: string): Promise<ArxivSourceKind> {
  const url = `${ARXIV_EXPORT_BASE}/src/${arxivId}`;
  const response = await arxivFetch(url, { method: 'HEAD' });
  if (!response.ok) return 'unknown';

  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('x-eprint-tar') || contentType.includes('x-tar')) return 'tar.gz';
  if (contentType.includes('x-eprint') || contentType.includes('gzip')) return 'gz';
  if (contentType.includes('pdf')) return 'pdf';
  return 'unknown';
}

async function extractGz(archivePath: string, destPath: string): Promise<void> {
  const input = fs.createReadStream(archivePath);
  const output = fs.createWriteStream(destPath);
  const gunzip = zlib.createGunzip();
  await pipeline(input, gunzip, output);
}

async function isTarArchive(filePath: string): Promise<boolean> {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(512);
    fs.readSync(fd, buffer, 0, 512, 0);
    fs.closeSync(fd);

    const magic = buffer.slice(257, 262).toString('ascii');
    if (magic === 'ustar') return true;

    const checksum = buffer.slice(148, 156).toString('ascii').trim();
    if (checksum && /^[0-7\\s]+$/.test(checksum)) return true;

    return false;
  } catch {
    return false;
  }
}

async function extractTarGzSafe(archivePath: string, destDir: string): Promise<string[]> {
  ensureDir(destDir);
  const files: string[] = [];

  await tar.extract({
    file: archivePath,
    cwd: destDir,
    filter: (entryPath, entry) => {
      // Security: disallow links + path traversal.
      const entryType = (entry as { type?: string } | undefined)?.type;
      if (entryType === 'SymbolicLink' || entryType === 'Link') return false;
      if (entryType && entryType !== 'File' && entryType !== 'Directory') return false;
      try {
        resolvePathWithinParent(destDir, path.join(destDir, entryPath), 'tar_entry');
        return true;
      } catch {
        return false;
      }
    },
    onentry: (entry) => {
      if (entry.type === 'File') files.push(entry.path);
    },
  });

  return files;
}

function findMainTexFile(destDir: string, files: string[]): string | undefined {
  const texFiles = files.filter(f => f.toLowerCase().endsWith('.tex'));
  if (texFiles.length === 0) return undefined;
  if (texFiles.length === 1) return texFiles[0];

  const fullCandidates: string[] = [];
  const docclassCandidates: string[] = [];

  for (const tex of texFiles) {
    try {
      const filePath = resolvePathWithinParent(destDir, path.join(destDir, tex), 'tex_file');
      const content = fs.readFileSync(filePath, 'utf-8');
      const hasDocclass = /\\documentclass/i.test(content);
      const hasBeginDoc = /\\begin\\{document\\}/i.test(content);

      if (hasDocclass && hasBeginDoc) fullCandidates.push(tex);
      else if (hasDocclass) docclassCandidates.push(tex);
    } catch {
      // ignore unreadable files
    }
  }

  if (fullCandidates.length === 1) return fullCandidates[0];

  const commonNames = [
    'main.tex',
    'paper.tex',
    'article.tex',
    'manuscript.tex',
    'draft.tex',
    'report.tex',
    'document.tex',
  ];

  const searchIn = fullCandidates.length > 0 ? fullCandidates : texFiles;
  for (const name of commonNames) {
    const match = searchIn.find(f => f.toLowerCase() === name);
    if (match) return match;
  }

  const candidates = fullCandidates.length > 0 ? fullCandidates : docclassCandidates.length > 0 ? docclassCandidates : texFiles;
  let largest = candidates[0];
  let maxSize = -1;
  for (const tex of candidates) {
    try {
      const filePath = resolvePathWithinParent(destDir, path.join(destDir, tex), 'tex_file');
      const size = fs.statSync(filePath).size;
      if (size > maxSize) {
        maxSize = size;
        largest = tex;
      }
    } catch {
      // ignore
    }
  }

  return largest;
}

function isCompleteLatexDownload(entry: StyleCorpusManifestEntry, corpusDir: string): boolean {
  if (entry.source?.source_type !== 'latex') return false;
  if (!entry.source.source_archive || !entry.source.source_dir || !entry.source.main_tex) return false;

  const archivePath = resolvePathWithinParent(corpusDir, path.join(corpusDir, entry.source.source_archive), 'source_archive');
  const extractedDir = resolvePathWithinParent(corpusDir, path.join(corpusDir, entry.source.source_dir), 'source_dir');
  const mainTexPath = resolvePathWithinParent(corpusDir, path.join(corpusDir, entry.source.main_tex), 'main_tex');

  try {
    const archiveStat = fs.statSync(archivePath);
    const extractedStat = fs.statSync(extractedDir);
    const mainTexStat = fs.statSync(mainTexPath);
    return archiveStat.isFile() && archiveStat.size > 0 && extractedStat.isDirectory() && mainTexStat.isFile() && mainTexStat.size > 0;
  } catch {
    return false;
  }
}

function isCompletePdfDownload(entry: StyleCorpusManifestEntry, corpusDir: string): boolean {
  if (entry.source?.source_type !== 'pdf') return false;
  if (!entry.source.pdf_path) return false;
  const pdfPath = resolvePathWithinParent(corpusDir, path.join(corpusDir, entry.source.pdf_path), 'pdf_path');
  try {
    const stat = fs.statSync(pdfPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export interface DownloadCorpusPapersResult {
  updated: StyleCorpusManifestEntry[];
  summary: {
    attempted: number;
    downloaded_latex: number;
    downloaded_pdf: number;
    skipped: number;
    errors: number;
  };
}

export async function downloadCorpusPapers(params: {
  style_id: string;
  entries: StyleCorpusManifestEntry[];
  concurrency?: number;
  force?: boolean;
  limit?: number;
}): Promise<DownloadCorpusPapersResult> {
  const corpusDir = getCorpusDir(params.style_id);
  const sourcesDir = getCorpusSourcesDir(params.style_id);
  const pdfDir = getCorpusPdfDir(params.style_id);

  const limit = params.limit && params.limit > 0 ? Math.trunc(params.limit) : null;
  const entries = limit ? params.entries.slice(0, limit) : params.entries;

  const concurrency = Math.max(1, Math.min(params.concurrency ?? 2, 8));
  const gate = pLimit(concurrency);

  const results = await Promise.all(entries.map(e => gate(async () => {
    const existing = e;
    if (!params.force) {
      if (isCompleteLatexDownload(existing, corpusDir) || isCompletePdfDownload(existing, corpusDir)) {
        return { updated: existing, outcome: 'skipped' as const };
      }
    }

    const now = new Date().toISOString();

    const arxivId = existing.arxiv_id || (await resolveArxivId(existing.recid)) || null;
    if (!arxivId) {
      const updated: StyleCorpusManifestEntry = {
        ...existing,
        status: 'error',
        error: 'download:no_arxiv_id',
        source: {
          ...(existing.source ?? {}),
          source_type: 'none',
          updated_at: now,
        },
      };
      return {
        updated,
        outcome: 'error' as const,
      };
    }

    const srcUrl = `${ARXIV_EXPORT_BASE}/src/${arxivId}`;
    const pdfUrl = `${ARXIV_EXPORT_BASE}/pdf/${arxivId}.pdf`;

    const paperKey = paperKeyForRecid(existing.recid);
    const paperRoot = resolvePathWithinParent(sourcesDir, path.join(sourcesDir, paperKey), 'paper_sources_root');
    ensureDir(paperRoot);

    const archivePath = resolvePathWithinParent(paperRoot, path.join(paperRoot, 'source.tar.gz'), 'paper_source_archive');
    const extractedDir = resolvePathWithinParent(paperRoot, path.join(paperRoot, 'extracted'), 'paper_source_extracted');
    if (params.force && fs.existsSync(extractedDir)) {
      fs.rmSync(extractedDir, { recursive: true, force: true });
    }

    const pdfPath = resolvePathWithinParent(pdfDir, path.join(pdfDir, `${paperKey}.pdf`), 'paper_pdf_path');
    if (params.force && fs.existsSync(pdfPath)) {
      fs.rmSync(pdfPath, { force: true, recursive: true });
    }

    const kind = await detectArxivSourceKind(arxivId);
    const tryLatex = kind === 'tar.gz' || kind === 'gz';
    let latexError: string | null = null;

    if (tryLatex) {
      try {
        if (params.force || !fs.existsSync(archivePath)) {
          await downloadToFile(srcUrl, archivePath);
        }

        const tmpContentPath = resolvePathWithinParent(paperRoot, path.join(paperRoot, 'source_content'), 'paper_source_content');
        let extractedFiles: string[] = [];

        if (kind === 'tar.gz') {
          extractedFiles = await extractTarGzSafe(archivePath, extractedDir);
        } else {
          await extractGz(archivePath, tmpContentPath);
          if (await isTarArchive(tmpContentPath)) {
            extractedFiles = await extractTarGzSafe(tmpContentPath, extractedDir);
            fs.rmSync(tmpContentPath, { force: true });
          } else {
            ensureDir(extractedDir);
            const mainTexRel = 'main.tex';
            const mainTexPath = resolvePathWithinParent(extractedDir, path.join(extractedDir, mainTexRel), 'paper_main.tex');
            fs.renameSync(tmpContentPath, mainTexPath);
            extractedFiles = [mainTexRel];
          }
        }

        const mainTexRel = findMainTexFile(extractedDir, extractedFiles);
        if (!mainTexRel) throw new Error('main_tex_not_found');

        const mainTexAbs = resolvePathWithinParent(extractedDir, path.join(extractedDir, mainTexRel), 'paper_main_tex');
        if (!fs.existsSync(mainTexAbs)) throw new Error('main_tex_missing_on_disk');

        const sha256 = sha256FileHex(archivePath);
        const sizeBytes = fs.statSync(archivePath).size;

        const updated: StyleCorpusManifestEntry = {
          ...existing,
          arxiv_id: arxivId,
          status: 'downloaded',
          error: undefined,
          source: {
            source_type: 'latex',
            source_archive: normalizeRelPath(path.relative(corpusDir, archivePath)),
            source_dir: normalizeRelPath(path.relative(corpusDir, extractedDir)),
            main_tex: normalizeRelPath(path.relative(corpusDir, mainTexAbs)),
            pdf_path: existing.source?.pdf_path,
            sha256,
            size_bytes: sizeBytes,
            provenance_url: srcUrl,
            updated_at: now,
          },
        };

        return {
          updated,
          outcome: 'downloaded_latex' as const,
        };
      } catch (err) {
        // Fall through to PDF.
        const msg = err instanceof Error ? err.message : String(err);
        latexError = `download:latex_failed:${msg}`;
        // Avoid leaving behind empty directories when LaTeX fails.
        try {
          if (fs.existsSync(extractedDir) && fs.readdirSync(extractedDir).length === 0) {
            fs.rmSync(extractedDir, { recursive: true, force: true });
          }
        } catch {
          // ignore cleanup errors
        }
      }
    }

    // PDF fallback
    try {
      const pdfExists = fs.existsSync(pdfPath);
      const shouldDownloadPdf = params.force || !pdfExists || (() => {
        try {
          const stat = fs.statSync(pdfPath);
          return !stat.isFile() || stat.size === 0;
        } catch {
          return true;
        }
      })();

      if (shouldDownloadPdf) {
        if (pdfExists) fs.rmSync(pdfPath, { force: true, recursive: true });
        await downloadToFile(pdfUrl, pdfPath);
      }

      const pdfStat = fs.statSync(pdfPath);
      if (!pdfStat.isFile()) throw new Error('pdf_not_a_file');
      if (pdfStat.size === 0) {
        fs.rmSync(pdfPath, { force: true });
        throw new Error('pdf_empty');
      }

      const sha256 = sha256FileHex(pdfPath);
      const sizeBytes = pdfStat.size;

      if (latexError) {
        // Ensure LaTeX failure does not leave behind empty extracted/ dirs.
        try {
          if (fs.existsSync(extractedDir) && fs.readdirSync(extractedDir).length === 0) {
            fs.rmSync(extractedDir, { recursive: true, force: true });
          }
        } catch {
          // ignore cleanup errors
        }
      }

      const updated: StyleCorpusManifestEntry = {
        ...existing,
        arxiv_id: arxivId,
        status: 'downloaded',
        error: undefined,
        source: {
          source_type: 'pdf',
          pdf_path: normalizeRelPath(path.relative(corpusDir, pdfPath)),
          sha256,
          size_bytes: sizeBytes,
          provenance_url: pdfUrl,
          updated_at: now,
        },
      };

      return {
        updated,
        outcome: 'downloaded_pdf' as const,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        if (fs.existsSync(extractedDir) && fs.readdirSync(extractedDir).length === 0) {
          fs.rmSync(extractedDir, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup errors
      }
      const updated: StyleCorpusManifestEntry = {
        ...existing,
        arxiv_id: arxivId,
        status: 'error',
        error: latexError ? `download:pdf_failed:${msg};${latexError}` : `download:pdf_failed:${msg}`,
        source: {
          ...(existing.source ?? {}),
          source_type: 'none',
          updated_at: now,
        },
      };
      return {
        updated,
        outcome: 'error' as const,
      };
    }
  })));

  const updated = results.map(r => r.updated);
  const count = (outcome: typeof results[number]['outcome']) => results.filter(r => r.outcome === outcome).length;

  return {
    updated,
    summary: {
      attempted: entries.length,
      downloaded_latex: count('downloaded_latex'),
      downloaded_pdf: count('downloaded_pdf'),
      skipped: count('skipped'),
      errors: count('error'),
    },
  };
}
