import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { invalidParams } from '@nullius/shared';
import { filePath } from './paths.js';

/** One bounded snapshot, shared by content tools. The returned hash names these bytes. */
export function readProjectBytes(root: string, value: string, maxBytes = 64 * 1024 * 1024) {
  const target = filePath(root, value, false);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw invalidParams('Invalid source byte limit.');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) {
      throw invalidParams('Content tools require a regular file within the source byte limit.', { max_bytes: maxBytes });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, maxBytes + 1 - size));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      chunks.push(chunk.subarray(0, count));
      size += count;
    }
    if (size > maxBytes) throw invalidParams('Source grew beyond the byte limit during reading.');
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw invalidParams('Source changed during reading; read the current source again.');
    }
    const bytes = Buffer.concat(chunks, size);
    return {
      path: path.relative(root, target).split(path.sep).join('/'),
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size,
    };
  } finally { fs.closeSync(fd); }
}

export function readStrictUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw invalidParams('Source is not valid UTF-8; use the binary file or document tool.'); }
}

/** Common source locators: CRLF, CR and LF delimit lines; a terminal delimiter adds no line. */
export function splitSourceLines(text: string): string[] {
  const lines = text ? text.split(/\r\n|\r|\n/u) : [];
  if (/(?:\r\n|\r|\n)$/u.test(text)) lines.pop();
  return lines;
}
