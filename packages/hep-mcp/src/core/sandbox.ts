/**
 * Untrusted content sandbox utilities (H-12).
 *
 * Provides safe extraction for ZIP archives with Zip Slip prevention,
 * decompression bomb limits, and directory traversal checks.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export { PDF_RESOURCE_LIMITS } from '@autoresearch/shared';

// ── Types ────────────────────────────────────────────────────────────────

export interface ExtractOptions {
  /** Maximum total uncompressed bytes (default 500MB) */
  maxTotalBytes?: number;
  /** Maximum number of files/entries (default 10000) */
  maxFileCount?: number;
  /** Allowed file extensions; undefined = allow all */
  allowedExtensions?: string[];
}

// ── ZIP Safety ───────────────────────────────────────────────────────────

const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB
const DEFAULT_MAX_FILE_COUNT = 10_000;

/**
 * Validate that an entry path is safe (no directory traversal).
 * Returns the resolved absolute path within destDir, or throws.
 */
function validateEntryPath(entryName: string, destDir: string): string {
  // Reject entries with '..' anywhere in the name
  if (entryName.includes('..')) {
    throw new ZipSafetyError(`Directory traversal detected in entry name: ${entryName}`);
  }

  const resolved = path.resolve(destDir, entryName);
  // Zip Slip check: resolved path must be inside destDir
  if (!resolved.startsWith(destDir + path.sep) && resolved !== destDir) {
    throw new ZipSafetyError(`Zip Slip: entry "${entryName}" resolves outside destination`);
  }

  return resolved;
}

export class ZipSafetyError extends Error {
  readonly code = 'RESOURCE_LIMIT';
  constructor(message: string) {
    super(message);
    this.name = 'ZipSafetyError';
  }
}

/**
 * Safely extract a ZIP archive to destDir with resource limits and path validation.
 *
 * Uses Node.js built-in zlib for deflate; implements a minimal ZIP local file header parser.
 * For production use with complex ZIPs, consider replacing with a dedicated library.
 */
export function safeExtractZip(archivePath: string, destDir: string, opts?: ExtractOptions): void {
  const maxTotalBytes = opts?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFileCount = opts?.maxFileCount ?? DEFAULT_MAX_FILE_COUNT;
  const allowedExtensions = opts?.allowedExtensions;

  const resolvedDest = path.resolve(destDir);
  fs.mkdirSync(resolvedDest, { recursive: true });

  const buf = fs.readFileSync(archivePath);
  let offset = 0;
  let totalBytes = 0;
  let fileCount = 0;

  while (offset < buf.length - 4) {
    // Check for local file header signature (PK\x03\x04)
    if (buf[offset] !== 0x50 || buf[offset + 1] !== 0x4b ||
        buf[offset + 2] !== 0x03 || buf[offset + 3] !== 0x04) {
      break; // No more local file headers
    }

    const compressionMethod = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const uncompressedSize = buf.readUInt32LE(offset + 22);
    const fileNameLength = buf.readUInt16LE(offset + 26);
    const extraFieldLength = buf.readUInt16LE(offset + 28);

    const entryName = buf.toString('utf-8', offset + 30, offset + 30 + fileNameLength);
    const dataOffset = offset + 30 + fileNameLength + extraFieldLength;

    offset = dataOffset + compressedSize;

    // Skip directories
    if (entryName.endsWith('/')) continue;

    // File count limit
    fileCount++;
    if (fileCount > maxFileCount) {
      throw new ZipSafetyError(`File count limit exceeded: ${maxFileCount}`);
    }

    // Extension filter
    if (allowedExtensions) {
      const ext = path.extname(entryName).toLowerCase();
      if (!allowedExtensions.includes(ext)) continue;
    }

    // Path safety check
    const targetPath = validateEntryPath(entryName, resolvedDest);

    // Size limit check
    totalBytes += uncompressedSize;
    if (totalBytes > maxTotalBytes) {
      throw new ZipSafetyError(`Total uncompressed size exceeds limit: ${maxTotalBytes} bytes`);
    }

    // Extract
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    const compressedData = buf.subarray(dataOffset, dataOffset + compressedSize);
    let content: Buffer;
    if (compressionMethod === 0) {
      // Stored (no compression)
      content = Buffer.from(compressedData);
    } else if (compressionMethod === 8) {
      // Deflate
      content = zlib.inflateRawSync(compressedData);
    } else {
      throw new ZipSafetyError(`Unsupported compression method ${compressionMethod} for entry "${entryName}"`);
    }

    fs.writeFileSync(targetPath, content);
  }
}
