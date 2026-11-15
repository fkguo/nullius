import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { projectTextRead, TEXT_SOURCE_MAX_BYTES } from '../src/text.js';
import { readProjectBytes } from '../src/content.js';

const roots: string[] = [];
function fixture(text: string | Buffer = 'first\nalpha = 2\nlast\n') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-text-')));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'source.tex'), text);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('source text windows', () => {
  it('locates exact lines and binds the continuation to the bytes read', () => {
    const root = fixture();
    const read = projectTextRead(root, { path: 'source.tex', start_line: 2, max_lines: 1 });
    expect(read.lines).toEqual([{ line_number: 2, column_start: 1, text: 'alpha = 2', complete: true }]);
    expect(read.total_lines).toBe(3);
    expect(read.next).toEqual({ path: 'source.tex', start_line: 3, start_column: 1, expected_sha256: read.sha256 });
    expect(projectTextRead(root, read.next!).lines[0]!.text).toBe('last');
    fs.writeFileSync(path.join(root, 'source.tex'), 'changed\n');
    expect(() => projectTextRead(root, read.next!)).toThrow(/hash changed/);
  });

  it('continues within a long Unicode line without losing or splitting characters', () => {
    const root = fixture('α🙂中文Z\r\nnext\r\n');
    const first = projectTextRead(root, { path: 'source.tex', max_chars: 3 });
    expect(first.lines[0]).toEqual({ line_number: 1, column_start: 1, text: 'α🙂中', complete: false });
    expect(first.next?.start_column).toBe(4);
    const rest = projectTextRead(root, { ...first.next!, max_chars: 10 });
    expect(rest.lines.map(line => line.text)).toEqual(['文Z', 'next']);
    expect(rest.next).toBeNull();
  });

  it('handles empty lines and empty files and rejects invalid positions', () => {
    const root = fixture('\n\nx');
    expect(projectTextRead(root, { path: 'source.tex', max_lines: 2 }).lines.map(line => line.text)).toEqual(['', '']);
    expect(() => projectTextRead(root, { path: 'source.tex', start_line: 4 })).toThrow(/beyond/);
    expect(() => projectTextRead(root, { path: 'source.tex', start_line: 3, start_column: 3 })).toThrow(/beyond/);
    fs.writeFileSync(path.join(root, 'source.tex'), '');
    expect(projectTextRead(root, { path: 'source.tex' })).toMatchObject({ total_lines: 0, lines: [], truncated: false, next: null });
  });

  it('rejects binary/invalid UTF-8 and overlarge files without replacing unreadable bytes', () => {
    const root = fixture(Buffer.from([0xc3, 0x28]));
    expect(() => projectTextRead(root, { path: 'source.tex' })).toThrow(/valid UTF-8/);
    fs.writeFileSync(path.join(root, 'source.tex'), Buffer.from([0, 65]));
    expect(() => projectTextRead(root, { path: 'source.tex' })).toThrow(/binary/);
    fs.truncateSync(path.join(root, 'source.tex'), TEXT_SOURCE_MAX_BYTES + 1);
    expect(() => projectTextRead(root, { path: 'source.tex' })).toThrow(/byte limit/);
  });

  it('keeps reads inside regular, visible project files', () => {
    const root = fixture();
    for (const value of ['../outside', '.env', 'credential.pem']) {
      expect(() => projectTextRead(root, { path: value })).toThrow();
    }
    fs.symlinkSync(path.join(root, 'source.tex'), path.join(root, 'alias.tex'));
    expect(() => projectTextRead(root, { path: 'alias.tex' })).toThrow(/Symlinks/);
    fs.mkdirSync(path.join(root, 'directory'));
    expect(() => readProjectBytes(root, 'directory')).toThrow(/regular file/);
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer', () => {
    const root = fixture();
    execFileSync('mkfifo', [path.join(root, 'pipe')]);
    expect(() => readProjectBytes(root, 'pipe')).toThrow(/regular file/);
  });
});
