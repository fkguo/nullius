/**
 * Paper Content — download orchestrator (LaTeX-first, PDF-fallback)
 *
 * Domain-agnostic: no INSPIRE, no hep-mcp dir management.
 * Caller provides output_dir (baseDir); this module appends `arxiv-<id>/`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { normalizeArxivId } from './arxivSource.js';
import { downloadFile, detectSourceType } from './paperFetcher.js';
import { extractTarGz, extractGz, isTarArchive, findMainTexFile } from './tarExtractor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ARXIV_EXPORT_BASE = 'https://export.arxiv.org';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GetPaperContentParams {
  identifier: string;
  prefer?: 'latex' | 'pdf' | 'auto';
  output_dir?: string;
  extract?: boolean;
}

export interface GetPaperContentResult {
  success: boolean;
  source_type: 'latex' | 'pdf';
  file_path: string;
  files?: string[];
  main_tex?: string;
  fallback_reason?: string;
  arxiv_id: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Data Dir
// ─────────────────────────────────────────────────────────────────────────────

function getDefaultDataDir(): string {
  return process.env.ARXIV_DATA_DIR || path.join(os.tmpdir(), 'arxiv-mcp-data');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Download paper content (LaTeX-first, PDF-fallback).
 *
 * `output_dir` is baseDir — this function appends `arxiv-<id>/`.
 */
export async function getPaperContent(
  params: GetPaperContentParams
): Promise<GetPaperContentResult> {
  const { identifier, prefer = 'auto', output_dir, extract = true } = params;

  // Normalize identifier
  const arxivId = normalizeArxivId(identifier);
  if (!arxivId) {
    return {
      success: false,
      source_type: 'pdf',
      file_path: '',
      arxiv_id: '',
      error: `Could not resolve arXiv ID for: ${identifier}`,
    };
  }

  // output_dir = baseDir contract: append arxiv-<id>/ internally
  const baseDir = output_dir ?? getDefaultDataDir();
  const destDir = path.join(baseDir, `arxiv-${arxivId.replace('/', '-')}`);

  // Cache check
  if (fs.existsSync(destDir)) {
    const existingFiles = fs.readdirSync(destDir);
    const texFiles = existingFiles.filter(f => f.endsWith('.tex'));
    if (texFiles.length > 0) {
      const mainTex = findMainTexFile(destDir, texFiles);
      if (mainTex) {
        return {
          success: true,
          source_type: 'latex',
          file_path: path.join(destDir, mainTex),
          main_tex: path.join(destDir, mainTex),
          arxiv_id: arxivId,
        };
      }
    }
  }

  fs.mkdirSync(destDir, { recursive: true });

  // Try LaTeX source
  if (prefer === 'auto' || prefer === 'latex') {
    const result = await downloadLatexSource(arxivId, destDir, extract);
    if (result.success) return result;
  }

  // Fall back to PDF
  return downloadPdf(arxivId, destDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// LaTeX Download
// ─────────────────────────────────────────────────────────────────────────────

async function downloadLatexSource(
  arxivId: string,
  destDir: string,
  extract: boolean
): Promise<GetPaperContentResult> {
  const sourceType = await detectSourceType(arxivId);

  if (sourceType === 'pdf' || sourceType === 'unknown') {
    return {
      success: false,
      source_type: 'latex',
      file_path: '',
      arxiv_id: arxivId,
      fallback_reason: 'No LaTeX source available',
    };
  }

  const sourceUrl = `${ARXIV_EXPORT_BASE}/src/${arxivId}`;
  const archivePath = path.join(destDir, 'source.tar.gz');

  try {
    await downloadFile(sourceUrl, archivePath);
  } catch (err) {
    return {
      success: false,
      source_type: 'latex',
      file_path: '',
      arxiv_id: arxivId,
      fallback_reason: `Download failed: ${err}`,
    };
  }

  if (!extract) {
    return {
      success: true,
      source_type: 'latex',
      file_path: archivePath,
      arxiv_id: arxivId,
    };
  }

  try {
    let files: string[];

    if (sourceType === 'tar.gz') {
      files = await extractTarGz(archivePath, destDir);
    } else {
      // Single gz file — might be a tar archive inside
      const tempPath = path.join(destDir, 'extracted_content');
      await extractGz(archivePath, tempPath);

      if (await isTarArchive(tempPath)) {
        files = await extractTarGz(tempPath, destDir);
        fs.unlinkSync(tempPath);
      } else {
        const texPath = path.join(destDir, 'main.tex');
        fs.renameSync(tempPath, texPath);
        files = ['main.tex'];
      }
    }

    const mainTex = findMainTexFile(destDir, files);

    return {
      success: true,
      source_type: 'latex',
      file_path: destDir,
      files,
      main_tex: mainTex ? path.join(destDir, mainTex) : undefined,
      arxiv_id: arxivId,
    };
  } catch (err) {
    return {
      success: false,
      source_type: 'latex',
      file_path: archivePath,
      arxiv_id: arxivId,
      fallback_reason: `Extraction failed: ${err}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF Download
// ─────────────────────────────────────────────────────────────────────────────

async function downloadPdf(
  arxivId: string,
  destDir: string
): Promise<GetPaperContentResult> {
  const pdfUrl = `${ARXIV_EXPORT_BASE}/pdf/${arxivId}.pdf`;
  const pdfPath = path.join(destDir, `${arxivId.replace('/', '-')}.pdf`);

  try {
    await downloadFile(pdfUrl, pdfPath);
    return {
      success: true,
      source_type: 'pdf',
      file_path: pdfPath,
      arxiv_id: arxivId,
    };
  } catch (err) {
    return {
      success: false,
      source_type: 'pdf',
      file_path: '',
      arxiv_id: arxivId,
      error: `PDF download failed: ${err}`,
    };
  }
}
