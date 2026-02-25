/**
 * NEW-RT-03: OTel-aligned Span Tracing — JSONL collector.
 *
 * Provides ActiveSpan and SpanCollector for recording tool call spans.
 * Spans are written to append-only JSONL files for offline analysis.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type Span,
  type SpanStatus,
  generateTraceId,
  generateSpanId,
} from '@autoresearch/shared';

export class ActiveSpan {
  readonly span: Span;
  private readonly collector: SpanCollector;

  constructor(span: Span, collector: SpanCollector) {
    this.span = span;
    this.collector = collector;
  }

  /** Set a span attribute. */
  setAttribute(key: string, value: string | number | boolean): void {
    if (!this.span.attributes) this.span.attributes = {};
    this.span.attributes[key] = value;
  }

  /** End the span, compute duration, and write to JSONL. */
  end(status: SpanStatus = 'OK'): void {
    this.span.end_time = new Date().toISOString();
    this.span.status = status;
    const startMs = new Date(this.span.start_time).getTime();
    const endMs = new Date(this.span.end_time).getTime();
    this.span.duration_ms = endMs - startMs;
    this.collector.writeSpan(this.span);
  }
}

export class SpanCollector {
  private readonly outputPath: string | null;

  /**
   * @param runDir — Run directory; spans are written to `<runDir>/spans.jsonl`.
   *                 If null, spans are collected in memory only (for testing).
   */
  constructor(runDir: string | null) {
    if (runDir) {
      this.outputPath = path.join(runDir, 'spans.jsonl');
      // Ensure directory exists
      fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
    } else {
      this.outputPath = null;
    }
  }

  /**
   * Start a new span.
   *
   * @param name — Span name (e.g. tool name).
   * @param traceId — Trace ID (reuse for correlated spans; generated if omitted).
   * @param parentSpanId — Parent span ID for nested spans.
   */
  startSpan(name: string, traceId?: string, parentSpanId?: string): ActiveSpan {
    const span: Span = {
      trace_id: traceId ?? generateTraceId(),
      span_id: generateSpanId(),
      parent_span_id: parentSpanId,
      name,
      start_time: new Date().toISOString(),
      status: 'UNSET',
    };
    return new ActiveSpan(span, this);
  }

  /** Append a completed span to the JSONL file. */
  writeSpan(span: Span): void {
    if (!this.outputPath) return;
    const line = JSON.stringify(span) + '\n';
    fs.appendFileSync(this.outputPath, line, 'utf-8');
  }
}
