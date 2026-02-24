import { ZodError } from 'zod';
import {
  invalidParams,
  McpError,
  unsafeFs,
  HEP_RUN_PREFIX,
  HEP_PROJECT_CREATE,
  HEP_PROJECT_QUERY_EVIDENCE,
  HEP_RUN_CREATE,
  HEP_RUN_READ_ARTIFACT_CHUNK,
  HEP_RUN_WRITING_SUBMIT_REVIEW,
  HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1,
  INSPIRE_PARSE_LATEX,
  INSPIRE_SEARCH,
} from '@autoresearch/shared';
import type { Notification } from '@modelcontextprotocol/sdk/types.js';
import type { OutputFormat, SearchResultData } from '../utils/formatters.js';
import { formatSearchResultMarkdown } from '../utils/formatters.js';
import { getDataDir } from '../data/dataDir.js';
import { resolvePathWithinParent } from '../data/pathGuard.js';
import { writeRunJsonArtifact } from '../vnext/citations.js';
import { getRun } from '../vnext/runs.js';
import { assertSafePathSegment } from '../vnext/paths.js';
import { getToolSpec, isToolExposed, type ToolExposureMode } from './registry.js';
import { recordToolUsage } from './utils/toolUsageTelemetry.js';

export interface ToolCallContext {
  requestId?: string | number;
  progressToken?: string | number;
  sendNotification?: (notification: Notification) => Promise<void>;
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

      const runId = (() => {
        if (!argsObj) return null;
        const raw = argsObj.run_id;
        if (typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        if (!trimmed) return null;
        try {
          assertSafePathSegment(trimmed, 'run_id');
        } catch {
          return null;
        }
        try {
          getRun(trimmed);
        } catch {
          return null;
        }
        return trimmed;
      })();

      const parseError = (() => {
        if (!runId) return null;

        if (toolName === HEP_RUN_WRITING_SUBMIT_REVIEW) {
          const ref = writeRunJsonArtifact(runId, 'writing_parse_error_reviewer_report_v2.json', {
            version: 1,
            generated_at: new Date().toISOString(),
            run_id: runId,
            tool: toolName,
            issues: err.issues,
            received: {
              reviewer_report: (args as any)?.reviewer_report,
            },
          });

          return {
            parse_error_uri: ref.uri,
            parse_error_artifact: ref.name,
            next_actions: [
              {
                tool: HEP_RUN_READ_ARTIFACT_CHUNK,
                args: { run_id: runId, artifact_name: 'writing_reviewer_prompt.md', offset: 0, length: 4096 },
                reason: 'Read reviewer prompt (ReviewerReport v2 JSON contract).',
              },
              {
                tool: HEP_RUN_READ_ARTIFACT_CHUNK,
                args: { run_id: runId, artifact_name: 'writing_reviewer_context.md', offset: 0, length: 4096 },
                reason: 'Read reviewer context; then regenerate ReviewerReport v2 JSON with an LLM.',
              },
              {
                tool: HEP_RUN_WRITING_SUBMIT_REVIEW,
                args: {
                  run_id: runId,
                  reviewer_report: {
                    version: 2,
                    severity: 'minor',
                    summary: '(fill reviewer summary)',
                    major_issues: [],
                    minor_issues: [],
                    notation_changes: [],
                    asset_pointer_issues: [],
                    follow_up_evidence_queries: [],
                    structure_issues: [],
                    grounding_risks: [],
                  },
                },
                reason: 'Submit a valid ReviewerReport v2 JSON.',
              },
            ],
          };
        }

        if (toolName === HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1) {
          const ref = writeRunJsonArtifact(runId, 'writing_parse_error_revision_plan_v1.json', {
            version: 1,
            generated_at: new Date().toISOString(),
            run_id: runId,
            tool: toolName,
            issues: err.issues,
            received: {
              revision_plan: (args as any)?.revision_plan,
              revision_plan_uri: (args as any)?.revision_plan_uri,
            },
          });

          return {
            parse_error_uri: ref.uri,
            parse_error_artifact: ref.name,
            next_actions: [
              {
                tool: HEP_RUN_WRITING_SUBMIT_REVISION_PLAN_V1,
                args: { run_id: runId, revision_plan: '<paste RevisionPlan v1 JSON here or use revision_plan_uri>' },
                reason: 'Submit a valid RevisionPlan v1 JSON.',
              },
            ],
          };
        }

        return null;
      })();

      const data: Record<string, unknown> = {
        issues: err.issues,
      };

      if (parseError) {
        data.parse_error_uri = parseError.parse_error_uri;
        data.parse_error_artifact = parseError.parse_error_artifact;
        data.next_actions = parseError.next_actions;
      } else if (missingRunIdForProjectSemanticQuery) {
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
    : `hep://runs/${encodeURIComponent(runId)}/manifest`;

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

function formatToolResult(
  name: string,
  result: unknown,
  args: Record<string, unknown>
): { content: { type: string; text: string }[] } {
  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] };
  }

  const format = (args.format as OutputFormat) || 'json';

  if (name === INSPIRE_SEARCH && format === 'markdown') {
    const r = result as SearchResultData & { total: number; papers: any[]; next_url?: string };
    const rawHasMore = (r as Partial<SearchResultData>).has_more;
    const pageRaw = args.page;
    const sizeRaw = args.size;
    const page = typeof pageRaw === 'number' && Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
    const size = typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) ? Math.max(1, Math.trunc(sizeRaw)) : 10;
    const shown = (page - 1) * size + (Array.isArray(r.papers) ? r.papers.length : 0);
    const fallbackHasMore = r.total > shown;
    const hasMore = typeof rawHasMore === 'boolean' ? rawHasMore : fallbackHasMore;
    const nextUrl = typeof r.next_url === 'string' && r.next_url.trim().length > 0 ? r.next_url.trim() : undefined;

    let text = formatSearchResultMarkdown({
      total: r.total,
      papers: r.papers,
      has_more: hasMore,
    });

    if (hasMore && nextUrl) {
      text += `\n\n---\n\nNext page: call \`inspire_search_next\` with \`next_url\`:\n\n\`\`\`\n${nextUrl}\n\`\`\`\n`;
    }

    return {
      content: [{
        type: 'text',
        text,
      }],
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

function formatToolError(
  err: unknown,
  ctx?: ToolCallContext
): { content: { type: string; text: string }[]; isError: true } {
  const requestId = ctx?.requestId ?? null;
  const runId = null;

  const payload = (() => {
    if (err instanceof McpError) {
      return {
        error: {
          code: err.code,
          message: err.message,
          data: err.data,
        },
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
      request_id: requestId,
      run_id: runId,
    };
  })();

  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  mode: ToolExposureMode = 'standard',
  ctx?: ToolCallContext
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const reportProgress = createProgressReporter(ctx);
  try {
    const spec = getToolSpec(name);
    if (!spec) {
      throw invalidParams(`Unknown tool: ${name}`);
    }
    if (!isToolExposed(spec, mode)) {
      throw invalidParams(`Tool not exposed in ${mode} mode: ${name}`);
    }

    validatePathArgs(args);

    if (reportProgress) {
      reportProgress(0, 1, `started: ${name}`);
    }

    const parsedArgs = parseToolArgs(name, spec.zodSchema, args) as unknown as Record<string, unknown>;
    const result = await spec.handler(parsedArgs, { reportProgress, rawArgs: args });
    const resultWithSkillBridgeEnvelope = maybeAttachSkillBridgeJobEnvelope(result);
    recordToolUsage(name);

    if (reportProgress) reportProgress(1, 1, `completed: ${name}`);
    return formatToolResult(name, resultWithSkillBridgeEnvelope, parsedArgs);
  } catch (err) {
    if (reportProgress) reportProgress(1, 1, `failed: ${name}`);
    return formatToolError(err, ctx);
  }
}
