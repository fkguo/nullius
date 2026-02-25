/**
 * H-02: Minimal observability — trace_id generation and extraction.
 *
 * Every MCP tool call gets a trace_id (UUID v4) for cross-component correlation.
 * Callers may pass `_trace_id` in tool params to propagate an existing trace;
 * otherwise a new one is generated.
 */

/** Generate a new trace_id (UUID v4). */
export function generateTraceId(): string {
  // Simple UUID v4 without node:crypto dependency (shared must stay platform-agnostic).
  const hex = '0123456789abcdef';
  const segments = [8, 4, 4, 4, 12];
  return segments
    .map((len, i) => {
      let s = '';
      for (let j = 0; j < len; j++) {
        if (i === 2 && j === 0) {
          s += '4'; // version nibble
        } else if (i === 3 && j === 0) {
          s += hex[(Math.random() * 4 + 8) | 0]; // variant nibble 8-b
        } else {
          s += hex[(Math.random() * 16) | 0];
        }
      }
      return s;
    })
    .join('-');
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
