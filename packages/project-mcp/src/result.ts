import { McpError, structuredContentOf } from '@nullius/shared';
import { ZodError } from 'zod';

export type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };
export function jsonResult(value: unknown, isError = false): Result {
  const structuredContent = isError ? undefined : structuredContentOf(value);
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}), ...(structuredContent ? { structuredContent } : {}) };
}
/**
 * Adds structuredContent to a successful result returned by the
 * orchestrator, whose single text block is the JSON of an object: the
 * parsed text is its exact mirror. Anything else is returned unchanged.
 */
export function withStructuredContent(result: Result): Result {
  if (result.isError || result.structuredContent || result.content.length !== 1 || result.content[0]!.type !== 'text') return result;
  let value: unknown;
  try { value = JSON.parse(result.content[0]!.text); } catch { return result; }
  const structuredContent = structuredContentOf(value);
  return structuredContent ? { ...result, structuredContent } : result;
}
export function errorResult(error: unknown): Result {
  const value = error instanceof McpError ? error : new McpError(error instanceof ZodError ? 'INVALID_PARAMS' : 'INTERNAL_ERROR', String(error));
  return jsonResult({ error: value.toJSON() }, true);
}
