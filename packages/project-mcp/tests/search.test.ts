import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectFileSearch, projectFileSearchSchema } from '../src/search.js';
import { projectTextRead } from '../src/text.js';

const roots: string[] = [];
function fixture(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-search-')));
  roots.push(root);
  return root;
}
function write(root: string, name: string, content: string | Buffer): void {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('project literal text search', () => {
  it('searches real UTF-8 text, TeX and code across selected directories with exact source locators', () => {
    const root = fixture();
    const tex = 'before\r\n😀α target target \\frac{x}{y}\r\nafter\r\n';
    write(root, 'notes/研究.tex', tex);
    write(root, 'src/calc.py', '# note\nvalue = "target"\n');
    write(root, 'other/ignored.txt', 'target\n');
    const result = projectFileSearch(root, { query: 'target', paths: ['src', 'notes'], context_lines: 1 });
    expect(result.mode).toBe('literal');
    expect(result.case_sensitive).toBe(true);
    expect(result.matched_lines).toBe(2);
    expect(result.matched_occurrences).toBe(3);
    expect(result.matches.map(match => match.path)).toEqual(['notes/研究.tex', 'src/calc.py']);
    expect(result.matches[0]).toMatchObject({
      path: 'notes/研究.tex', sha256: hash(tex), line_number: 2, column: 4, occurrences: 2,
      context: [
        { line_number: 1, text: 'before', start_column: 1, truncated: false },
        { line_number: 2, text: '😀α target target \\frac{x}{y}', start_column: 1, truncated: false },
        { line_number: 3, text: 'after', start_column: 1, truncated: false },
      ],
    });
    expect(result.coverage).toMatchObject({ complete: true, truncated: false, files_scanned: 2, skipped_count: 0, error_count: 0 });
    expect(result.next_offset).toBeNull();
  });

  it('uses literal case-sensitive matching and counts non-overlapping occurrences', () => {
    const root = fixture();
    write(root, 'regex.txt', 'a+b.*[x] a+b.*[x]\nA+B.*[X]\naaaa\n');
    const literal = projectFileSearch(root, { query: 'a+b.*[x]' });
    expect(literal.matched_lines).toBe(1);
    expect(literal.matched_occurrences).toBe(2);
    expect(projectFileSearch(root, { query: 'aa' }).matched_occurrences).toBe(2);
  });

  it.each(['\n', '\r\n', '\r'])('round-trips search locations into text reading with %j newlines', ending => {
    const root = fixture();
    for (const trailing of [false, true]) {
      const content = `first${ending}😀 needle${ending}last${trailing ? ending : ''}`;
      write(root, 'source.tex', content);
      const found = projectFileSearch(root, { query: 'needle', context_lines: 3 });
      const match = found.matches[0]!;
      expect(match).toMatchObject({ line_number: 2, column: 3, sha256: hash(content) });
      expect(match.context.map(line => line.line_number)).toEqual([1, 2, 3]);
      const read = projectTextRead(root, {
        path: match.path, start_line: match.line_number, start_column: match.column,
        expected_sha256: match.sha256, max_lines: 1, max_chars: 6,
      });
      expect(read.lines).toEqual([{ line_number: 2, column_start: 3, text: 'needle', complete: true }]);
      expect(read.total_lines).toBe(3);
      expect(read.column_unit).toBe(found.column_unit);
    }
  });

  it('deduplicates overlapping selectors and accepts an explicit file', () => {
    const root = fixture();
    write(root, 'notes/a.txt', 'needle\n');
    write(root, 'notes/b.txt', 'needle\n');
    const result = projectFileSearch(root, { query: 'needle', paths: ['notes/a.txt', 'notes', 'notes/a.txt'] });
    expect(result.matched_lines).toBe(2);
    expect(result.coverage.files_scanned).toBe(2);
    expect(projectFileSearch(root, { query: 'needle', paths: ['notes/a.txt'] }).matches).toHaveLength(1);
  });

  it('pages matching lines with a whole-selection hash and permits a different page size', () => {
    const root = fixture();
    write(root, 'a.txt', 'needle\nneedle\n');
    write(root, 'nested/b.txt', 'needle\nneedle\n');
    const first = projectFileSearch(root, { query: 'needle', max_matches: 1 });
    expect(first.matched_lines).toBe(4);
    expect(first.matches).toHaveLength(1);
    expect(first.next_offset).toBe(1);
    expect(first.page_truncated).toBe(true);
    const second = projectFileSearch(root, { query: 'needle', max_matches: 3, offset: first.next_offset!, expected_snapshot_sha256: first.snapshot_sha256 });
    expect(second.matches.map(match => [match.path, match.line_number])).toEqual([['a.txt', 2], ['nested/b.txt', 1], ['nested/b.txt', 2]]);
    expect(second.snapshot_sha256).toBe(first.snapshot_sha256);
    expect(second.next_offset).toBeNull();
    const end = projectFileSearch(root, { query: 'needle', offset: 4, expected_snapshot_sha256: first.snapshot_sha256 });
    expect(end.matches).toEqual([]);
    expect(() => projectFileSearch(root, { query: 'needle', offset: 5, expected_snapshot_sha256: first.snapshot_sha256 })).toThrow('beyond');
  });

  it.each(['matching_source', 'nonmatching_source', 'new_file', 'deleted_file', 'query', 'scope'])('rejects continuation after %s changes', kind => {
    const root = fixture();
    write(root, 'a.txt', 'needle\nneedle\n');
    write(root, 'b.txt', 'other\n');
    const first = projectFileSearch(root, { query: 'needle', max_matches: 1 });
    if (kind === 'matching_source') write(root, 'a.txt', 'needle\nchanged\n');
    if (kind === 'nonmatching_source') write(root, 'b.txt', 'changed\n');
    if (kind === 'new_file') write(root, 'c.txt', 'needle\n');
    if (kind === 'deleted_file') fs.unlinkSync(path.join(root, 'b.txt'));
    expect(() => projectFileSearch(root, {
      query: kind === 'query' ? 'other' : 'needle', paths: kind === 'scope' ? ['a.txt'] : ['.'],
      offset: first.next_offset!, expected_snapshot_sha256: first.snapshot_sha256,
    })).toThrow('changed');
  });

  it('binds the root as well as identical content and rejects unbound offsets', () => {
    const root = fixture();
    const other = fixture();
    for (const value of [root, other]) write(value, 'a.txt', 'needle\nneedle\n');
    const first = projectFileSearch(root, { query: 'needle', max_matches: 1 });
    expect(() => projectFileSearch(other, { query: 'needle', offset: 1, expected_snapshot_sha256: first.snapshot_sha256 })).toThrow('changed');
    expect(() => projectFileSearch(root, { query: 'needle', offset: 1 })).toThrow('Continuation');
  });

  it('excludes hidden state, credential files, delegated journals and both live and dangling symlinks', () => {
    const root = fixture();
    const outside = fixture();
    write(root, 'safe.txt', 'needle');
    for (const name of ['.env', '.nullius/state.json', '.nullius/HARNESS', 'nested/.private.txt', 'credentials.PEM', 'Artifacts/delegated-runs/run/secret.txt']) write(root, name, 'TOP_SECRET needle');
    write(outside, 'outside.txt', 'TOP_SECRET needle');
    fs.symlinkSync(path.join(outside, 'outside.txt'), path.join(root, 'linked.txt'));
    fs.symlinkSync(outside, path.join(root, 'linked-dir'), 'dir');
    fs.symlinkSync(path.join(outside, 'missing.txt'), path.join(root, 'dangling.txt'));
    const result = projectFileSearch(root, { query: 'needle' });
    expect(result.matches.map(match => match.path)).toEqual(['safe.txt']);
    expect(result.coverage.skipped_count).toBeGreaterThanOrEqual(6);
    expect(result.coverage.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain('TOP_SECRET');
    for (const name of ['.nullius/state.json', 'credentials.PEM', 'Artifacts/delegated-runs', 'linked.txt', 'linked-dir/outside.txt', 'dangling.txt']) {
      expect(() => projectFileSearch(root, { query: 'needle', paths: [name] }), name).toThrow();
    }
    for (const name of ['../escape.txt', path.join(outside, 'outside.txt'), 'nested\\file.txt', 'bad\0path']) {
      expect(() => projectFileSearch(root, { query: 'needle', paths: [name] }), name).toThrow();
    }
  });

  it('reports binary formats/content and invalid UTF-8 instead of searching replacement text', () => {
    const root = fixture();
    write(root, 'a.pdf', '%PDF-1.0 needle');
    write(root, 'b.bin', Buffer.from('needle\0hidden'));
    write(root, 'c.txt', Buffer.from([0xff, ...Buffer.from('needle')]));
    write(root, 'd.tex', '\\alpha = needle');
    const result = projectFileSearch(root, { query: 'needle' });
    expect(result.matches.map(match => match.path)).toEqual(['d.tex']);
    expect(result.coverage.skipped.map(value => value.reason)).toEqual(['binary_format', 'binary_content', 'invalid_utf8']);
    expect(result.coverage.complete).toBe(false);
  });

  it('reports missing sources as errors and makes no global absence claim', () => {
    const root = fixture();
    write(root, 'a.txt', 'different');
    const result = projectFileSearch(root, { query: 'needle', paths: ['a.txt', 'missing'] });
    expect(result.matches).toEqual([]);
    expect(result.coverage.error_count).toBe(1);
    expect(result.coverage.errors[0]).toMatchObject({ path: 'missing', reason: 'enumeration_error' });
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.no_match_meaning).toContain('unscanned material remains unknown');
  });

  it.skipIf(process.platform === 'win32')('does not open a special file as text or block on a FIFO', () => {
    const root = fixture();
    const created = spawnSync('mkfifo', [path.join(root, 'pipe.txt')]);
    expect(created.error).toBeUndefined();
    expect(created.status).toBe(0);
    const result = projectFileSearch(root, { query: 'needle' });
    expect(result.coverage.skipped).toContainEqual({ path: 'pipe.txt', reason: 'non_regular' });
    expect(result.coverage.bytes_read).toBe(0);
    expect(result.coverage.complete).toBe(false);
  });

  it('rejects a previously selected source replaced by a symlink before pagination', () => {
    const root = fixture();
    const outside = fixture();
    write(root, 'a.txt', 'needle\nneedle\n');
    write(outside, 'private.txt', 'SECRET needle\n');
    const first = projectFileSearch(root, { query: 'needle', max_matches: 1 });
    fs.unlinkSync(path.join(root, 'a.txt'));
    fs.symlinkSync(path.join(outside, 'private.txt'), path.join(root, 'a.txt'));
    expect(() => projectFileSearch(root, { query: 'needle', offset: 1, expected_snapshot_sha256: first.snapshot_sha256 })).toThrow('changed');
    expect(JSON.stringify(projectFileSearch(root, { query: 'needle' }))).not.toContain('SECRET');
  });

  it('reports file, byte and per-file limits separately and does not issue a false exhaustive continuation', () => {
    const root = fixture();
    write(root, 'a.txt', 'needle\nneedle\n');
    write(root, 'b.txt', 'needle\n');
    const files = projectFileSearch(root, { query: 'needle', max_files: 1, max_matches: 1 });
    expect(files.coverage).toMatchObject({ truncated: true, files_selected: 1, complete: false });
    expect(files.coverage.limits_reached).toContain('max_files');
    expect(files.next_offset).toBeNull();
    const total = projectFileSearch(root, { query: 'needle', max_total_bytes: 14, max_matches: 1 });
    expect(total.coverage.bytes_read).toBe(14);
    expect(total.coverage.limits_reached).toContain('max_total_bytes');
    expect(total.next_offset).toBeNull();
    const perFile = projectFileSearch(root, { query: 'needle', max_file_bytes: 8 });
    expect(perFile.matches.map(match => match.path)).toEqual(['b.txt']);
    expect(perFile.coverage.skipped[0]).toMatchObject({ path: 'a.txt', reason: 'max_file_bytes' });
    expect(perFile.coverage.limits_reached).toContain('max_file_bytes');
    expect(perFile.coverage.complete).toBe(false);
  });

  it('can read an empty file after exhausting the byte allowance exactly', () => {
    const root = fixture();
    write(root, 'a.txt', 'needle');
    write(root, 'z.txt', '');
    const result = projectFileSearch(root, { query: 'needle', max_total_bytes: 6 });
    expect(result.coverage).toMatchObject({ bytes_read: 6, files_scanned: 2, complete: true, error_count: 0 });
  });

  it('stops at the time budget with explicit incomplete coverage', () => {
    const root = fixture();
    write(root, 'a.txt', 'needle');
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time++ * 10);
    const result = projectFileSearch(root, { query: 'needle', timeout_ms: 1 });
    expect(result.coverage).toMatchObject({ complete: false, truncated: true, bytes_read: 0 });
    expect(result.coverage.limits_reached).toContain('timeout_ms');
    expect(result.next_offset).toBeNull();
  });

  it('bounds long Unicode context without splitting surrogate pairs and keeps precise positions', () => {
    const root = fixture();
    const prefix = '😀'.repeat(2500);
    write(root, 'a.txt', `${prefix}needle${'文'.repeat(5000)}\n`);
    const result = projectFileSearch(root, { query: 'needle', context_lines: 0 });
    const match = result.matches[0]!;
    expect(match.column).toBe(2501);
    expect(match.context[0]!.start_column).toBe(2401);
    expect(match.context[0]!.truncated).toBe(true);
    expect(match.context[0]!.text.length).toBeLessThanOrEqual(1600);
    expect(match.context[0]!.text).toContain('needle');
    expect(Buffer.from(match.context[0]!.text, 'utf8').toString('utf8')).toBe(match.context[0]!.text);
  });

  it('bounds page context bytes and resumes with forward progress', () => {
    const root = fixture();
    write(root, 'a.txt', Array.from({ length: 50 }, () => `${'文'.repeat(1550)}needle`).join('\n'));
    const first = projectFileSearch(root, { query: 'needle', context_lines: 3, max_matches: 100 });
    expect(first.page_limit).toBe('max_page_bytes');
    expect(first.matches.length).toBeGreaterThan(0);
    expect(first.next_offset).toBe(first.matches.length);
    expect(Buffer.byteLength(JSON.stringify(first.matches))).toBeLessThan(66000);
    const next = projectFileSearch(root, { query: 'needle', context_lines: 0, offset: first.next_offset!, expected_snapshot_sha256: first.snapshot_sha256 });
    expect(next.matches[0]!.line_number).toBe(first.matches.length + 1);
  });

  it.each([
    { query: '' }, { query: 'two\nlines' }, { query: 'x', paths: [] },
    { query: 'x', regex: true }, { query: 'x', max_files: 0 },
    { query: 'x', max_file_bytes: 9000000 }, { query: 'x', timeout_ms: 30001 },
    { query: 'x', offset: -1 }, { query: 'x', expected_snapshot_sha256: 'not-a-hash' },
  ])('rejects invalid or unsupported options: %j', input => {
    expect(projectFileSearchSchema.safeParse(input).success).toBe(false);
  });
});
