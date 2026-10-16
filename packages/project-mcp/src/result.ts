import { McpError, structuredContentOf } from '@nullius/shared';
import { ZodError } from 'zod';

export type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };
export function jsonResult(value: unknown, isError = false): Result {
  const structuredContent = isError ? undefined : structuredContentOf(value);
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}), ...(structuredContent ? { structuredContent } : {}) };
}
export function errorResult(error: unknown): Result {
  const value = error instanceof McpError ? error : new McpError(error instanceof ZodError ? 'INVALID_PARAMS' : 'INTERNAL_ERROR', String(error));
  return jsonResult({ error: value.toJSON() }, true);
}
