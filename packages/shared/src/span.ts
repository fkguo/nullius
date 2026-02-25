/**
 * NEW-RT-03: OTel-aligned Span interface.
 *
 * Hand-written lightweight Span following OpenTelemetry semantic conventions.
 * No OTel SDK dependency — just the interface and builder.
 */

export type SpanStatus = 'OK' | 'ERROR' | 'UNSET';

export interface Span {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  start_time: string;  // ISO 8601
  end_time?: string;    // ISO 8601
  duration_ms?: number;
  status: SpanStatus;
  attributes?: Record<string, string | number | boolean>;
}

/**
 * SpanSink — dependency-inversion interface for span creation.
 * Consumers (e.g. hep-mcp dispatcher) accept this interface;
 * the orchestrator's SpanCollector satisfies it structurally.
 */
export interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean): void;
  end(status?: SpanStatus): void;
}

export interface SpanSink {
  startSpan(name: string, traceId?: string, parentSpanId?: string): SpanHandle;
}

/** Generate a span_id (16-char hex string, similar to OTel span ID format). */
export function generateSpanId(): string {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 16; i++) {
    s += hex[(Math.random() * 16) | 0];
  }
  return s;
}
