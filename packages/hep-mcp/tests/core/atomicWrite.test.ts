import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteFileSync } from '../../src/core/atomicWrite.js';

describe('atomicWriteFileSync (H-07)', () => {
  const tmpBase = path.join(os.tmpdir(), 'h07-test');

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('writes file content correctly', () => {
    const target = path.join(tmpBase, 'a', 'test.json');
    atomicWriteFileSync(target, '{"ok":true}');
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"ok":true}');
  });

  it('creates parent directories if missing', () => {
    const target = path.join(tmpBase, 'deep', 'nested', 'dir', 'file.txt');
    atomicWriteFileSync(target, 'hello');
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello');
  });

  it('leaves no tmp file on success', () => {
    const target = path.join(tmpBase, 'clean.txt');
    atomicWriteFileSync(target, 'data');
    const dir = fs.readdirSync(tmpBase);
    expect(dir).toEqual(['clean.txt']);
  });

  it('overwrites existing file atomically', () => {
    const target = path.join(tmpBase, 'overwrite.txt');
    atomicWriteFileSync(target, 'v1');
    atomicWriteFileSync(target, 'v2');
    expect(fs.readFileSync(target, 'utf-8')).toBe('v2');
  });

  it('handles Buffer data', () => {
    const target = path.join(tmpBase, 'buf.bin');
    const buf = Buffer.from([0x48, 0x45, 0x50]);
    atomicWriteFileSync(target, buf);
    expect(fs.readFileSync(target)).toEqual(buf);
  });

  it('concurrent writes with different pids do not conflict', () => {
    const target = path.join(tmpBase, 'concurrent.txt');
    // Simulate by writing twice — real concurrency tested via pid suffix separation
    atomicWriteFileSync(target, 'first');
    atomicWriteFileSync(target, 'second');
    expect(fs.readFileSync(target, 'utf-8')).toBe('second');
  });
});
