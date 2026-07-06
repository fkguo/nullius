/**
 * H-02: Minimal observability — trace_id generation and extraction.
 *
 * Every MCP tool call gets a trace_id (short handle id) for cross-component
 * correlation. Callers may pass `_trace_id` in tool params to propagate an
 * existing trace; otherwise a new one is generated.
 */
import { shortId } from './short-id.js';

/** Generate a new trace_id (short handle id; see `@nullius/shared` shortId). */
export function generateTraceId(): string {
  return shortId();
}

/**
 * Extract `_trace_id` from MCP tool call params, or generate a new one.
 * The `_trace_id` param is removed from the returned params copy.
 */
export function extractTraceId(params: Record<string, unknown>): { traceId: string; params: Record<string, unknown> } {
  const raw = params._trace_id;
  const traceId = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : generateTraceId();
  const { _trace_id: _, ...rest } = params;
  return { traceId, params: rest };
}
