import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { invalidParams } from '@nullius/shared';
import { z } from 'zod';
import { readProjectBytes, readStrictUtf8 } from './content.js';
import { jsonResult } from './result.js';

export const DOCUMENT_LIMITS = {
  source_bytes: 32 * 1024 * 1024,
  selected_pages: 5,
  max_chars: 100_000,
  image_max_edge: 2400,
  image_default_edge: 1600,
  image_bytes_per_page: 4 * 1024 * 1024,
  extraction_bytes_per_page: 1024 * 1024,
  process_timeout_ms: 10_000,
  request_timeout_ms: 60_000,
} as const;

export const documentReadSchema = z.object({
  path: z.string().min(1),
  start_page: z.number().int().min(1).max(1_000_000).default(1),
  end_page: z.number().int().min(1).max(1_000_000).optional(),
  start_character: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  max_chars: z.number().int().min(1).max(DOCUMENT_LIMITS.max_chars).default(20_000),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  include_images: z.boolean().default(false),
  image_max_edge: z.number().int().min(256).max(DOCUMENT_LIMITS.image_max_edge).default(DOCUMENT_LIMITS.image_default_edge),
}).strict().superRefine((input, context) => {
  const end = input.end_page ?? input.start_page;
  if (end < input.start_page || end - input.start_page + 1 > DOCUMENT_LIMITS.selected_pages) {
    context.addIssue({ code: 'custom', path: ['end_page'], message: 'Select an ascending range of at most 5 pages.' });
  }
});

type ImageContent = { type: 'image'; data: string; mimeType: string };
export type DocumentResult = {
  content: Array<{ type: 'text'; text: string } | ImageContent>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type PopplerTool = 'pdfinfo' | 'pdftotext' | 'pdftoppm';
class DependencyUnavailable extends Error {
  constructor(readonly tool: PopplerTool, reason: string) { super(`${tool} is unavailable: ${reason}`); }
}

/** No source paths, output paths, caller-supplied argv or shell are passed to Poppler. */
function runPoppler(tool: PopplerTool, args: string[], input: Buffer, maxOutput: number, timeoutMs: number) {
  return new Promise<{ stdout: Buffer; stderr: string }>((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(tool, args, {
      shell: false, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    let settled = false;
    const output: Buffer[] = [];
    const diagnostics: Buffer[] = [];
    let outputBytes = 0;
    let diagnosticBytes = 0;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (killError) {
        if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') {
          error = new Error(`${error.message}; process termination failed: ${String(killError)}`);
        }
      }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      reject(error);
    };
    const timer = setTimeout(() => fail(invalidParams(`${tool} exceeded the document process time limit.`)), timeoutMs);
    child.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      fail(['ENOENT', 'EACCES', 'ENOEXEC'].includes(code ?? '')
        ? new DependencyUnavailable(tool, code!) : error);
    });
    child.stdin.on('error', error => {
      // An invalid/encrypted PDF may make Poppler exit before consuming stdin.
      // The exit code and bounded stderr below still determine success.
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') fail(error);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutput) fail(invalidParams(`${tool} exceeded the document output byte limit.`));
      else if (!settled) output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > 65_536) fail(invalidParams(`${tool} exceeded the diagnostic byte limit.`));
      else if (!settled) diagnostics.push(chunk);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(diagnostics).toString('utf8').trim();
      if (code !== 0) reject(invalidParams(`${tool} could not read this PDF (exit ${code ?? signal}): ${stderr.slice(0, 2000)}`));
      else resolve({ stdout: Buffer.concat(output), stderr });
    });
    child.stdin.end(input);
  });
}

/** A small version probe; this does not claim a document has been read or OCR is present. */
export async function documentCapabilities() {
  const tools: PopplerTool[] = ['pdfinfo', 'pdftotext', 'pdftoppm'];
  const dependencies = Object.fromEntries(await Promise.all(tools.map(async tool => {
    try {
      const result = await runPoppler(tool, ['-v'], Buffer.alloc(0), 8192, 2000);
      if (!`${result.stdout.toString('utf8')}\n${result.stderr}`.includes(`${tool} version`)) {
        throw new Error('Executable did not identify itself as Poppler.');
      }
      return [tool, { status: 'available' as const }];
    } catch (error) {
      return [tool, { status: 'unavailable' as const, reason: error instanceof Error ? error.message : String(error) }];
    }
  })));
  const textAvailable = ['pdfinfo', 'pdftotext'].every(tool => dependencies[tool]?.status === 'available');
  return {
    formats: ['application/pdf'],
    text_extraction: textAvailable ? 'available' : 'unavailable',
    page_images: textAvailable && dependencies.pdftoppm?.status === 'available' ? 'available' : 'unavailable',
    ocr: 'unavailable', dependencies, limits: DOCUMENT_LIMITS,
  };
}

function pngDimensions(bytes: Buffer, maxEdge: number) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)
      || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw invalidParams('pdftoppm did not produce a PNG image.');
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > maxEdge || height > maxEdge) {
    throw invalidParams('Rendered PDF page exceeded the image dimension limit.');
  }
  return { width, height };
}

type DocumentPage = {
  page: number; text: string; extracted_characters: number; truncated: boolean;
  text_start_character: number; returned_characters: number;
  text_status: 'extracted' | 'no_extractable_text';
  image?: { content_index: number; width: number; height: number; bytes: number; sha256: string };
};

export async function readDocument(root: string, args: z.input<typeof documentReadSchema>): Promise<DocumentResult> {
  const input = documentReadSchema.parse(args);
  const deadline = Date.now() + DOCUMENT_LIMITS.request_timeout_ms;
  const source = readProjectBytes(root, input.path, DOCUMENT_LIMITS.source_bytes);
  if (input.expected_sha256 && source.sha256 !== input.expected_sha256) {
    throw invalidParams('Document changed since the previous read; inspect the current source before continuing.', {
      expected_sha256: input.expected_sha256, actual_sha256: source.sha256,
    });
  }
  if (!source.bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-')) throw invalidParams('Expected a PDF document.');
  const end = input.end_page ?? input.start_page;
  const warnings: Array<{ tool: PopplerTool; page?: number; message: string }> = [];
  const run = async (tool: PopplerTool, args: string[], limit: number, page?: number) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw invalidParams('Document request exceeded its time limit.');
    const result = await runPoppler(tool, args, source.bytes, limit, Math.min(remaining, DOCUMENT_LIMITS.process_timeout_ms));
    if (result.stderr) warnings.push({ tool, ...(page === undefined ? {} : { page }), message: result.stderr });
    return result.stdout;
  };
  try {
    const info = (await run('pdfinfo', ['-enc', 'UTF-8', '-'], 65_536)).toString('utf8');
    // PDF metadata is printed before the canonical Pages field and can itself
    // contain newlines. A metadata line must not override the final count.
    const counts = [...info.matchAll(/^Pages:\s+([1-9][0-9]*)\s*$/gm)];
    const totalPages = Number(counts.at(-1)?.[1]);
    if (!Number.isSafeInteger(totalPages) || totalPages < 1) throw invalidParams('pdfinfo did not report a valid page count.');
    if (end > totalPages) throw invalidParams(`Requested page range exceeds the document's ${totalPages} pages.`);
    const pages: DocumentPage[] = [];
    const images: ImageContent[] = [];
    let charsRemaining = input.max_chars;
    for (let page = input.start_page; page <= end; page++) {
      const pageArgs = ['-f', String(page), '-l', String(page)];
      const textBytes = await run('pdftotext', [...pageArgs, '-layout', '-enc', 'UTF-8', '-eol', 'unix', '-nopgbrk', '-', '-'], DOCUMENT_LIMITS.extraction_bytes_per_page, page);
      const text = readStrictUtf8(textBytes).trimEnd();
      const characters = Array.from(text);
      const offset = page === input.start_page ? input.start_character - 1 : 0;
      if (offset > characters.length) throw invalidParams('start_character is beyond the extracted text of the first selected page.');
      const returned = characters.slice(offset, offset + charsRemaining);
      const result: DocumentPage = {
        page, text: returned.join(''), extracted_characters: characters.length, truncated: offset + returned.length < characters.length,
        text_start_character: offset + 1, returned_characters: returned.length,
        text_status: text.trim() ? 'extracted' : 'no_extractable_text',
      };
      charsRemaining -= returned.length;
      if (input.include_images) {
        const png = await run('pdftoppm', [...pageArgs, '-singlefile', '-scale-to', String(input.image_max_edge), '-png', '-'], DOCUMENT_LIMITS.image_bytes_per_page, page);
        result.image = { content_index: images.length + 1, ...pngDimensions(png, input.image_max_edge), bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') };
        images.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
      }
      pages.push(result);
    }
    const incomplete = pages.find(page => page.truncated);
    const nextPage = incomplete?.page ?? (end < totalPages ? end + 1 : null);
    const next = nextPage === null ? null : {
      path: source.path, start_page: nextPage, expected_sha256: source.sha256,
      start_character: incomplete ? incomplete.text_start_character + incomplete.returned_characters : 1,
      max_chars: input.max_chars,
      include_images: input.include_images,
      image_max_edge: input.image_max_edge,
    };
    const result = jsonResult({
      status: 'read', path: source.path, mime_type: 'application/pdf', sha256: source.sha256, size: source.size,
      total_pages: totalPages, start_page: input.start_page, end_page: end, pages,
      character_unit: 'unicode_code_points',
      next_start_page: nextPage, next,
      truncated: !!incomplete, truncated_pages: pages.filter(page => page.truncated).map(page => page.page),
      continuation_reason: incomplete ? 'page_text_truncated' : nextPage === null ? 'selection_complete' : 'more_pages',
      continuation_advice: incomplete
        ? 'next resumes at the first unreturned Unicode character of the first truncated page, bound to the same source hash. Read that remainder before advancing to later pages; page images do not replace omitted text or perform OCR.'
        : 'next reads the following page only if the source SHA-256 still matches.',
      reading_scope: 'selected_pages',
      reading_method: 'text_extraction', ocr_performed: false, warnings,
      notice: 'Extracted text may omit scans, figures, equations and layout. No extractable text does not mean a page is blank. Use page images for visual inspection; OCR was not performed.',
    });
    return { ...result, content: [...result.content, ...images] };
  } catch (error) {
    if (!(error instanceof DependencyUnavailable)) throw error;
    return jsonResult({ status: 'unavailable', dependency: error.tool, reason: error.message, ocr_performed: false }, true);
  }
}
