import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { invalidParams } from '@nullius/shared';
import { boundPath, filePath } from './paths.js';
import { readProjectBytes, readStrictUtf8, splitSourceLines } from './content.js';

export const projectFileSearchSchema = z.object({
  query: z.string().min(1).max(1024).refine(value => !/[\r\n\0]/u.test(value), 'Use one nonempty literal line.'),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(100).default(['.']),
  context_lines: z.number().int().min(0).max(3).default(1),
  max_files: z.number().int().min(1).max(1000).default(100),
  max_file_bytes: z.number().int().min(1).max(8 * 1024 * 1024).default(1024 * 1024),
  max_total_bytes: z.number().int().min(1).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  max_matches: z.number().int().min(1).max(100).default(20),
  timeout_ms: z.number().int().min(1).max(30000).default(3000),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  expected_snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict().refine(value => value.offset === 0 || value.expected_snapshot_sha256 !== undefined, {
  message: 'Continuation requires expected_snapshot_sha256 from the previous search.',
  path: ['expected_snapshot_sha256'],
});

export type ProjectFileSearchInput = z.input<typeof projectFileSearchSchema>;
type Options = z.output<typeof projectFileSearchSchema>;
type Notice = { path: string; reason: string; message?: string };
type Source = { path: string; sha256: string; size: number };
type ContextLine = { line_number: number; text: string; start_column: number; truncated: boolean };
type Match = {
  path: string; sha256: string; line_number: number; column: number;
  occurrences: number; context: ContextLine[];
};

const MAX_ENTRIES = 10000;
const MAX_PAGE_BYTES = 64 * 1024;
const MAX_NOTICE_BYTES = 16 * 1024;
const MAX_LINE_UNITS = 1600;
const BINARY_SUFFIXES = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.tif', '.tiff',
  '.ico', '.zip', '.gz', '.bz2', '.xz', '.7z', '.tar', '.woff', '.woff2', '.mp4', '.wav',
  '.sqlite', '.db', '.parquet', '.npy', '.npz', '.h5', '.hdf5', '.pkl', '.pickle']);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const relative = (root: string, target: string) => path.relative(root, target).split(path.sep).join('/') || '.';

// Search has no exception for the three hidden state files admitted by file_read.
function searchPath(root: string, value: string): string {
  const target = boundPath(root, value);
  const name = relative(root, target);
  const folded = name.toLowerCase();
  if ((name !== '.' && name.split('/').some(part => part.startsWith('.')))
      || folded === 'artifacts/delegated-runs' || folded.startsWith('artifacts/delegated-runs/')) {
    throw invalidParams('Hidden configuration and delegated journals are outside text search.');
  }
  return name === '.' ? target : filePath(root, target, false);
}

function codepoints(text: string): number {
  let count = 0;
  for (const _character of text) count++;
  return count;
}

function snippet(line: string, lineNumber: number, focus = 0): ContextLine {
  let start = Math.max(0, focus - 200);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(line[start]!)) start--;
  let end = Math.min(line.length, start + MAX_LINE_UNITS);
  if (end < line.length && /[\uDC00-\uDFFF]/u.test(line[end]!)) end--;
  return { line_number: lineNumber, text: line.slice(start, end),
    start_column: codepoints(line.slice(0, start)) + 1, truncated: start > 0 || end < line.length };
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1200);
}

/** Literal, case-sensitive search. Offsets count matching lines, not bytes or occurrences. */
export function projectFileSearch(root: string, input: ProjectFileSearchInput) {
  const options = projectFileSearchSchema.parse(input);
  const started = performance.now();
  const roots = [...new Set(options.paths.map(value => relative(root, searchPath(root, value))))].sort();
  const skipped: Notice[] = [];
  const errors: Notice[] = [];
  const limits = new Set<string>();
  const bindings: Source[] = [];
  let skippedCount = 0;
  let errorCount = 0;
  let noticeBytes = 0;
  let entriesVisited = 0;
  let bytesRead = 0;
  let filesScanned = 0;
  let matchedLines = 0;
  let occurrences = 0;
  let pageBytes = 0;
  let pageLimit: string | null = null;
  const matches: Match[] = [];
  const notices: Notice[] = [];

  const notice = (kind: 'skip' | 'error', value: Notice): void => {
    if (kind === 'skip') skippedCount++; else errorCount++;
    // Full notices bind the selection, while returned diagnostics are bounded.
    notices.push({ ...value, reason: `${kind}:${value.reason}` });
    const length = Buffer.byteLength(JSON.stringify(value));
    if (noticeBytes + length <= MAX_NOTICE_BYTES) {
      (kind === 'skip' ? skipped : errors).push(value);
      noticeBytes += length;
    }
  };
  const expired = (): boolean => {
    if (performance.now() - started < options.timeout_ms) return false;
    limits.add('timeout_ms');
    return true;
  };

  const candidates = enumerate(root, roots, options, notice, expired, limits, () => ++entriesVisited);
  for (const name of candidates) {
    if (expired()) break;
    let source: ReturnType<typeof readProjectBytes>;
    try {
      const target = searchPath(root, name);
      const stat = fs.lstatSync(target);
      if (!stat.isFile()) {
        notice('error', { path: name, reason: 'source_changed', message: 'Selected source is no longer a regular file.' });
        continue;
      }
      if (BINARY_SUFFIXES.has(path.extname(name).toLowerCase())) {
        notice('skip', { path: name, reason: 'binary_format' });
        continue;
      }
      if (stat.size > options.max_file_bytes) {
        notice('skip', { path: name, reason: 'max_file_bytes' });
        limits.add('max_file_bytes');
        continue;
      }
      if (stat.size > options.max_total_bytes - bytesRead) {
        notice('skip', { path: name, reason: 'max_total_bytes' });
        limits.add('max_total_bytes');
        break;
      }
      source = readProjectBytes(root, name, Math.max(1, Math.min(options.max_file_bytes, options.max_total_bytes - bytesRead)));
      if (source.size > options.max_total_bytes - bytesRead) throw invalidParams('Source changed beyond the remaining byte budget.');
      bytesRead += source.size;
      bindings.push({ path: name, sha256: source.sha256, size: source.size });
    } catch (error) {
      notice('error', { path: name, reason: 'read_error', message: message(error) });
      continue;
    }
    if (source.bytes.some(byte => byte === 0 || (byte < 32 && ![9, 10, 12, 13].includes(byte)))) {
      notice('skip', { path: name, reason: 'binary_content' });
      continue;
    }
    let text: string;
    try { text = readStrictUtf8(source.bytes); }
    catch (error) {
      notice('skip', { path: name, reason: 'invalid_utf8', message: message(error) });
      continue;
    }
    const lines = splitSourceLines(text);
    let finished = true;
    for (let index = 0; index < lines.length; index++) {
      if (expired()) { finished = false; break; }
      const line = lines[index]!;
      const first = line.indexOf(options.query);
      if (first < 0) continue;
      let count = 0;
      for (let at = first; at >= 0; at = line.indexOf(options.query, at + options.query.length)) {
        count++;
        if (count % 1024 === 0 && expired()) { finished = false; break; }
      }
      if (!finished) break;
      occurrences += count;
      const ordinal = matchedLines++;
      if (ordinal < options.offset || pageLimit !== null) continue;
      if (matches.length >= options.max_matches) { pageLimit = 'max_matches'; continue; }
      const context = [];
      for (let n = Math.max(0, index - options.context_lines); n <= Math.min(lines.length - 1, index + options.context_lines); n++) {
        context.push(snippet(lines[n]!, n + 1, n === index ? first : 0));
      }
      const entry: Match = { path: name, sha256: source.sha256, line_number: index + 1,
        column: codepoints(line.slice(0, first)) + 1, occurrences: count, context };
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (pageBytes + size > MAX_PAGE_BYTES) { pageLimit = 'max_page_bytes'; continue; }
      matches.push(entry);
      pageBytes += size;
    }
    if (finished) filesScanned++;
    if (!finished) break;
  }

  expired();
  const snapshot = digest({ root, roots, query: options.query, bindings, notices,
    limits: [...limits].sort(), candidates,
    selection: [options.max_files, options.max_file_bytes, options.max_total_bytes] });
  if (options.expected_snapshot_sha256 !== undefined && options.expected_snapshot_sha256 !== snapshot) {
    throw invalidParams('Search sources or bounded selection changed; restart at offset 0 without the old snapshot.');
  }
  if (options.offset > matchedLines) throw invalidParams('Search offset is beyond the matching lines in this selection.');
  const scanFinished = limits.size === 0 && errorCount === 0;
  const hasMore = options.offset + matches.length < matchedLines;
  return {
    mode: 'literal', case_sensitive: true, query: options.query, paths: roots,
    line_number_base: 1, column_unit: 'unicode_code_points', occurrence_mode: 'non_overlapping',
    matches, matched_lines: matchedLines, matched_occurrences: occurrences,
    offset: options.offset, next_offset: hasMore && scanFinished ? options.offset + matches.length : null,
    snapshot_sha256: snapshot, page_truncated: hasMore, page_limit: pageLimit,
    coverage: {
      scope: 'allowed_project_utf8_text', complete: scanFinished && skippedCount === 0,
      truncated: limits.size > 0, files_selected: candidates.length, files_read: bindings.length, files_scanned: filesScanned,
      entries_visited: entriesVisited, bytes_read: bytesRead, limits_reached: [...limits].sort(),
      timeout_policy: 'cooperative_between_bounded_reads_and_search_units',
      skipped_count: skippedCount, error_count: errorCount, skipped, errors,
      diagnostics_truncated: skipped.length + errors.length < skippedCount + errorCount,
      max_entries: MAX_ENTRIES, max_page_bytes: MAX_PAGE_BYTES,
      no_match_meaning: 'A zero count applies only to scanned text; skipped or unscanned material remains unknown.',
    },
  };
}

function enumerate(root: string, roots: string[], options: Options,
  notice: (kind: 'skip' | 'error', value: Notice) => void, expired: () => boolean,
  limits: Set<string>, visit: () => number): string[] {
  const pending = [...roots].reverse();
  const seen = new Set<string>();
  const files = new Set<string>();
  while (pending.length) {
    if (expired()) break;
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (visit() > MAX_ENTRIES) { limits.add('max_entries'); break; }
    let target: string;
    try { target = searchPath(root, name); }
    catch (error) {
      notice('skip', { path: name, reason: 'protected_or_symlink', message: message(error) });
      continue;
    }
    try {
      const before = fs.lstatSync(target);
      if (before.isFile()) {
        if (files.size >= options.max_files) { limits.add('max_files'); break; }
        files.add(name);
      } else if (before.isDirectory()) {
        const directory = fs.opendirSync(target);
        const names: string[] = [];
        try {
          for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
            if (expired()) break;
            if (names.length + seen.size + pending.length >= MAX_ENTRIES) { limits.add('max_entries'); break; }
            names.push(entry.name);
          }
        } finally { directory.closeSync(); }
        const after = fs.lstatSync(searchPath(root, name));
        if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          notice('error', { path: name, reason: 'directory_changed', message: 'Directory changed during enumeration.' });
        }
        for (const child of names.sort().reverse()) pending.push(name === '.' ? child : `${name}/${child}`);
      } else {
        notice('skip', { path: name, reason: 'non_regular' });
      }
    } catch (error) {
      notice('error', { path: name, reason: 'enumeration_error', message: message(error) });
    }
  }
  return [...files].sort();
}
