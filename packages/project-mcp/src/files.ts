import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { invalidParams, writeBytesAtomicDurable } from '@nullius/shared';
import { filePath } from './paths.js';
import { acquireExecution, releaseExecution } from './execution-lock.js';
import { readProjectBytes } from './content.js';

const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
export function readFile(root: string, value: string, offset: number, maxBytes: number) {
  const source = readProjectBytes(root, value);
  if (offset > source.size) throw invalidParams('Offset is beyond the file.');
  const end = Math.min(offset + maxBytes, source.size);
  return { path: source.path, encoding: 'base64', data: source.bytes.subarray(offset, end).toString('base64'), sha256: source.sha256, size: source.size, offset, next_offset: end < source.size ? end : null };
}
export function writeFile(root: string, value: string, content: string, expected: string | null) {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > 1024 * 1024) throw invalidParams('Each upload is limited to 1 MiB.');
  const owner = `file-${randomUUID()}`;
  acquireExecution(root, owner);
  try {
    const target = filePath(root, value, true);
    const compare = () => {
      filePath(root, value, true);
      let current: string | null = null;
      try {
        const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw invalidParams('Not a supported regular file.');
          current = hash(fs.readFileSync(fd));
        } finally { fs.closeSync(fd); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (current !== expected) throw invalidParams('File changed or already exists; read its hash before replacing it.');
    };
    compare();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeBytesAtomicDurable(target, bytes, undefined, compare);
    return { path: path.relative(root, target), sha256: hash(bytes), size: bytes.length };
  } finally { releaseExecution(root, owner); }
}
