/**
 * Atomic file write operations with fsync and EXDEV handling
 *
 * Strategy: tmp file + fsync + rename
 * This ensures that file writes are atomic - either the new content
 * is fully written or the old content remains unchanged.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

// Import shared utilities to avoid duplication
import { sleep, isNodeError } from './testable.js';

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
  fsyncDir?: boolean;  // Whether to fsync the directory after rename
}

const DEFAULT_OPTIONS: AtomicWriteOptions = {
  encoding: 'utf-8',
  mode: 0o644,
  fsyncDir: false,
};

/**
 * Atomically write content to a file
 *
 * @param filePath - Target file path
 * @param content - Content to write
 * @param options - Write options
 */
export async function atomicWrite(
  filePath: string,
  content: string,
  options?: AtomicWriteOptions
): Promise<void> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const absolutePath = path.resolve(filePath);
  const dir = path.dirname(absolutePath);
  const basename = path.basename(absolutePath);

  // Generate unique temp filename
  const tmpName = `.${basename}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  let fd: fs.FileHandle | null = null;

  try {
    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // Write to temp file
    fd = await fs.open(tmpPath, 'w', opts.mode);
    await fd.write(content, 0, opts.encoding);

    // Sync to disk
    await fd.sync();
    await fd.close();
    fd = null;

    // Atomic rename
    await renameWithExdevFallback(tmpPath, absolutePath);

    // Optionally sync directory
    if (opts.fsyncDir) {
      await fsyncDir(dir);
    }

  } catch (error) {
    // Clean up temp file on error
    if (fd) {
      try { await fd.close(); } catch { /* ignore */ }
    }
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    throw error;
  }
}

/**
 * Atomically write JSON data to a file
 *
 * @param filePath - Target file path
 * @param data - Data to serialize as JSON
 */
export async function atomicWriteJson(
  filePath: string,
  data: unknown
): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await atomicWrite(filePath, content, { encoding: 'utf-8' });
}

/**
 * Rename with EXDEV fallback
 *
 * When renaming across filesystems (EXDEV error), fall back to copy + delete
 */
async function renameWithExdevFallback(
  src: string,
  dest: string
): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (error: unknown) {
    if (isNodeError(error, 'EXDEV')) {
      // Cross-device rename - fall back to copy + delete
      await fs.copyFile(src, dest);
      await fs.unlink(src);
    } else {
      throw error;
    }
  }
}

/**
 * Sync directory to ensure metadata is persisted
 */
async function fsyncDir(dirPath: string): Promise<void> {
  let fd: fs.FileHandle | null = null;
  try {
    fd = await fs.open(dirPath, 'r');
    await fd.sync();
  } finally {
    if (fd) {
      await fd.close();
    }
  }
}

/**
 * Read JSON file with atomic semantics
 *
 * Handles the case where a concurrent atomicWrite may have temporarily
 * removed the file during rename.
 *
 * @param filePath - File path to read
 * @param retries - Number of retries on ENOENT (min 1)
 * @param retryDelayMs - Delay between retries
 */
export async function atomicReadJson<T>(
  filePath: string,
  retries = 3,
  retryDelayMs = 20
): Promise<T> {
  // Ensure at least 1 retry
  const effectiveRetries = Math.max(1, retries);

  for (let i = 0; i < effectiveRetries; i++) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error: unknown) {
      const isEnoent = isNodeError(error, 'ENOENT');
      const isSyntaxError = error instanceof SyntaxError;

      if ((isEnoent || isSyntaxError) && i < effectiveRetries - 1) {
        await sleep(retryDelayMs);
        continue;
      }
      throw error;
    }
  }

  // This line is only reachable if effectiveRetries somehow becomes 0
  // which is prevented by Math.max(1, retries) above
  throw new Error('atomicReadJson: unexpected state');
}
