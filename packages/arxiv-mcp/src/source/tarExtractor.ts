/**
 * Tar/Gz Extraction — archive handling + findMainTexFile
 *
 * Security: path traversal protection via resolved-path checks.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import * as tar from 'tar';

// ─────────────────────────────────────────────────────────────────────────────
// Path Safety
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure a path resolves within the expected parent directory.
 * Throws if the resolved path escapes the parent.
 */
function ensureWithinParent(parentDir: string, childPath: string): string {
  const resolved = path.resolve(parentDir, childPath);
  const normalizedParent = path.resolve(parentDir) + path.sep;
  if (!resolved.startsWith(normalizedParent) && resolved !== path.resolve(parentDir)) {
    throw new Error(`Path traversal blocked: ${childPath} escapes ${parentDir}`);
  }
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tar/Gz Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract tar.gz archive with security checks.
 */
export async function extractTarGz(archivePath: string, destDir: string): Promise<string[]> {
  const files: string[] = [];

  await tar.extract({
    file: archivePath,
    cwd: destDir,
    filter: (entryPath, entry) => {
      const entryType = (entry as { type?: string } | undefined)?.type;
      if (entryType && entryType !== 'File' && entryType !== 'Directory') return false;
      try {
        ensureWithinParent(destDir, entryPath);
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
 * Extract single gzipped file.
 */
export async function extractGz(archivePath: string, destPath: string): Promise<void> {
  const input = fs.createReadStream(archivePath);
  const output = fs.createWriteStream(destPath);
  const gunzip = zlib.createGunzip();
  await pipeline(input, gunzip, output);
}

/**
 * Check if a file is a tar archive by reading magic bytes.
 */
export async function isTarArchive(filePath: string): Promise<boolean> {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(512);
    fs.readSync(fd, buffer, 0, 512, 0);
    fs.closeSync(fd);

    // Check for tar magic at offset 257: "ustar"
    const magic = buffer.slice(257, 262).toString('ascii');
    if (magic === 'ustar') return true;

    // Old-style tar — checksum at offset 148-155
    const checksum = buffer.slice(148, 156).toString('ascii').trim();
    if (checksum && /^[0-7\s]+$/.test(checksum)) return true;

    return false;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Find Main TeX File
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find main .tex file in extracted LaTeX project.
 * Uses multiple strategies to identify the main file.
 */
export function findMainTexFile(destDir: string, files: string[]): string | undefined {
  let texFiles = files.filter(f => f.endsWith('.tex'));

  // If no .tex files, look for files without extension that contain LaTeX content
  if (texFiles.length === 0) {
    const potentialTexFiles: string[] = [];
    for (const f of files) {
      if (/\.(pdf|png|jpg|jpeg|gif|eps|bib|bbl|cls|sty|bst|aux|log|out|toc|lof|lot|idx|ind|glo|gls|nav|snm|vrb|gz|tar|zip)$/i.test(f)) continue;
      if (f.startsWith('.')) continue;
      try {
        const filePath = path.join(destDir, f);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) continue;
        const content = fs.readFileSync(filePath, 'utf-8').slice(0, 5000);
        if (/\\documentclass/i.test(content)) {
          potentialTexFiles.push(f);
        }
      } catch {
        // Skip unreadable files
      }
    }
    if (potentialTexFiles.length > 0) texFiles = potentialTexFiles;
  }

  if (texFiles.length === 0) return undefined;
  if (texFiles.length === 1) return texFiles[0];

  // Strategy 1: Find file with \documentclass AND \begin{document}
  const fullCandidates: string[] = [];
  const docclassCandidates: string[] = [];

  for (const tex of texFiles) {
    try {
      const content = fs.readFileSync(path.join(destDir, tex), 'utf-8');
      const hasDocclass = /\\documentclass/i.test(content);
      const hasBeginDoc = /\\begin\{document\}/i.test(content);

      if (hasDocclass && hasBeginDoc) fullCandidates.push(tex);
      else if (hasDocclass) docclassCandidates.push(tex);
    } catch {
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

  // Strategy 3: Largest file among candidates
  if (fullCandidates.length > 1) {
    let largest = fullCandidates[0];
    let maxSize = 0;
    for (const tex of fullCandidates) {
      try {
        const size = fs.statSync(path.join(destDir, tex)).size;
        if (size > maxSize) { maxSize = size; largest = tex; }
      } catch {
        // Skip
      }
    }
    return largest;
  }

  return fullCandidates[0] || docclassCandidates[0] || texFiles.sort()[0];
}
