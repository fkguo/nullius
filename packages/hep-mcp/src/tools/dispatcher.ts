import { ZodError } from 'zod';
import { HEP_IMPORT_FROM_ZOTERO } from '../tool-names.js';
import {
  invalidParams,
  McpError,
  unsafeFs,
  extractTraceId,
  INSPIRE_FIND_CONNECTIONS,
  INSPIRE_SEARCH,
  INSPIRE_SEARCH_NEXT,
  INSPIRE_LITERATURE,
  INSPIRE_NETWORK_ANALYSIS,
  INSPIRE_TOPIC_ANALYSIS,
  INSPIRE_TRACE_ORIGINAL_SOURCE,
  MAX_INLINE_RESULT_BYTES,
  HARD_CAP_RESULT_BYTES,
  PERMISSION_POLICY,
  redact,
  structuredContentOf,
  verifyHarnessInvocationMarker,
} from '@nullius/shared';
import type { SpanSink } from '@nullius/shared';
import type { PaperSummary } from '@nullius/shared';
import type {
  Notification,
  CreateMessageRequestParamsBase,
  CreateMessageResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { OutputFormat, SearchResultData } from '../utils/formatters.js';
import { formatSearchResultMarkdown, formatPaperListMarkdown } from '../utils/formatters.js';
import { compactPapersInResult } from '../utils/compactPaper.js';
import { getDataDir, getDataRootInfo, projectPdgDataDir, withHepDataRoot } from '../data/dataDir.js';
import { resolvePathWithinParent } from '../data/pathGuard.js';
import { withPdgDataDir } from '@nullius/pdg-mcp/tooling';

import { getToolSpec, isToolExposed, type ToolExposureMode } from './registry.js';
import { isStateTouchingHepMcp } from './state-touch-classification.js';
import { recordToolUsage } from './utils/toolUsageTelemetry.js';

export type ToolResultContentBlock = { type: 'text'; text: string };

export interface ToolCallContext {
  requestId?: string | number;
  progressToken?: string | number;
  sendNotification?: (notification: Notification) => Promise<void>;
  spanSink?: SpanSink;
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<{ content: ToolResultContentBlock[]; isError?: boolean }>;
}

function projectRootArg(args: Record<string, unknown>): unknown {
  return Object.prototype.hasOwnProperty.call(args, 'project_root') ? args.project_root : undefined;
}

function resolvedPdgDataDirForCurrentHepRoot(): string {
  const root = getDataRootInfo();
  if (root.source === 'project_root') return projectPdgDataDir(root.project_root!);

  const explicit = process.env.PDG_DATA_DIR;
  if (explicit && explicit.trim().length > 0) return explicit;
  return `${root.path}/pdg`;
}

export function inferMimeType(uriOrName: string): string {
  let fileName = uriOrName;
  try {
    const url = new URL(uriOrName);
    fileName = url.pathname.split('/').filter(Boolean).at(-1) ?? uriOrName;
  } catch {
    // Plain artifact names are accepted too.
  }

  try {
    fileName = decodeURIComponent(fileName);
  } catch {
    // Keep the raw name if percent-decoding fails.
  }

  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.jsonl')) return 'application/x-ndjson';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.tex')) return 'text/x-latex';
  return 'application/octet-stream';
}

function createProgressReporter(
  ctx?: ToolCallContext
): ((progress: number, total?: number, message?: string) => void) | undefined {
  if (!ctx?.progressToken || !ctx.sendNotification) return undefined;

  return (progress: number, total?: number, message?: string) => {
    ctx.sendNotification?.({
      method: 'notifications/progress',
      params: {
        progressToken: ctx.progressToken,
        progress,
        total,
        message,
      },
    }).catch(() => {});
  };
}

function validatePathArgs(args: Record<string, unknown>): void {
  const dataDir = getDataDir();

  const options = args.options as Record<string, unknown> | undefined;
  const outputDir = options?.output_dir;
  if (typeof outputDir === 'string' && outputDir.length > 0) {
    try {
      const resolved = resolvePathWithinParent(dataDir, outputDir, 'output_dir');
      if (options && typeof options === 'object' && !Array.isArray(options)) {
        options.output_dir = resolved;
      }
    } catch (err) {
      if (err instanceof McpError && err.code === 'UNSAFE_FS') {
        throw unsafeFs(
          [
            `output_dir must be within HEP_DATA_DIR (${dataDir}).`,
            `Use a relative output_dir (e.g. "arxiv_sources/<arxiv_id>") or set HEP_DATA_DIR to change the root.`,
          ].join(' '),
          {
            original_output_dir: outputDir,
            hep_data_dir: dataDir,
            hep_data_dir_env: 'HEP_DATA_DIR',
            ...(typeof err.data === 'object' && err.data !== null ? err.data : {}),
          }
        );
      }
      throw err;
    }
  }
}

function parseToolArgs<T>(toolName: string, schema: { parse: (input: unknown) => T }, args: unknown): T {
  try {
    return schema.parse(args);
  } catch (err) {
    if (err instanceof ZodError) {
      const data: Record<string, unknown> = {
        issues: err.issues,
      };

      throw invalidParams(`Invalid parameters for ${toolName}`, data);
    }
    throw err;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// H-13 L1: Tools whose paper lists should be compacted
// ─────────────────────────────────────────────────────────────────────────────

const COMPACT_PAPER_TOOLS = new Set([
  INSPIRE_SEARCH,
  INSPIRE_SEARCH_NEXT,
  INSPIRE_LITERATURE,
  INSPIRE_TOPIC_ANALYSIS,
  INSPIRE_NETWORK_ANALYSIS,
  INSPIRE_FIND_CONNECTIONS,
  INSPIRE_TRACE_ORIGINAL_SOURCE,
  HEP_IMPORT_FROM_ZOTERO,
]);

function shouldCompactPapers(name: string, args: Record<string, unknown>): boolean {
  if (!(COMPACT_PAPER_TOOLS as Set<string>).has(name)) return false;
  // Single-paper result (get_paper) — full data is appropriate (~2-5KB)
  if (name === INSPIRE_LITERATURE && args.mode === 'get_paper') return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// H-13 L0: Extended markdown formatting
// ─────────────────────────────────────────────────────────────────────────────

function tryFormatMarkdown(
  name: string,
  result: unknown,
  args: Record<string, unknown>
): string | null {
  const r = result as Record<string, unknown>;

  // inspire_search / inspire_search_next → formatSearchResultMarkdown
  if (name === INSPIRE_SEARCH || name === INSPIRE_SEARCH_NEXT) {
    const data = r as unknown as SearchResultData & { next_url?: string };
    let hasMore = false;

    if (typeof data.has_more === 'boolean') {
      hasMore = data.has_more;
    } else if (name === INSPIRE_SEARCH) {
      const pageRaw = args.page;
      const sizeRaw = args.size;
      const page = typeof pageRaw === 'number' && Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
      const size = typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) ? Math.max(1, Math.trunc(sizeRaw)) : 10;
      const shown = (page - 1) * size + (Array.isArray(data.papers) ? data.papers.length : 0);
      hasMore = data.total > shown;
    }

    const nextUrl = typeof data.next_url === 'string' && data.next_url.trim().length > 0 ? data.next_url.trim() : undefined;

    let text = formatSearchResultMarkdown({
      total: data.total,
      papers: data.papers ?? [],
      has_more: hasMore,
    });

    if (hasMore && nextUrl) {
      text += `\n\n---\n\nNext page: call \`inspire_search_next\` with \`next_url\`:\n\n\`\`\`\n${nextUrl}\n\`\`\`\n`;
    }
    return text;
  }

  // inspire_literature (get_references / get_citations) → formatPaperListMarkdown
  if (name === INSPIRE_LITERATURE) {
    const mode = args.mode as string;
    if (mode === 'get_references' || mode === 'get_citations') {
      const papers: unknown[] = Array.isArray(r.papers) ? r.papers : Array.isArray(r) ? r as unknown[] : [];
      if (papers.length > 0) {
        const title = mode === 'get_references' ? 'References' : 'Citations';
        return formatPaperListMarkdown(papers as PaperSummary[], title);
      }
    }
    return null;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// formatToolResult — H-13 L0+L1+L3 unified
// ─────────────────────────────────────────────────────────────────────────────

/** The longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`. */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf-8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) to a character start.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf-8');
}

/**
 * `structuredContent` mirrors the JSON text block exactly: it is the same
 * (possibly compacted) object the text serialises, and it is left out for
 * string results, markdown text and hard-truncated text.
 */
function formatToolResult(
  name: string,
  result: unknown,
  args: Record<string, unknown>
): { content: ToolResultContentBlock[]; structuredContent?: Record<string, unknown> } {
  // String result: pass through
  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] };
  }

  const format = (args.format as OutputFormat) || 'json';

  // L1: compact paper projection for applicable tools
  const processed = shouldCompactPapers(name, args) ? compactPapersInResult(result) : result;

  // L0: extended markdown format branches
  if (format === 'markdown') {
    const markdown = tryFormatMarkdown(name, processed, args);
    if (markdown !== null) {
      return { content: [{ type: 'text', text: markdown }] };
    }
  }

  // L0: compact JSON serialization (no indent)
  const json = JSON.stringify(processed);
  const size = Buffer.byteLength(json, 'utf-8');

  const structuredContent = structuredContentOf(processed);
  const structured = structuredContent ? { structuredContent } : {};

  // L3: fast path — small result
  if (size <= MAX_INLINE_RESULT_BYTES) {
    return { content: [{ type: 'text', text: json }], ...structured };
  }

  // L3: over soft limit — hard truncate if beyond hard cap, counting UTF-8
  // bytes (as `size` does) and cutting on a character boundary.
  if (size > HARD_CAP_RESULT_BYTES) {
    return {
      content: [{ type: 'text', text: truncateUtf8(json, HARD_CAP_RESULT_BYTES) + '\n... [TRUNCATED, original: ' + size + ' bytes]' }],
    };
  }

  // Between soft and hard cap — return as-is
  return { content: [{ type: 'text', text: json }], ...structured };
}

function formatToolError(
  err: unknown,
  ctx?: ToolCallContext,
  traceId?: string
): { content: ToolResultContentBlock[]; isError: true } {
  const requestId = ctx?.requestId ?? null;

  const payload = (() => {
    if (err instanceof McpError) {
      return {
        error: {
          code: err.code,
          message: err.message,
          data: {
            ...(err.data && typeof err.data === 'object' ? err.data as Record<string, unknown> : { raw: err.data }),
            retryable: err.retryable,
            ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
          },
        },
        trace_id: traceId ?? null,
        request_id: requestId,
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    return {
      error: {
        code: 'INTERNAL_ERROR',
        message,
      },
      trace_id: traceId ?? null,
      request_id: requestId,
    };
  })();

  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

// trace-jsonl: emit structured JSONL log entry to stderr
export function emitJsonlLog(params: {
  traceId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  durationMs: number;
  resultStatus: 'success' | 'error';
}): void {
  const entry = {
    ts: new Date().toISOString(),
    level: params.resultStatus === 'success' ? 'INFO' : 'ERROR',
    component: 'mcp_server',
    trace_id: params.traceId,
    event: 'tool_call',
    data: {
      tool_name: params.toolName,
      params: params.toolArgs,
      result_status: params.resultStatus,
      duration_ms: params.durationMs,
    },
  };
  try {
    process.stderr.write(redact(JSON.stringify(entry)) + '\n');
  } catch {
    // Best-effort: never break MCP protocol on log failure
  }
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  mode: ToolExposureMode = 'standard',
  ctx?: ToolCallContext
): Promise<{ content: ToolResultContentBlock[]; isError?: boolean; structuredContent?: Record<string, unknown> }> {
  try {
    // P3-C (redesigned 2026-05-23): event-driven anchor verification before
    // data root resolution. State-touch classification per audit table in
    // `state-touch-classification.ts`; the call short-circuits via skip layer C
    // for read-only provider re-exports and pure HTTP inspire research tools.
    verifyHarnessInvocationMarker(process.cwd(), {
      toolIsStateTouching: isStateTouchingHepMcp(name, args),
    });
    return await withHepDataRoot(projectRootArg(args), () =>
      withPdgDataDir(resolvedPdgDataDirForCurrentHepRoot(), () =>
        handleToolCallInResolvedDataRoot(name, args, mode, ctx)
      )
    );
  } catch (err) {
    return formatToolError(err, ctx);
  }
}

async function handleToolCallInResolvedDataRoot(
  name: string,
  args: Record<string, unknown>,
  mode: ToolExposureMode = 'standard',
  ctx?: ToolCallContext
): Promise<{ content: ToolResultContentBlock[]; isError?: boolean; structuredContent?: Record<string, unknown> }> {
  const reportProgress = createProgressReporter(ctx);
  // H-02: extract or generate trace_id for this tool call
  const { traceId, params: cleanArgs } = extractTraceId(args);

  // NEW-RT-03: optional span tracing
  const span = ctx?.spanSink?.startSpan(name, traceId);
  span?.setAttribute('tool.name', name);

  const startMs = Date.now();
  let loggedArgs: Record<string, unknown> = cleanArgs;
  try {
    const spec = getToolSpec(name);
    if (!spec) {
      throw invalidParams(`Unknown tool: ${name}`);
    }
    if (!isToolExposed(spec, mode)) {
      throw invalidParams(`Tool not exposed in ${mode} mode: ${name}`);
    }

    validatePathArgs(cleanArgs);

    // H-11b: chain depth limit — validate as finite non-negative integer
    const rawDepth = cleanArgs._chain_depth;
    const chainDepth = (typeof rawDepth === 'number' && Number.isInteger(rawDepth) && rawDepth >= 0) ? rawDepth : 0;
    if (typeof rawDepth !== 'undefined' && chainDepth === 0 && rawDepth !== 0) {
      throw invalidParams(
        `Invalid _chain_depth value: expected non-negative integer, got ${JSON.stringify(rawDepth)}`,
        { raw_value: rawDepth },
      );
    }
    if (chainDepth > PERMISSION_POLICY.max_chain_length) {
      throw invalidParams(
        `Tool chain depth ${chainDepth} exceeds max_chain_length ${PERMISSION_POLICY.max_chain_length}`,
        { chain_depth: chainDepth, max: PERMISSION_POLICY.max_chain_length },
      );
    }
    delete cleanArgs._chain_depth;

    // hep-mcp keeps no runs: a run_id argument (accepted by earlier versions)
    // is refused instead of being silently dropped by schema parsing, which
    // could change what the call does.
    if (Object.prototype.hasOwnProperty.call(cleanArgs, 'run_id')) {
      throw invalidParams('run_id is not accepted: hep-mcp keeps no runs. Research-output tools take project_root + output_dir; runs belong to the orchestrator.', {
        tool: name,
      });
    }

    // H-11a Phase 2: destructive tools require explicit _confirm: true
    if (spec.riskLevel === 'destructive' && cleanArgs._confirm !== true) {
      span?.end('OK');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: {
              code: 'CONFIRMATION_REQUIRED',
              message: `Tool ${name} is destructive. Pass _confirm: true to proceed.`,
              data: {
                tool: name,
                risk_level: 'destructive',
                next_actions: [{ tool: name, args: { ...cleanArgs, _confirm: true } }],
              },
            },
            trace_id: traceId,
          }, null, 2),
        }],
        isError: true,
      };
    }

    loggedArgs = { ...cleanArgs };
    delete loggedArgs._confirm;

    if (reportProgress) {
      reportProgress(0, 1, `started: ${name}`);
    }

    const parsedArgs = parseToolArgs(name, spec.zodSchema, cleanArgs) as unknown as Record<string, unknown>;
    const loopbackCallTool = ctx?.callTool
      ? (toolName: string, toolArgs: Record<string, unknown>) => ctx.callTool!(
        toolName,
        {
          ...toolArgs,
          ...(projectRootArg(cleanArgs) !== undefined && projectRootArg(toolArgs) === undefined
            ? { project_root: projectRootArg(cleanArgs) }
            : {}),
          _chain_depth: chainDepth + 1,
        },
      )
      : (toolName: string, toolArgs: Record<string, unknown>) => handleToolCall(
        toolName,
        {
          ...toolArgs,
          ...(projectRootArg(cleanArgs) !== undefined && projectRootArg(toolArgs) === undefined
            ? { project_root: projectRootArg(cleanArgs) }
            : {}),
          _chain_depth: chainDepth + 1,
        },
        mode,
        {
          requestId: ctx?.requestId,
          spanSink: ctx?.spanSink,
          createMessage: ctx?.createMessage,
        },
      );

    const result = await spec.handler(parsedArgs, {
      reportProgress,
      rawArgs: cleanArgs,
      createMessage: ctx?.createMessage,
      callTool: loopbackCallTool,
    });
    recordToolUsage(name);
    const durationMs = Date.now() - startMs;

    // trace-jsonl: structured JSONL log to stderr (compatible with MCP stdio protocol)
    emitJsonlLog({ traceId, toolName: name, toolArgs: loggedArgs, durationMs, resultStatus: 'success' });

    if (reportProgress) reportProgress(1, 1, `completed: ${name}`);
    span?.end('OK');
    return formatToolResult(name, result, parsedArgs);
  } catch (err) {
    const durationMs = Date.now() - startMs;
    if (reportProgress) reportProgress(1, 1, `failed: ${name}`);
    span?.setAttribute('error.type', err instanceof Error ? err.constructor.name : 'unknown');
    span?.setAttribute('error.message', err instanceof Error ? err.message : String(err));
    span?.end('ERROR');

    // trace-jsonl: structured JSONL log for failed tool calls
    emitJsonlLog({ traceId, toolName: name, toolArgs: loggedArgs, durationMs, resultStatus: 'error' });

    return formatToolError(err, ctx, traceId);
  }
}
