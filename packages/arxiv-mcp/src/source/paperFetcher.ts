/**
 * Paper Fetcher — HTTP download + Content-Type detection
 */

import * as fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { arxivFetch } from '../api/rateLimiter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ARXIV_EXPORT_BASE = 'https://export.arxiv.org';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SourceFileType = 'tar.gz' | 'gz' | 'pdf' | 'unknown';

// ─────────────────────────────────────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Download file from URL to local path using streaming.
 */
export async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await arxivFetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error('No response body');
  }

  const fileStream = fs.createWriteStream(destPath);
  const readable = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(readable, fileStream);
}

// ─────────────────────────────────────────────────────────────────────────────
// Content-Type Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect source file type from arXiv Content-Type header via HEAD request.
 */
export async function detectSourceType(arxivId: string): Promise<SourceFileType> {
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
