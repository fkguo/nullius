import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { safeExtractZip, ZipSafetyError } from '../../src/core/sandbox.js';
import { PDF_RESOURCE_LIMITS } from '@autoresearch/shared';

// ── ZIP builder helpers ──────────────────────────────────────────────────

function buildZipBuffer(entries: Array<{ name: string; data: Buffer; compress?: boolean }>): Buffer {
  const parts: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8');
    const compress = entry.compress ?? false;
    const compressed = compress ? zlib.deflateRawSync(entry.data) : entry.data;
    const method = compress ? 8 : 0;

    // Local file header
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // signature
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(method, 8); // compression
    header.writeUInt16LE(0, 10); // mod time
    header.writeUInt16LE(0, 12); // mod date
    header.writeUInt32LE(0, 14); // crc32 (not checked in our impl)
    header.writeUInt32LE(compressed.length, 18); // compressed size
    header.writeUInt32LE(entry.data.length, 22); // uncompressed size
    header.writeUInt16LE(nameBuf.length, 26); // file name length
    header.writeUInt16LE(0, 28); // extra field length

    parts.push(header, nameBuf, compressed);

    // Central directory entry
    const cdEntry = Buffer.alloc(46);
    cdEntry.writeUInt32LE(0x02014b50, 0);
    cdEntry.writeUInt16LE(20, 4);
    cdEntry.writeUInt16LE(20, 6);
    cdEntry.writeUInt16LE(0, 8);
    cdEntry.writeUInt16LE(method, 10);
    cdEntry.writeUInt16LE(0, 12);
    cdEntry.writeUInt16LE(0, 14);
    cdEntry.writeUInt32LE(0, 16);
    cdEntry.writeUInt32LE(compressed.length, 20);
    cdEntry.writeUInt32LE(entry.data.length, 24);
    cdEntry.writeUInt16LE(nameBuf.length, 28);
    cdEntry.writeUInt16LE(0, 30);
    cdEntry.writeUInt16LE(0, 32);
    cdEntry.writeUInt16LE(0, 34);
    cdEntry.writeUInt16LE(0, 36);
    cdEntry.writeUInt32LE(0, 38);
    cdEntry.writeUInt32LE(offset, 42);
    centralDir.push(cdEntry, nameBuf);

    offset += 30 + nameBuf.length + compressed.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of centralDir) cdSize += c.length;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, ...centralDir, eocd]);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('safeExtractZip (H-12)', () => {
  const tmpBase = path.join(os.tmpdir(), 'h12-test');

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('extracts a normal zip correctly', () => {
    const zip = buildZipBuffer([
      { name: 'hello.txt', data: Buffer.from('Hello World') },
      { name: 'sub/deep.txt', data: Buffer.from('nested'), compress: true },
    ]);
    const zipPath = path.join(tmpBase, 'normal.zip');
    fs.mkdirSync(tmpBase, { recursive: true });
    fs.writeFileSync(zipPath, zip);

    const dest = path.join(tmpBase, 'out');
    safeExtractZip(zipPath, dest);

    expect(fs.readFileSync(path.join(dest, 'hello.txt'), 'utf-8')).toBe('Hello World');
    expect(fs.readFileSync(path.join(dest, 'sub', 'deep.txt'), 'utf-8')).toBe('nested');
  });

  it('rejects Zip Slip path (../)', () => {
    const zip = buildZipBuffer([
      { name: '../../../etc/passwd', data: Buffer.from('evil') },
    ]);
    const zipPath = path.join(tmpBase, 'slip.zip');
    fs.mkdirSync(tmpBase, { recursive: true });
    fs.writeFileSync(zipPath, zip);

    const dest = path.join(tmpBase, 'out');
    expect(() => safeExtractZip(zipPath, dest)).toThrow(ZipSafetyError);
    expect(() => safeExtractZip(zipPath, dest)).toThrow(/traversal/i);
  });

  it('rejects entries with .. in name', () => {
    const zip = buildZipBuffer([
      { name: 'sub/../escape.txt', data: Buffer.from('sneaky') },
    ]);
    const zipPath = path.join(tmpBase, 'dotdot.zip');
    fs.mkdirSync(tmpBase, { recursive: true });
    fs.writeFileSync(zipPath, zip);

    const dest = path.join(tmpBase, 'out');
    expect(() => safeExtractZip(zipPath, dest)).toThrow(ZipSafetyError);
  });

  it('enforces file count limit', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      name: `file${i}.txt`,
      data: Buffer.from(`content${i}`),
    }));
    const zip = buildZipBuffer(entries);
    const zipPath = path.join(tmpBase, 'many.zip');
    fs.mkdirSync(tmpBase, { recursive: true });
    fs.writeFileSync(zipPath, zip);

    const dest = path.join(tmpBase, 'out');
    expect(() => safeExtractZip(zipPath, dest, { maxFileCount: 3 })).toThrow(ZipSafetyError);
    expect(() => safeExtractZip(zipPath, dest, { maxFileCount: 3 })).toThrow(/count/i);
  });

  it('enforces total size limit', () => {
    const bigData = Buffer.alloc(1024, 'A');
    const zip = buildZipBuffer([
      { name: 'big.txt', data: bigData },
    ]);
    const zipPath = path.join(tmpBase, 'big.zip');
    fs.mkdirSync(tmpBase, { recursive: true });
    fs.writeFileSync(zipPath, zip);

    const dest = path.join(tmpBase, 'out');
    expect(() => safeExtractZip(zipPath, dest, { maxTotalBytes: 512 })).toThrow(ZipSafetyError);
    expect(() => safeExtractZip(zipPath, dest, { maxTotalBytes: 512 })).toThrow(/size/i);
  });

  it('ZipSafetyError has code RESOURCE_LIMIT', () => {
    const err = new ZipSafetyError('test');
    expect(err.code).toBe('RESOURCE_LIMIT');
    expect(err.name).toBe('ZipSafetyError');
  });
});

describe('PDF_RESOURCE_LIMITS (H-12)', () => {
  it('is importable from @autoresearch/shared', () => {
    expect(PDF_RESOURCE_LIMITS.maxPageCount).toBe(800);
    expect(PDF_RESOURCE_LIMITS.maxFileSizeMB).toBe(100);
    expect(PDF_RESOURCE_LIMITS.timeoutMs).toBe(60_000);
  });
});
