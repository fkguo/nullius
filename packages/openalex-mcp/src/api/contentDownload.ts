/**
 * Handler for openalex_content tool.
 *
 * Downloads full-text PDF or TEI-XML from content.openalex.org with:
 * - Streaming to temp file (atomic write via rename)
 * - MIME type validation
 * - Size limit enforcement via Content-Length header
 * - Path guard (no symlink escape from data dir)
 * - Redirect limit enforcement
 */

import * as fs from 'fs';
import * as path from 'path';
import type { z } from 'zod';
import { invalidParams, upstreamError } from '@autoresearch/shared';
import type { OpenAlexContentSchema } from '../tools/schemas.js';
import { openalexFetchFullUrl, getCostSummary, getResponseMeta } from './rateLimiter.js';
import { getDataDir } from './client.js';
import { detectIdentifier } from './identifiers.js';

const CONTENT_BASE_URL = 'https://content.openalex.org';
const ACCEPTED_MIME_PDF = ['application/pdf'];
const ACCEPTED_MIME_TEI = ['application/xml', 'text/xml', 'application/tei+xml'];

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isPathInside(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function guardPath(parentDir: string, candidatePath: string, what: string): string {
  const resolvedParent = path.resolve(parentDir);
  const resolvedCandidate = path.resolve(candidatePath);
  if (!isPathInside(resolvedParent, resolvedCandidate)) {
    throw invalidParams(`${what} must be within ${resolvedParent}`);
  }
  // Walk from candidate upward to find the deepest existing path component,
  // then realpath-check it. This catches symlinks in intermediate ancestors
  // that point outside the parent (e.g. dataDir/link/subdir where link → /etc).
  let check = resolvedCandidate;
  while (check !== resolvedParent && check !== path.dirname(check)) {
    if (fs.existsSync(check)) {
      let real: string;
      try { real = fs.realpathSync(check); } catch { real = check; }
      if (!isPathInside(resolvedParent, real)) {
        throw invalidParams(`${what}: symlink escape detected`);
      }
      break; // deepest existing component is safe; ancestors towards parent are pre-approved
    }
    check = path.dirname(check);
  }
  return resolvedCandidate;
}

function normalizeWorkId(rawId: string): string {
  const detected = detectIdentifier(rawId);
  if (detected?.type === 'openalex') return detected.normalized;
  if (detected?.type === 'openalex_url') {
    return detected.normalized.split('/').pop() ?? rawId;
  }
  // For DOIs etc., use the raw form — content API may accept DOI-based lookup
  return rawId;
}

export async function handleContent(
  args: z.output<typeof OpenAlexContentSchema>,
): Promise<{
  work_id: string;
  type: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  uri: string;
  cost: ReturnType<typeof getCostSummary>;
  _meta: ReturnType<typeof getResponseMeta>;
}> {
  const workId = normalizeWorkId(args.work_id);
  const ext = args.type === 'tei' ? 'tei.xml' : 'pdf';
  const contentPath = `/${args.type}/${encodeURIComponent(workId)}`;
  const url = `${CONTENT_BASE_URL}${contentPath}`;

  // Resolve output directory
  const baseDir = path.join(getDataDir(), 'content');
  const outDirResolved = args.out_dir
    ? guardPath(getDataDir(), path.resolve(args.out_dir), 'out_dir')
    : baseDir;
  ensureDir(outDirResolved);

  // Safe filename: workId with non-alphanumeric chars replaced
  const safeId = workId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  const fileName = `${safeId}.${ext}`;
  const destPath = guardPath(outDirResolved, path.join(outDirResolved, fileName), 'output file');
  const tmpPath = `${destPath}.tmp`;

  // Fetch with HEAD-based size check first
  const response = await openalexFetchFullUrl(url);
  if (!response.ok) {
    if (response.status === 404) throw invalidParams(`Content not available for work: ${workId}`);
    throw upstreamError(`OpenAlex content fetch failed: HTTP ${response.status}`);
  }

  // MIME validation
  const contentType = response.headers.get('content-type') ?? '';
  const mimeBase = contentType.split(';')[0].trim().toLowerCase();
  const accepted = args.type === 'pdf' ? ACCEPTED_MIME_PDF : ACCEPTED_MIME_TEI;
  if (!accepted.some(m => mimeBase === m || mimeBase.startsWith(m))) {
    throw upstreamError(
      `Unexpected content type for ${args.type}: ${contentType}. ` +
      `Expected one of: ${accepted.join(', ')}`,
    );
  }

  // Size check via Content-Length header
  const contentLength = response.headers.get('content-length');
  if (contentLength != null) {
    const bytes = parseInt(contentLength, 10);
    const limitBytes = args.max_size_mb * 1024 * 1024;
    if (Number.isFinite(bytes) && bytes > limitBytes) {
      throw invalidParams(
        `Content-Length (${(bytes / 1024 / 1024).toFixed(1)} MB) exceeds max_size_mb (${args.max_size_mb})`,
      );
    }
  }

  // Stream response body to temp file
  if (!response.body) throw upstreamError('OpenAlex content response has no body');

  const fd = fs.openSync(tmpPath, 'w');
  let totalBytes = 0;
  const limitBytes = args.max_size_mb * 1024 * 1024;
  let streamSuccess = false;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > limitBytes) {
          throw invalidParams(
            `Download exceeded max_size_mb (${args.max_size_mb}): stopped at ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
          );
        }
        fs.writeSync(fd, Buffer.from(value));
      }
    }
    fs.fsyncSync(fd);
    streamSuccess = true;
  } finally {
    fs.closeSync(fd);
    if (!streamSuccess) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    }
  }

  // Atomic rename + directory fsync
  fs.renameSync(tmpPath, destPath);
  const dirFd = fs.openSync(outDirResolved, 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }

  const uri = `openalex://content/${workId}/${fileName}`;

  return {
    work_id: workId,
    type: args.type,
    file_path: destPath,
    file_size: totalBytes,
    mime_type: mimeBase,
    uri,
    cost: getCostSummary(),
    _meta: getResponseMeta(),
  };
}
