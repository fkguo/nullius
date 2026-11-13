import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOCUMENT_LIMITS, documentCapabilities, documentReadSchema, readDocument, type DocumentResult } from '../src/documents.js';

const roots: string[] = [];
const originalPath = process.env.PATH ?? '';
function directory() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-documents-')));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** An actual cross-reference PDF with text and/or a raster-only page; no PDF library needed. */
function pdf(pageTexts: Array<string | null>) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageTexts.map((_, index) => `${5 + 2 * index} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nabc\nendstream',
  ];
  for (const text of pageTexts) {
    const content = text === null ? 'q 150 0 0 150 20 20 cm /Scan Do Q'
      : `BT /F1 16 Tf 20 180 Td (${text.replace(/[\\()]/g, character => `\\${character}`)}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> /XObject << /Scan 4 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let result = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(`${result}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`);
}
function fixture(pageTexts = ['First page research input', 'Second page independent evidence'] as Array<string | null>) {
  const root = directory();
  const bytes = pdf(pageTexts);
  fs.writeFileSync(path.join(root, 'paper.pdf'), bytes);
  return { root, bytes };
}
type Reply = {
  status: string; total_pages: number; sha256: string; size: number; truncated: boolean;
  next_start_page: number | null; reading_method: string; reading_scope: string; ocr_performed: boolean;
  next: Parameters<typeof readDocument>[1] | null;
  pages: Array<{ page: number; text: string; text_status: string; truncated: boolean; image?: { content_index: number; width: number; height: number; bytes: number; sha256: string } }>;
};
function body(result: DocumentResult): Reply {
  const text = result.content[0]!;
  if (text.type !== 'text') throw new Error('Expected metadata before images.');
  return JSON.parse(text.text) as Reply;
}
function findExecutable(name: string) {
  for (const item of originalPath.split(path.delimiter)) {
    const candidate = path.join(item, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    catch { /* Continue to the next PATH directory. */ }
  }
  return undefined;
}
const realPrograms = { pdfinfo: findExecutable('pdfinfo'), pdftotext: findExecutable('pdftotext'), pdftoppm: findExecutable('pdftoppm') };
const hasPoppler = Object.values(realPrograms).every(program => program && spawnSync(program, ['-v'], { timeout: 2000 }).status === 0);
function executables(programs: Record<string, string>, appendOriginalPath = false) {
  const root = directory();
  for (const [name, source] of Object.entries(programs)) {
    fs.writeFileSync(path.join(root, name), `#!${process.execPath}\n${source}`, { mode: 0o700 });
  }
  vi.stubEnv('PATH', appendOriginalPath ? `${root}${path.delimiter}${originalPath}` : root);
  return root;
}
function forward(tool: keyof typeof realPrograms, beforeDispatch = '') {
  return `const fs = require('node:fs'); const { spawnSync } = require('node:child_process');
const chunks = []; process.stdin.on('data', chunk => chunks.push(chunk)); process.stdin.on('end', () => {
  const bytes = Buffer.concat(chunks); ${beforeDispatch}
  const child = spawnSync(${JSON.stringify(realPrograms[tool])}, process.argv.slice(2), {
    input: bytes, env: { ...process.env, PATH: ${JSON.stringify(originalPath)} }, maxBuffer: 8 * 1024 * 1024,
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  process.exitCode = child.status ?? 1;
});`;
}
const fakeInfo = "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('Pages: 2\\n'));";
const fakeText = "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('text'));";

describe.skipIf(!hasPoppler)('real Poppler PDF content', () => {
  it('extracts selected pages with stable source identity and no full-document/OCR claim', async () => {
    const { root, bytes } = fixture();
    const result = await readDocument(root, { path: 'paper.pdf', start_page: 2 });
    const data = body(result);
    expect(data).toMatchObject({
      status: 'read', total_pages: 2, size: bytes.length, truncated: false,
      sha256: createHash('sha256').update(bytes).digest('hex'), next_start_page: null,
      reading_method: 'text_extraction', reading_scope: 'selected_pages', ocr_performed: false,
    });
    expect(data.pages).toEqual([{ page: 2, text: 'Second page independent evidence', extracted_characters: 32, text_start_character: 1, returned_characters: 32, text_status: 'extracted', truncated: false }]);
    expect(result.structuredContent).toEqual(data);
    expect(result.content).toHaveLength(1);
    expect(body(await readDocument(root, { path: 'paper.pdf' })).next_start_page).toBe(2);
  });

  it('returns actual bounded PNG image blocks with per-page mapping and hashes', async () => {
    const { root } = fixture();
    const result = await readDocument(root, { path: 'paper.pdf', end_page: 2, include_images: true });
    const data = body(result);
    expect(result.content).toHaveLength(3);
    for (const page of data.pages) {
      const image = result.content[page.image!.content_index]!;
      expect(image.type).toBe('image');
      if (image.type !== 'image') throw new Error('Missing PNG.');
      const png = Buffer.from(image.data, 'base64');
      expect(image.mimeType).toBe('image/png');
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.toString('ascii', png.length - 8, png.length - 4)).toBe('IEND');
      expect(page.image).toMatchObject({ width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') });
      expect(Math.max(page.image!.width, page.image!.height)).toBeLessThanOrEqual(DOCUMENT_LIMITS.image_max_edge);
      expect(png.length).toBeLessThanOrEqual(DOCUMENT_LIMITS.image_bytes_per_page);
    }
  });

  it('marks a raster-only page as lacking extractable text while providing its image', async () => {
    const { root } = fixture([null, 'Text page']);
    const result = await readDocument(root, { path: 'paper.pdf', include_images: true });
    expect(body(result)).toMatchObject({ ocr_performed: false, pages: [{ page: 1, text: '', text_status: 'no_extractable_text', truncated: false }] });
    expect(result.content[1]!.type).toBe('image');
  });

  it('enforces an aggregate character budget across pages without hiding truncation', async () => {
    const { root } = fixture(['ABCDEFGHIJKLMNO', 'Second page']);
    const data = body(await readDocument(root, { path: 'paper.pdf', end_page: 2, max_chars: 10 }));
    expect(data.pages.map(page => page.text)).toEqual(['ABCDEFGHIJ', '']);
    expect(data.pages.every(page => page.truncated)).toBe(true);
    expect(data.pages[1]!.text_status).toBe('extracted');
    expect(data.truncated).toBe(true);
    expect(data.next_start_page).toBe(1);
    expect(data.next).toMatchObject({ start_page: 1, start_character: 11, expected_sha256: data.sha256, max_chars: 10, include_images: false });
    const remainder = body(await readDocument(root, data.next!));
    expect(remainder.pages[0]!.text).toBe('KLMNO');
    expect(remainder.next).toMatchObject({ start_page: 2, start_character: 1, expected_sha256: data.sha256 });
    const secondPage = body(await readDocument(root, remainder.next!));
    expect(secondPage.pages[0]!.text).toBe('Second pag');
    expect(secondPage.next).toMatchObject({ start_page: 2, start_character: 11 });
    expect(body(await readDocument(root, secondPage.next!)).pages[0]!.text).toBe('e');
  });

  it('binds continuation to the source bytes and refuses a changed document', async () => {
    const { root } = fixture();
    const first = body(await readDocument(root, { path: 'paper.pdf' }));
    expect(first.next).toMatchObject({ path: 'paper.pdf', start_page: 2, expected_sha256: first.sha256 });
    fs.appendFileSync(path.join(root, 'paper.pdf'), '\n% source changed\n');
    executables({});
    await expect(readDocument(root, first.next!)).rejects.toThrow('Document changed');
  });

  it('uses the same stdin snapshot for every subprocess after the source is deleted', async () => {
    const { root, bytes } = fixture();
    const log = path.join(root, 'observations.jsonl');
    const record = (tool: string) => `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: ${JSON.stringify(tool)}, args: process.argv.slice(2), hash: require('node:crypto').createHash('sha256').update(bytes).digest('hex') }) + '\\n');`;
    executables({
      pdfinfo: forward('pdfinfo', `${record('pdfinfo')} fs.unlinkSync(${JSON.stringify(path.join(root, 'paper.pdf'))});`),
      pdftotext: forward('pdftotext', record('pdftotext')),
      pdftoppm: forward('pdftoppm', record('pdftoppm')),
    });
    const data = body(await readDocument(root, { path: 'paper.pdf', end_page: 2, include_images: true }));
    expect(data.pages.map(page => page.text)).toEqual(['First page research input', 'Second page independent evidence']);
    expect(fs.existsSync(path.join(root, 'paper.pdf'))).toBe(false);
    const observed = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { tool: string; args: string[]; hash: string });
    expect(observed).toHaveLength(5);
    expect(new Set(observed.map(call => call.hash))).toEqual(new Set([createHash('sha256').update(bytes).digest('hex')]));
    for (const call of observed) {
      expect(call.args.at(-1)).toBe('-');
      expect(call.args.join(' ')).not.toContain(root);
    }
  });

  it('reports installed dependencies and rejects malformed PDFs and out-of-range pages', async () => {
    expect(await documentCapabilities()).toMatchObject({ text_extraction: 'available', page_images: 'available', ocr: 'unavailable' });
    const { root } = fixture();
    await expect(readDocument(root, { path: 'paper.pdf', start_page: 3 })).rejects.toThrow('exceeds');
    fs.writeFileSync(path.join(root, 'broken.pdf'), '%PDF-1.4\ninvalid cross-reference');
    await expect(readDocument(root, { path: 'broken.pdf' })).rejects.toThrow('could not read this PDF');
  });

  it('keeps text extraction available when optional image rendering is missing', async () => {
    const { root } = fixture();
    executables({ pdfinfo: forward('pdfinfo'), pdftotext: forward('pdftotext') });
    expect(await documentCapabilities()).toMatchObject({ text_extraction: 'available', page_images: 'unavailable' });
    expect(body(await readDocument(root, { path: 'paper.pdf' })).status).toBe('read');
    const result = await readDocument(root, { path: 'paper.pdf', include_images: true });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ status: 'unavailable', dependency: 'pdftoppm' });
    expect(result.structuredContent).toBeUndefined();
  });
});

describe('PDF input and execution boundaries', () => {
  it('validates the page range, character limits and strict public schema', () => {
    expect(documentReadSchema.parse({ path: 'paper.pdf' })).toMatchObject({ start_page: 1, max_chars: 20_000, include_images: false });
    for (const invalid of [
      { start_page: 0 }, { start_page: 2, end_page: 1 }, { end_page: 6 }, { start_page: 1.5 },
      { max_chars: 0 }, { max_chars: 100_001 }, { start_character: 0 }, { start_character: 1.5 }, { include_images: 'true' }, { executable: '/bin/sh' },
      { expected_sha256: 'not a hash' }, { image_max_edge: 255 }, { image_max_edge: 2401 },
    ]) expect(documentReadSchema.safeParse({ path: 'paper.pdf', ...invalid }).success).toBe(false);
  });

  it('rejects traversal, outside paths, symlinks and credential paths before running a process', async () => {
    const { root, bytes } = fixture();
    const outside = directory();
    fs.writeFileSync(path.join(outside, 'external.pdf'), bytes);
    fs.symlinkSync(path.join(outside, 'external.pdf'), path.join(root, 'link.pdf'));
    fs.symlinkSync(outside, path.join(root, 'linked-directory'));
    fs.symlinkSync(path.join(outside, 'missing'), path.join(root, 'dangling.pdf'));
    fs.writeFileSync(path.join(root, '.secret.pdf'), bytes);
    fs.writeFileSync(path.join(root, 'credential.key'), bytes);
    executables({});
    for (const value of ['../external.pdf', path.join(outside, 'external.pdf'), 'link.pdf', 'linked-directory/external.pdf', 'dangling.pdf', '.secret.pdf', 'credential.key', 'paper.pdf\0']) {
      await expect(readDocument(root, { path: value }), value).rejects.toThrow();
    }
  });

  it('refuses non-regular inputs without blocking on a FIFO, and caps source bytes', async () => {
    const { root } = fixture();
    const fifo = path.join(root, 'pipe.pdf');
    execFileSync('mkfifo', [fifo]);
    await expect(readDocument(root, { path: 'pipe.pdf' })).rejects.toThrow('regular file');
    await expect(readDocument(root, { path: '.' })).rejects.toThrow();
    const target = path.join(root, 'oversize.pdf');
    fs.writeFileSync(target, '%PDF-1.4');
    fs.truncateSync(target, DOCUMENT_LIMITS.source_bytes + 1);
    await expect(readDocument(root, { path: 'oversize.pdf' })).rejects.toThrow('byte limit');
    fs.writeFileSync(path.join(root, 'wrong.pdf'), 'plain text');
    await expect(readDocument(root, { path: 'wrong.pdf' })).rejects.toThrow('Expected a PDF');
  });

  it('returns explicit unavailable responses instead of claiming an empty successful read', async () => {
    const { root } = fixture();
    executables({});
    expect(await documentCapabilities()).toMatchObject({ text_extraction: 'unavailable', page_images: 'unavailable', ocr: 'unavailable' });
    const result = await readDocument(root, { path: 'paper.pdf' });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ status: 'unavailable', dependency: 'pdfinfo', ocr_performed: false });
    expect(result.structuredContent).toBeUndefined();
  });

  it('does not let a metadata-like Pages line override the final page count', async () => {
    const { root } = fixture();
    executables({ pdfinfo: fakeInfo.replace('Pages: 2', 'Title: fake\\nPages: 99999\\nPages: 2'), pdftotext: fakeText });
    await expect(readDocument(root, { path: 'paper.pdf', start_page: 3 })).rejects.toThrow('2 pages');
  });

  it.each([
    ['pdfinfo stdout', { pdfinfo: "process.stdout.write('x'.repeat(65537));" }, 'output byte limit'],
    ['pdfinfo stderr', { pdfinfo: "process.stderr.write('x'.repeat(65537));" }, 'diagnostic byte limit'],
    ['text stdout', { pdfinfo: fakeInfo, pdftotext: `process.stdout.write('x'.repeat(${DOCUMENT_LIMITS.extraction_bytes_per_page + 1}));` }, 'output byte limit'],
    ['image stdout', { pdfinfo: fakeInfo, pdftotext: fakeText, pdftoppm: `process.stdout.write('x'.repeat(${DOCUMENT_LIMITS.image_bytes_per_page + 1}));` }, 'output byte limit'],
  ] as const)('bounds %s even for a faulty installed executable', async (_label, programs, message) => {
    const { root } = fixture();
    executables(programs);
    await expect(readDocument(root, { path: 'paper.pdf', include_images: true })).rejects.toThrow(message);
  });

  it('terminates an executable that never completes', async () => {
    const { root } = fixture();
    executables({ pdfinfo: 'process.stdin.resume(); setInterval(() => {}, 1000);' });
    vi.useFakeTimers();
    const check = expect(readDocument(root, { path: 'paper.pdf' })).rejects.toThrow('time limit');
    await vi.advanceTimersByTimeAsync(DOCUMENT_LIMITS.process_timeout_ms + 1);
    await check;
  });

  it.each(['invalid', 'oversize'])('rejects %s image output even when the renderer exits successfully', async kind => {
    const { root } = fixture();
    const renderer = kind === 'invalid' ? "process.stdout.write('not a png');" : `
      const png = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
      png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(257, 16); png.writeUInt32BE(1, 20);
      process.stdout.write(png);`;
    executables({ pdfinfo: fakeInfo, pdftotext: fakeText, pdftoppm: renderer });
    await expect(readDocument(root, { path: 'paper.pdf', include_images: true, image_max_edge: 256 })).rejects.toThrow(kind === 'invalid' ? 'PNG image' : 'dimension limit');
  });

  it('continues Unicode text and long pages without repeating or losing characters', async () => {
    const { root } = fixture();
    executables({ pdfinfo: fakeInfo, pdftotext: "process.stdout.write('𝛼βγ');" });
    const first = body(await readDocument(root, { path: 'paper.pdf', max_chars: 1 }));
    expect(first.pages[0]!.text).toBe('𝛼');
    expect(first.next).toMatchObject({ start_page: 1, start_character: 2 });
    const second = body(await readDocument(root, first.next!));
    expect(second.pages[0]!.text).toBe('β');
    const third = body(await readDocument(root, second.next!));
    expect(third.pages[0]!.text).toBe('γ');
    expect(third.next).toMatchObject({ start_page: 2, start_character: 1 });
    await expect(readDocument(root, { path: 'paper.pdf', start_character: 5 })).rejects.toThrow('beyond');
    executables({ pdfinfo: fakeInfo, pdftotext: `process.stdout.write('x'.repeat(${DOCUMENT_LIMITS.max_chars + 1}));` });
    const result = body(await readDocument(root, { path: 'paper.pdf', max_chars: DOCUMENT_LIMITS.max_chars }));
    expect(result.next).toMatchObject({ start_page: 1, start_character: DOCUMENT_LIMITS.max_chars + 1, max_chars: DOCUMENT_LIMITS.max_chars, include_images: false, expected_sha256: result.sha256 });
    expect(result).toMatchObject({ truncated: true, truncated_pages: [1], continuation_reason: 'page_text_truncated' });
    const tail = body(await readDocument(root, result.next!));
    expect(tail.pages[0]!.text).toBe('x');
    expect(tail.truncated).toBe(false);
    expect(tail.next).toMatchObject({ start_page: 2, start_character: 1 });
  });

  it('preserves bounded parser diagnostics and rejects invalid UTF-8 output', async () => {
    const { root } = fixture();
    executables({ pdfinfo: fakeInfo, pdftotext: `${fakeText} process.stderr.write('Syntax Warning: fixture warning');` });
    expect(body(await readDocument(root, { path: 'paper.pdf' }))).toMatchObject({ warnings: [{ tool: 'pdftotext', page: 1, message: 'Syntax Warning: fixture warning' }] });
    executables({ pdfinfo: fakeInfo, pdftotext: 'process.stdout.write(Buffer.from([0xff]));' });
    await expect(readDocument(root, { path: 'paper.pdf' })).rejects.toThrow('valid UTF-8');
  });
});
