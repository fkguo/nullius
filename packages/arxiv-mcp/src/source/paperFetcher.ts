/**
 * Paper Fetcher — HTTP download + Content-Type detection
 */

import * as fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import { arxivFetch } from '../api/rateLimiter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Source/PDF downloads (and their HEAD probes) go through the main
// `arxiv.org` site, NOT the `export.arxiv.org` API mirror — the mirror
// truncates large source archives at a ~2 MiB boundary. See rateLimiter
// ARXIV_ALLOWED_HOSTS for the host-role split.
const ARXIV_DOWNLOAD_BASE = 'https://arxiv.org';

/**
 * H-10 disk-fill defense: arXiv source archives are typically <50 MB; even
 * large LaTeX projects rarely exceed 200 MB. Cap downloads at 500 MB to bound
 * disk impact from a misbehaving or hostile upstream. Override with the
 * `ARXIV_MAX_DOWNLOAD_BYTES` env var if a legitimate paper exceeds the cap.
 */
const DEFAULT_MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

function getMaxDownloadBytes(): number {
  const raw = process.env.ARXIV_MAX_DOWNLOAD_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_DOWNLOAD_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_DOWNLOAD_BYTES;
  return Math.floor(parsed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SourceFileType = 'tar.gz' | 'gz' | 'pdf' | 'unknown';

// ─────────────────────────────────────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Download file from URL to local path using streaming.
 *
 * H-10: enforces a size cap to prevent disk-fill from a misbehaving or
 * hostile upstream. Pre-check via `Content-Length` header (if present), and
 * stream-side enforcement counts bytes and aborts mid-download if the cap
 * is exceeded (handles chunked transfer or missing Content-Length).
 */
export async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await arxivFetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error('No response body');
  }

  const maxBytes = getMaxDownloadBytes();

  // Pre-check Content-Length when present (cheap, blocks before any bytes
  // are written to disk).
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(
        `Download rejected: Content-Length ${contentLength} exceeds cap ${maxBytes} bytes (set ARXIV_MAX_DOWNLOAD_BYTES to override)`,
      );
    }
  }

  // Stream-side enforcement: count bytes as they pass through and abort the
  // pipeline if the cap is exceeded. Covers chunked transfer-encoding and
  // missing/lying Content-Length.
  let bytesReceived = 0;
  const capLimiter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      bytesReceived += size;
      if (bytesReceived > maxBytes) {
        callback(
          new Error(
            `Download aborted: response exceeded cap of ${maxBytes} bytes (set ARXIV_MAX_DOWNLOAD_BYTES to override)`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });

  const fileStream = fs.createWriteStream(destPath);
  const readable = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  try {
    await pipeline(readable, capLimiter, fileStream);
  } catch (err) {
    // On cap-exceeded abort the partial file is meaningless — remove it so
    // callers don't pick up half-written archives.
    try { fs.unlinkSync(destPath); } catch { /* best effort */ }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Content-Type Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect source file type from arXiv Content-Type header via HEAD request.
 */
export async function detectSourceType(arxivId: string): Promise<SourceFileType> {
  const url = `${ARXIV_DOWNLOAD_BASE}/e-print/${arxivId}`;
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
