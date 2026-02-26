/**
 * Paper Content Download Tool
 * Downloads paper content with LaTeX-first, PDF-fallback strategy
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import * as tar from 'tar';
import { arxivFetch } from '../../api/rateLimiter.js';
import { resolveArxivId } from './arxivSource.js';
import { registerDownloadDir } from '../../data/downloadSession.js';
import { getDataDir, getDownloadsDir } from '../../data/dataDir.js';
import { resolvePathWithinParent } from '../../data/pathGuard.js';
import { writeDirectoryMarker } from '../../data/markers.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ARXIV_EXPORT_BASE = 'https://export.arxiv.org';

/**
 * Validate output directory to prevent path traversal attacks
 * @throws Error if directory is outside allowed base path
 */
function validateOutputDir(dir: string): string {
  const dataDir = getDataDir();
  return resolvePathWithinParent(dataDir, dir, 'output_dir');
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GetPaperContentParams {
  /** Paper identifier: INSPIRE recid, arXiv ID, or DOI */
  identifier: string;
  /** Preferred format: 'latex' | 'pdf' | 'auto' (default: 'auto') */
  prefer?: 'latex' | 'pdf' | 'auto';
  /** Output directory (default: OS temp directory) */
  output_dir?: string;
  /** Extract tar.gz archive (default: true) */
  extract?: boolean;
  /** Auto cleanup after reading (default: false) */
  auto_cleanup?: boolean;
}

export interface GetPaperContentResult {
  /** Whether download succeeded */
  success: boolean;
  /** Type of content downloaded */
  source_type: 'latex' | 'pdf';
  /** Path to main file (or archive if extract=false) */
  file_path: string;
  /** All files in LaTeX project (if extracted) */
  files?: string[];
  /** Path to main .tex file (if identified) */
  main_tex?: string;
  /** Reason for fallback to PDF (if applicable) */
  fallback_reason?: string;
  /** arXiv ID used */
  arxiv_id: string;
  /** Error message (if success=false) */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Download file from URL to local path using streaming
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await arxivFetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  // Use streaming to avoid loading entire file into memory
  const fileStream = fs.createWriteStream(destPath);
  const readable = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(readable, fileStream);
}

/**
 * Detect source file type from Content-Type header
 */
async function detectSourceType(arxivId: string): Promise<'tar.gz' | 'gz' | 'pdf' | 'unknown'> {
  const url = `${ARXIV_EXPORT_BASE}/src/${arxivId}`;
  const response = await arxivFetch(url, { method: 'HEAD' });

  if (!response.ok) return 'unknown';

  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('x-eprint-tar') || contentType.includes('x-tar')) {
    return 'tar.gz';
  } else if (contentType.includes('x-eprint') || contentType.includes('gzip')) {
    return 'gz';
  } else if (contentType.includes('pdf')) {
    return 'pdf';
  }

  return 'unknown';
}

/**
 * Extract tar.gz archive with security checks
 */
async function extractTarGz(archivePath: string, destDir: string): Promise<string[]> {
  const files: string[] = [];

  await tar.extract({
    file: archivePath,
    cwd: destDir,
    // Security: prevent path traversal and disallow special entries (symlinks/links/devices).
    filter: (entryPath, entry) => {
      const entryType = (entry as { type?: string } | undefined)?.type;
      if (entryType && entryType !== 'File' && entryType !== 'Directory') return false;
      try {
        resolvePathWithinParent(destDir, entryPath, 'tar_entry');
        return true;
      } catch {
        return false;
      }
    },
    onentry: (entry) => {
      if (entry.type === 'File') {
        files.push(entry.path);
      }
    },
  });

  return files;
}

/**
 * Extract single gzipped file
 */
async function extractGz(archivePath: string, destPath: string): Promise<void> {
  const input = fs.createReadStream(archivePath);
  const output = fs.createWriteStream(destPath);
  const gunzip = zlib.createGunzip();

  await pipeline(input, gunzip, output);
}

/**
 * Check if a file is a tar archive by reading magic bytes
 */
async function isTarArchive(filePath: string): Promise<boolean> {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(512);
    fs.readSync(fd, buffer, 0, 512, 0);
    fs.closeSync(fd);

    // Check for tar magic at offset 257: "ustar"
    const magic = buffer.slice(257, 262).toString('ascii');
    if (magic === 'ustar') return true;

    // Check for old-style tar (no magic, but valid header)
    // A tar file has a filename in the first 100 bytes, followed by mode, uid, gid, size
    // The checksum at offset 148-155 should be valid
    const checksum = buffer.slice(148, 156).toString('ascii').trim();
    if (checksum && /^[0-7\s]+$/.test(checksum)) {
      // Likely a tar file
      return true;
    }

    return false;
  } catch (error) {
    // Log at debug level for troubleshooting
    console.debug(`[hep-mcp] isTarFile: Skipped - ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Find main .tex file in extracted LaTeX project
 * Uses multiple strategies to identify the main file
 */
function findMainTexFile(destDir: string, files: string[]): string | undefined {
  let texFiles = files.filter(f => f.endsWith('.tex'));
  
  // If no .tex files found, look for files without extension that contain LaTeX content
  if (texFiles.length === 0) {
    const potentialTexFiles: string[] = [];
    for (const f of files) {
      // Skip files with common non-tex extensions and directories
      if (/\.(pdf|png|jpg|jpeg|gif|eps|bib|bbl|cls|sty|bst|aux|log|out|toc|lof|lot|idx|ind|glo|gls|nav|snm|vrb|gz|tar|zip)$/i.test(f)) continue;
      if (f.startsWith('.')) continue;
      
      try {
        const filePath = path.join(destDir, f);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) continue;
        
        // Check if file contains LaTeX content (documentclass is a strong signal)
        const content = fs.readFileSync(filePath, 'utf-8').slice(0, 5000);
        if (/\\documentclass/i.test(content)) {
          potentialTexFiles.push(f);
        }
      } catch {
        // Skip unreadable files
      }
    }
    
    if (potentialTexFiles.length > 0) {
      texFiles = potentialTexFiles;
      console.error(`[hep-mcp] findMainTexFile - found ${texFiles.length} LaTeX file(s) without .tex extension: ${texFiles.join(', ')}`);
    }
  }
  
  if (texFiles.length === 0) return undefined;
  if (texFiles.length === 1) return texFiles[0];

  // Strategy 1: Find file with \documentclass AND \begin{document}
  const fullCandidates: string[] = [];
  const docclassCandidates: string[] = [];

  for (const tex of texFiles) {
    try {
      const filePath = path.join(destDir, tex);
      const content = fs.readFileSync(filePath, 'utf-8');
      const hasDocclass = /\\documentclass/i.test(content);
      const hasBeginDoc = /\\begin\{document\}/i.test(content);

      if (hasDocclass && hasBeginDoc) {
        fullCandidates.push(tex);
      } else if (hasDocclass) {
        docclassCandidates.push(tex);
      }
    } catch (error) {
      // Log at debug level for troubleshooting
      console.debug(`[hep-mcp] findMainTexFile - file read failed (${tex}): ${error instanceof Error ? error.message : String(error)}`);
      // Skip unreadable files
    }
  }

  if (fullCandidates.length === 1) return fullCandidates[0];

  // Strategy 2: Common main file names
  const commonNames = [
    'main.tex', 'paper.tex', 'article.tex', 'manuscript.tex',
    'draft.tex', 'thesis.tex', 'report.tex', 'document.tex',
  ];
  const searchIn = fullCandidates.length > 0 ? fullCandidates : texFiles;

  for (const name of commonNames) {
    const match = searchIn.find(f => f.toLowerCase() === name);
    if (match) return match;
  }

  // Strategy 3: Largest file among candidates (main file usually has most content)
  if (fullCandidates.length > 1) {
    let largest = fullCandidates[0];
    let maxSize = 0;
    for (const tex of fullCandidates) {
      try {
        const size = fs.statSync(path.join(destDir, tex)).size;
        if (size > maxSize) {
          maxSize = size;
          largest = tex;
        }
      } catch (error) {
        // Log at debug level for troubleshooting
        console.debug(`[hep-mcp] findMainTexFile - stat failed (${tex}): ${error instanceof Error ? error.message : String(error)}`);
        // Skip
      }
    }
    return largest;
  }

  // Fallback: first full candidate, docclass candidate, or first tex file
  return fullCandidates[0] || docclassCandidates[0] || texFiles.sort()[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function getPaperContent(
  params: GetPaperContentParams
): Promise<GetPaperContentResult> {
  const {
    identifier,
    prefer = 'auto',
    output_dir,
    extract = true,
    auto_cleanup = false,
  } = params;

  // Step 1: Resolve identifier to arXiv ID
  const arxivId = await resolveArxivId(identifier);
  if (!arxivId) {
    return {
      success: false,
      source_type: 'pdf',
      file_path: '',
      arxiv_id: '',
      error: `Could not resolve arXiv ID for: ${identifier}`,
    };
  }

  // Step 2: Create output directory with path traversal validation
  const baseDir = output_dir ? validateOutputDir(output_dir) : getDownloadsDir();
  const destDir = path.join(baseDir, `arxiv-${arxivId.replace('/', '-')}`);

  // Step 2.5: Check cache - if already downloaded and extracted, return cached result
  if (fs.existsSync(destDir)) {
    const existingFiles = fs.readdirSync(destDir);
    const texFiles = existingFiles.filter(f => f.endsWith('.tex'));
    if (texFiles.length > 0) {
      // Found cached .tex files
      const mainTex = findMainTexFile(destDir, texFiles);
      if (mainTex) {
        console.error(`[getPaperContent] Using cached source for ${arxivId}`);
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
  writeDirectoryMarker(destDir, 'download_dir');

  // Step 3: Register directory for session cleanup if requested
  if (auto_cleanup) {
    registerDownloadDir(destDir);
  }

  // Step 4: Try LaTeX source if preferred
  if (prefer === 'auto' || prefer === 'latex') {
    const result = await downloadLatexSource(arxivId, destDir, extract);
    if (result.success) {
      return result;
    }
  }

  // Step 5: Fall back to PDF
  return await downloadPdf(arxivId, destDir);
}

/**
 * Download and extract LaTeX source
 */
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

  // Extract based on type
  try {
    let files: string[];

    if (sourceType === 'tar.gz') {
      files = await extractTarGz(archivePath, destDir);
    } else {
      // Single gz file - but might be a tar archive inside
      const tempPath = path.join(destDir, 'extracted_content');
      await extractGz(archivePath, tempPath);

      // Check if the extracted content is a tar archive
      if (await isTarArchive(tempPath)) {
        // It's a tar archive, extract it
        files = await extractTarGz(tempPath, destDir);
        // Clean up the intermediate tar file
        fs.unlinkSync(tempPath);
      } else {
        // It's a single file, rename to .tex
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

/**
 * Download PDF
 */
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
