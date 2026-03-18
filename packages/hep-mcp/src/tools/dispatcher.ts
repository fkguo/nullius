import { ZodError } from 'zod';
import {
  HEP_IMPORT_FROM_ZOTERO,
  HEP_PROJECT_CREATE,
  HEP_PROJECT_QUERY_EVIDENCE,
  HEP_RUN_CREATE,
  HEP_RUN_PREFIX,
} from '../tool-names.js';
import {
  invalidParams,
  McpError,
  unsafeFs,
  extractTraceId,
  INSPIRE_PARSE_LATEX,
  INSPIRE_SEARCH,
  INSPIRE_SEARCH_NEXT,
  INSPIRE_LITERATURE,
  INSPIRE_RESEARCH_NAVIGATOR,
  MAX_INLINE_RESULT_BYTES,
  HARD_CAP_RESULT_BYTES,
  PERMISSION_POLICY,
} from '@autoresearch/shared';
import type { SpanSink } from '@autoresearch/shared';
import type { PaperSummary } from '@autoresearch/shared';
import type {
  Notification,
  CreateMessageRequestParamsBase,
  CreateMessageResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { OutputFormat, SearchResultData } from '../utils/formatters.js';
import { formatSearchResultMarkdown, formatPaperListMarkdown } from '../utils/formatters.js';
import { compactPapersInResult, compactPaperSummary } from '../utils/compactPaper.js';
import { getDataDir } from '../data/dataDir.js';
import { resolvePathWithinParent } from '../data/pathGuard.js';
import { writeRunJsonArtifact } from '../core/citations.js';
import { getRun } from '../core/runs.js';
import { makeHepRunManifestUri } from '../core/runArtifactUri.js';

import { getToolSpec, isToolExposed, type ToolExposureMode } from './registry.js';
import { recordToolUsage } from './utils/toolUsageTelemetry.js';

// ─────────────────────────────────────────────────────────────────────────────
// H-13: Result content block types (L4: supports resource_link)
// ─────────────────────────────────────────────────────────────────────────────

export type ToolResultContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType: string };

export interface ToolCallContext {
  requestId?: string | number;
  progressToken?: string | number;
  sendNotification?: (notification: Notification) => Promise<void>;
  spanSink?: SpanSink;
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
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
      const argsObj = (args && typeof args === 'object') ? (args as Record<string, unknown>) : null;

      const missingRunIdForHepRunTool = (() => {
        if (!toolName.startsWith(HEP_RUN_PREFIX) && toolName !== INSPIRE_PARSE_LATEX) return false;
        const hasRunIdKey = argsObj ? Object.prototype.hasOwnProperty.call(argsObj, 'run_id') : false;
        const runIdValue = hasRunIdKey && argsObj ? argsObj.run_id : undefined;
        const runIdIsMissing = !hasRunIdKey || runIdValue === undefined;
        if (!runIdIsMissing) return false;
        const missingRunIdIssue = err.issues.find(issue => {
          return Array.isArray(issue.path) && issue.path.includes('run_id');
        });
        return Boolean(missingRunIdIssue);
      })();

      const missingRunIdForProjectSemanticQuery = (() => {
        if (toolName !== HEP_PROJECT_QUERY_EVIDENCE) return false;
        const modeValue = argsObj && typeof argsObj.mode === 'string' ? argsObj.mode.trim().toLowerCase() : 'lexical';
        if (modeValue !== 'semantic') return false;
        const hasRunIdKey = argsObj ? Object.prototype.hasOwnProperty.call(argsObj, 'run_id') : false;
        const runIdValue = hasRunIdKey && argsObj ? argsObj.run_id : undefined;
        const runIdIsMissing = !hasRunIdKey || runIdValue === undefined;
        if (!runIdIsMissing) return false;
        const missingRunIdIssue = err.issues.find(issue => {
          return Array.isArray(issue.path) && issue.path.includes('run_id');
        });
        return Boolean(missingRunIdIssue);
      })();

      const data: Record<string, unknown> = {
        issues: err.issues,
      };

      if (missingRunIdForProjectSemanticQuery) {
        const projectId = argsObj && typeof argsObj.project_id === 'string' ? argsObj.project_id : '<project_id>';
        const query = argsObj && typeof argsObj.query === 'string' ? argsObj.query : '<query>';
        data.next_actions = [
          {
            tool: HEP_RUN_CREATE,
            args: {
              project_id: projectId,
            },
            reason: 'Create a run and use run_id for semantic mode.',
          },
          {
            tool: HEP_PROJECT_QUERY_EVIDENCE,
            args: {
              project_id: projectId,
              mode: 'semantic',
              run_id: '<run_id from hep_run_create>',
              query,
            },
            reason: 'Retry semantic evidence query with run_id.',
          },
        ];
      } else if (missingRunIdForHepRunTool) {
        data.next_actions = [
          {
            tool: HEP_PROJECT_CREATE,
            args: {
              name: 'my_project',
              description: 'Create a project before creating a run.',
            },
            reason: 'Create a project first.',
          },
          {
            tool: HEP_RUN_CREATE,
            args: {
              project_id: '<project_id from hep_project_create>',
            },
            reason: 'Create a run and provide run_id in subsequent hep_run_* calls.',
          },
        ];
      }

      if (missingRunIdForProjectSemanticQuery || missingRunIdForHepRunTool) {
        throw invalidParams('run_id is required. Create one with hep_run_create first.', data);
      }

      throw invalidParams(`Invalid parameters for ${toolName}`, data);
    }
    throw err;
  }
}


type SkillBridgeJobEnvelopeV1 = {
  version: 1;
  job_id: string;
  status: string;
  status_uri: string;
  polling: {
    strategy: 'manifest_resource';
    resource_uri: string;
    terminal_statuses: string[];
  };
};

function maybeAttachSkillBridgeJobEnvelope(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;

  const record = result as Record<string, unknown>;
  if (record.job && typeof record.job === 'object') return result;

  const runIdRaw = record.run_id;
  if (typeof runIdRaw !== 'string' || runIdRaw.trim().length === 0) return result;
  const runId = runIdRaw.trim();

  let status = 'failed';
  try {
    const runStatus = getRun(runId).status;
    status = typeof runStatus === 'string' && runStatus.trim().length > 0 ? runStatus : 'created';
  } catch {
    // best-effort envelope only; if run is unavailable, expose terminal fallback status
    status = 'failed';
  }

  const manifestUri = typeof record.manifest_uri === 'string' && record.manifest_uri.trim().length > 0
    ? record.manifest_uri.trim()
    : makeHepRunManifestUri(runId);

  const job: SkillBridgeJobEnvelopeV1 = {
    version: 1,
    job_id: runId,
    status,
    status_uri: manifestUri,
    polling: {
      strategy: 'manifest_resource',
      resource_uri: manifestUri,
      terminal_statuses: ['done', 'failed'],
    },
  };

  return {
    ...record,
    job,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// H-13 L1: Tools whose paper lists should be compacted
// ─────────────────────────────────────────────────────────────────────────────

const COMPACT_PAPER_TOOLS = new Set([
  INSPIRE_SEARCH,
  INSPIRE_SEARCH_NEXT,
  INSPIRE_LITERATURE,
  INSPIRE_RESEARCH_NAVIGATOR,
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

  // inspire_research_navigator (discover / field_survey) → formatPaperListMarkdown
  if (name === INSPIRE_RESEARCH_NAVIGATOR) {
    const mode = args.mode as string;
    if (mode === 'discover' || mode === 'field_survey') {
      const papers: unknown[] = Array.isArray(r.papers) ? r.papers : [];
      if (papers.length > 0) {
        const title = mode === 'discover' ? 'Discovered Papers' : 'Field Survey Results';
        return formatPaperListMarkdown(papers as PaperSummary[], title);
      }
    }
    return null;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// H-13 L3: Size guard helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractRunIdFromResult(result: unknown, args: Record<string, unknown>): string | null {
  if (typeof args.run_id === 'string' && args.run_id.trim()) return args.run_id.trim();
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (typeof record.run_id === 'string' && record.run_id.trim()) return record.run_id.trim();
  }
  return null;
}

function autoSummarize(result: unknown, _toolName: string): Record<string, unknown> {
  if (!result || typeof result !== 'object') {
    return { type: 'unknown' };
  }

  if (Array.isArray(result)) {
    return {
      total_items: result.length,
      shown_items: Math.min(5, result.length),
      highlights: result.slice(0, 5),
    };
  }

  const record = result as Record<string, unknown>;

  // { papers: [...] }
  if (Array.isArray(record.papers)) {
    const papers = record.papers;
    const compacted = papers.slice(0, 5).map((p: unknown) => {
      if (p && typeof p === 'object' && 'title' in p) {
        return compactPaperSummary(p as PaperSummary);
      }
      return p;
    });
    return {
      total_items: typeof record.total === 'number' ? record.total : papers.length,
      shown_items: compacted.length,
      highlights: compacted,
    };
  }

  // { results: [...] } or { hits: [...] }
  for (const key of ['results', 'hits'] as const) {
    if (Array.isArray(record[key])) {
      const arr = record[key] as unknown[];
      return {
        total_items: typeof record.total === 'number' ? record.total : arr.length,
        shown_items: Math.min(5, arr.length),
        highlights: arr.slice(0, 5),
      };
    }
  }

  // Generic object — expose keys
  const keys = Object.keys(record);
  return { type: 'object', keys: keys.slice(0, 20), total_keys: keys.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// H-13 L4: resource_link helpers
// ─────────────────────────────────────────────────────────────────────────────

function collectHepUris(value: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  if (typeof value === 'string' && value.startsWith('hep://')) {
    return [value];
  }
  if (Array.isArray(value)) {
    const uris: string[] = [];
    for (const item of value) {
      uris.push(...collectHepUris(item, depth + 1));
    }
    return uris;
  }
  if (value && typeof value === 'object') {
    const uris: string[] = [];
    for (const v of Object.values(value as Record<string, unknown>)) {
      uris.push(...collectHepUris(v, depth + 1));
    }
    return uris;
  }
  return [];
}

// M-21 R2 fix: infer MIME type from hep:// URI artifact name extension
export function inferMimeType(uri: string): string {
  const name = uri.split('/').pop() ?? '';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.jsonl')) return 'application/x-ndjson';
  if (name.endsWith('.md')) return 'text/markdown';
  if (name.endsWith('.tex')) return 'text/x-latex';
  return 'application/octet-stream';
}

function appendResourceLinks(content: ToolResultContentBlock[], result: unknown): void {
  const uris = [...new Set(collectHepUris(result))];
  for (const uri of uris) {
    const name = decodeURIComponent(uri.split('/').pop() ?? 'artifact');
    content.push({ type: 'resource_link', uri, name, mimeType: inferMimeType(uri) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// formatToolResult — H-13 L0+L1+L3+L4 unified
// ─────────────────────────────────────────────────────────────────────────────

function formatToolResult(
  name: string,
  result: unknown,
  args: Record<string, unknown>
): { content: ToolResultContentBlock[] } {
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
      const content: ToolResultContentBlock[] = [{ type: 'text', text: markdown }];
      appendResourceLinks(content, processed);
      return { content };
    }
  }

  // L0: compact JSON serialization (no indent)
  const json = JSON.stringify(processed);
  const size = Buffer.byteLength(json, 'utf-8');

  // L3: fast path — small result
  if (size <= MAX_INLINE_RESULT_BYTES) {
    const content: ToolResultContentBlock[] = [{ type: 'text', text: json }];
    appendResourceLinks(content, processed);
    return { content };
  }

  // L3: over soft limit — write artifact if run_id available
  const runId = extractRunIdFromResult(processed, args);
  if (runId) {
    const artifactName = `${name}_result_${Date.now()}.json`;
    const ref = writeRunJsonArtifact(runId, artifactName, { version: 1, result: processed });
    const summary = autoSummarize(processed, name);
    return {
      content: [
        { type: 'text', text: JSON.stringify({
          _result_too_large: true,
          size_bytes: size,
          artifact_uri: ref.uri,
          artifact_name: artifactName,
          summary,
        }) },
        { type: 'resource_link', uri: ref.uri, name: artifactName, mimeType: 'application/json' },
      ],
    };
  }

  // L3: no run context — hard truncate if beyond hard cap
  if (size > HARD_CAP_RESULT_BYTES) {
    const truncated = json.slice(0, HARD_CAP_RESULT_BYTES);
    return {
      content: [{ type: 'text', text: truncated + '\n... [TRUNCATED, original: ' + size + ' bytes]' }],
    };
  }

  // Between soft and hard cap, no run context — return as-is
  const content: ToolResultContentBlock[] = [{ type: 'text', text: json }];
  appendResourceLinks(content, processed);
  return { content };
}

function formatToolError(
  err: unknown,
  ctx?: ToolCallContext,
  traceId?: string
): { content: ToolResultContentBlock[]; isError: true } {
  const requestId = ctx?.requestId ?? null;
  const runId = null;

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
        run_id: runId,
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
      run_id: runId,
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
  durationMs: number;
  success: boolean;
}): void {
  const entry = {
    ts: new Date().toISOString(),
    level: params.success ? 'INFO' : 'ERROR',
    component: 'mcp_server',
    trace_id: params.traceId,
    event: 'tool_call',
    data: {
      tool_name: params.toolName,
      duration_ms: params.durationMs,
      success: params.success,
    },
  };
  try {
    process.stderr.write(JSON.stringify(entry) + '\n');
  } catch {
    // Best-effort: never break MCP protocol on log failure
  }
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  mode: ToolExposureMode = 'standard',
  ctx?: ToolCallContext
): Promise<{ content: ToolResultContentBlock[]; isError?: boolean }> {
  const reportProgress = createProgressReporter(ctx);
  // H-02: extract or generate trace_id for this tool call
  const { traceId, params: cleanArgs } = extractTraceId(args);

  // NEW-RT-03: optional span tracing
  const span = ctx?.spanSink?.startSpan(name, traceId);
  span?.setAttribute('tool.name', name);

  const startMs = Date.now();
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

    if (reportProgress) {
      reportProgress(0, 1, `started: ${name}`);
    }

    const parsedArgs = parseToolArgs(name, spec.zodSchema, cleanArgs) as unknown as Record<string, unknown>;
    const result = await spec.handler(parsedArgs, {
      reportProgress,
      rawArgs: cleanArgs,
      createMessage: ctx?.createMessage,
      callTool: async (toolName, toolArgs) => handleToolCall(
        toolName,
        { ...toolArgs, _chain_depth: chainDepth + 1 },
        mode,
        {
          requestId: ctx?.requestId,
          spanSink: ctx?.spanSink,
          createMessage: ctx?.createMessage,
        },
      ),
    });
    const resultWithSkillBridgeEnvelope = maybeAttachSkillBridgeJobEnvelope(result);
    recordToolUsage(name);
    const durationMs = Date.now() - startMs;

    // trace-jsonl: structured JSONL log to stderr (compatible with MCP stdio protocol)
    emitJsonlLog({ traceId, toolName: name, durationMs, success: true });

    if (reportProgress) reportProgress(1, 1, `completed: ${name}`);
    span?.end('OK');
    return formatToolResult(name, resultWithSkillBridgeEnvelope, parsedArgs);
  } catch (err) {
    const durationMs = Date.now() - startMs;
    if (reportProgress) reportProgress(1, 1, `failed: ${name}`);
    span?.setAttribute('error.type', err instanceof Error ? err.constructor.name : 'unknown');
    span?.setAttribute('error.message', err instanceof Error ? err.message : String(err));
    span?.end('ERROR');

    // trace-jsonl: structured JSONL log for failed tool calls
    emitJsonlLog({ traceId, toolName: name, durationMs, success: false });

    return formatToolError(err, ctx, traceId);
  }
}
