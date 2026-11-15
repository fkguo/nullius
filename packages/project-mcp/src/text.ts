import { z } from 'zod';
import { invalidParams } from '@nullius/shared';
import { readProjectBytes, readStrictUtf8, splitSourceLines } from './content.js';

export const TEXT_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const projectTextReadSchema = z.object({
  path: z.string().min(1),
  start_line: z.number().int().min(1).default(1),
  start_column: z.number().int().min(1).default(1),
  max_lines: z.number().int().min(1).max(1000).default(200),
  max_chars: z.number().int().min(1).max(100000).default(16000),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

/** Return source text, not a summary; columns and character budgets count Unicode code points. */
export function projectTextRead(root: string, raw: z.input<typeof projectTextReadSchema>) {
  const input = projectTextReadSchema.parse(raw);
  const source = readProjectBytes(root, input.path, TEXT_SOURCE_MAX_BYTES);
  if (input.expected_sha256 && input.expected_sha256 !== source.sha256) {
    throw invalidParams('Source hash changed; locate the current text before continuing.');
  }
  const text = readStrictUtf8(source.bytes);
  if (text.includes('\0')) throw invalidParams('Source contains binary NUL bytes; use the binary file or document tool.');
  const sourceLines = splitSourceLines(text);
  if (input.start_line > Math.max(1, sourceLines.length)) throw invalidParams('start_line is beyond the source.');
  let lineIndex = input.start_line - 1;
  let columnIndex = input.start_column - 1;
  if (columnIndex > Array.from(sourceLines[lineIndex] ?? '').length) {
    throw invalidParams('start_column is beyond the selected line.');
  }
  const lines: Array<{ line_number: number; column_start: number; text: string; complete: boolean }> = [];
  let characters = 0;
  while (lineIndex < sourceLines.length && lines.length < input.max_lines && characters < input.max_chars) {
    const points = Array.from(sourceLines[lineIndex]!);
    const part = points.slice(columnIndex, columnIndex + input.max_chars - characters);
    const complete = columnIndex + part.length === points.length;
    lines.push({ line_number: lineIndex + 1, column_start: columnIndex + 1, text: part.join(''), complete });
    characters += part.length;
    if (!complete) { columnIndex += part.length; break; }
    lineIndex += 1;
    columnIndex = 0;
  }
  const next = lineIndex < sourceLines.length
    ? { path: source.path, start_line: lineIndex + 1, start_column: columnIndex + 1, expected_sha256: source.sha256 }
    : null;
  return {
    path: source.path, sha256: source.sha256, source_bytes: source.size,
    encoding: 'utf-8', reading_method: 'source_text', column_unit: 'unicode_code_points',
    total_lines: sourceLines.length, lines, returned_characters: characters,
    truncated: next !== null, next,
  };
}
