import { McpClient, type McpToolResult, type ToolCaller } from './mcp-client.js';
import * as path from 'node:path';
import { writeJsonAtomic } from './computation/io.js';

export type PersistedWorkflowExecution = {
  action: string | null;
  tool: string;
  provider: string | null;
  depends_on: string[];
  params: Record<string, unknown>;
  required_capabilities: string[];
  degrade_mode: string | null;
  consumer_hints: Record<string, unknown> | null;
};

export type PersistedWorkflowPlanStep = {
  step_id: string;
  description: string;
  status: string;
  execution: PersistedWorkflowExecution | null;
};

export type WorkflowRuntimeRequest = {
  project_root: string;
  workflow_id: string;
  run_id: string;
  step_id: string;
  description: string;
  tool: string;
  provider: string | null;
  action: string | null;
  params: Record<string, unknown>;
  depends_on: string[];
  required_capabilities: string[];
  degrade_mode: 'fail_closed' | 'skip_with_reason' | 'partial_result';
  artifact_key: string;
  project_required: boolean;
  run_required: boolean;
};

export type WorkflowRuntimeDiagnosticCode =
  | 'malformed_execution'
  | 'project_required_missing'
  | 'run_required_missing'
  | 'no_mcp_tool_server'
  | 'malformed_mcp_env'
  | 'mcp_server_unavailable'
  | 'unsupported_tool'
  | 'tool_call_failed'
  | 'malformed_tool_result'
  | 'multiple_artifacts'
  | 'partial_result'
  | 'skip_with_reason';

export type WorkflowRuntimeDiagnostic = {
  code: WorkflowRuntimeDiagnosticCode;
  message: string;
  details?: Record<string, unknown>;
};

export type WorkflowRuntimeResult =
  | {
      status: 'completed';
      payload: unknown;
      raw_text: string;
      summary_text: string;
      canonical_artifact_uri: string | null;
      additional_artifact_uris: string[];
      diagnostics: WorkflowRuntimeDiagnostic[];
    }
  | {
      status: 'partial';
      payload: unknown;
      raw_text: string;
      summary_text: string;
      canonical_artifact_uri: string | null;
      additional_artifact_uris: string[];
      diagnostics: WorkflowRuntimeDiagnostic[];
    }
  | {
      status: 'skipped';
      payload: unknown;
      raw_text: string;
      summary_text: string;
      canonical_artifact_uri: string | null;
      additional_artifact_uris: string[];
      diagnostics: WorkflowRuntimeDiagnostic[];
    }
  | {
      status: 'failed';
      payload: null;
      raw_text: string;
      summary_text: string;
      canonical_artifact_uri: null;
      additional_artifact_uris: [];
      diagnostics: WorkflowRuntimeDiagnostic[];
    };

export type WorkflowRuntimeDeps = {
  workflowToolCaller?: ToolCaller;
};

type WorkflowToolServerConfig = {
  command: string;
  args: string[];
  env: Record<string, string> | undefined;
};

function toolMessage(toolResult: McpToolResult, fallbackTool: string): string {
  return toolResult.rawText || `tool call failed: ${fallbackTool}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDegradeMode(raw: string | null): WorkflowRuntimeRequest['degrade_mode'] {
  if (raw === 'skip_with_reason' || raw === 'partial_result') return raw;
  return 'fail_closed';
}

function isConnectionScanWithoutRecids(request: WorkflowRuntimeRequest): boolean {
  return request.step_id === 'connection_scan'
    && Array.isArray(request.params.recids)
    && request.params.recids.length === 0;
}

function skippedConnectionScanArtifact(request: WorkflowRuntimeRequest): {
  payload: Record<string, unknown>;
  artifact_uri: string;
} {
  const relativeArtifactPath = ['artifacts', 'runs', request.run_id, 'workflow_steps', `${request.step_id}.json`].join('/');
  const artifactPath = path.join(request.project_root, ...relativeArtifactPath.split('/'));
  const payload = {
    schema_version: 1,
    workflow_id: request.workflow_id,
    run_id: request.run_id,
    step_id: request.step_id,
    status: 'skipped',
    reason: 'no_input_recids',
    summary: 'No recids were available, so connection analysis was skipped.',
    inputs: {
      recids: [],
    },
  };
  writeJsonAtomic(artifactPath, payload);
  return {
    payload,
    artifact_uri: `orch://runs/${request.run_id}/artifact/workflow_steps/${request.step_id}.json`,
  };
}

function isInfrastructureDiagnosticCode(code: WorkflowRuntimeDiagnosticCode): boolean {
  return code === 'project_required_missing'
    || code === 'run_required_missing'
    || code === 'no_mcp_tool_server'
    || code === 'malformed_mcp_env'
    || code === 'mcp_server_unavailable'
    || code === 'malformed_execution';
}

function textSummary(value: unknown, rawText = ''): string {
  if (typeof value === 'string') return value;
  if (value !== null && value !== undefined) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return rawText;
}

function collectArtifactUris(payload: unknown): {
  canonical_artifact_uri: string | null;
  additional_artifact_uris: string[];
  diagnostics: WorkflowRuntimeDiagnostic[];
} {
  const diagnostics: WorkflowRuntimeDiagnostic[] = [];
  const candidateUris: string[] = [];

  if (isRecord(payload)) {
    if (typeof payload.uri === 'string' && payload.uri.trim()) {
      candidateUris.push(payload.uri);
    }
    const summary = payload.summary;
    if (isRecord(summary) && typeof summary.uri === 'string' && summary.uri.trim()) {
      candidateUris.push(summary.uri);
    }
    const artifacts = payload.artifacts;
    if (artifacts !== undefined) {
      if (!Array.isArray(artifacts)) {
        diagnostics.push({
          code: 'malformed_tool_result',
          message: 'runtime result artifacts must be an array when present',
        });
      } else {
        for (const artifact of artifacts) {
          if (!isRecord(artifact)) {
            diagnostics.push({
              code: 'malformed_tool_result',
              message: 'runtime result artifact entries must be objects',
            });
            continue;
          }
          if (typeof artifact.uri === 'string' && artifact.uri.trim()) {
            candidateUris.push(artifact.uri);
          }
        }
      }
    }
  }

  const uniqueUris = [...new Set(candidateUris)];
  const canonicalArtifactUri = uniqueUris[0] ?? null;
  const additionalArtifactUris = uniqueUris.slice(1);
  if (additionalArtifactUris.length > 0) {
    diagnostics.push({
      code: 'multiple_artifacts',
      message: 'workflow runtime returned multiple artifact URIs; using the first as canonical',
      details: {
        canonical_artifact_uri: canonicalArtifactUri,
        additional_artifact_uris: additionalArtifactUris,
      },
    });
  }
  return {
    canonical_artifact_uri: canonicalArtifactUri,
    additional_artifact_uris: additionalArtifactUris,
    diagnostics,
  };
}

function makeTerminalResult(
  request: WorkflowRuntimeRequest,
  base: { payload: unknown; raw_text: string; summary_text: string },
  diagnostics: WorkflowRuntimeDiagnostic[],
): WorkflowRuntimeResult {
  const artifacts = collectArtifactUris(base.payload);
  const allDiagnostics = [...artifacts.diagnostics, ...diagnostics];
  if (request.degrade_mode === 'skip_with_reason') {
    return {
      status: 'skipped',
      payload: base.payload,
      raw_text: base.raw_text,
      summary_text: base.summary_text,
      canonical_artifact_uri: artifacts.canonical_artifact_uri,
      additional_artifact_uris: artifacts.additional_artifact_uris,
      diagnostics: allDiagnostics.some(diagnostic => diagnostic.code === 'skip_with_reason')
        ? allDiagnostics
        : [{ code: 'skip_with_reason', message: base.summary_text }, ...allDiagnostics],
    };
  }
  if (request.degrade_mode === 'partial_result') {
    return {
      status: 'partial',
      payload: base.payload,
      raw_text: base.raw_text,
      summary_text: base.summary_text,
      canonical_artifact_uri: artifacts.canonical_artifact_uri,
      additional_artifact_uris: artifacts.additional_artifact_uris,
      diagnostics: allDiagnostics.some(diagnostic => diagnostic.code === 'partial_result')
        ? allDiagnostics
        : [{ code: 'partial_result', message: base.summary_text }, ...allDiagnostics],
    };
  }
  return {
    status: 'failed',
    payload: null,
    raw_text: base.raw_text,
    summary_text: base.summary_text,
    canonical_artifact_uri: null,
    additional_artifact_uris: [],
    diagnostics: allDiagnostics,
  };
}

export function parsePersistedWorkflowExecution(raw: unknown): PersistedWorkflowExecution | null {
  if (!isRecord(raw)) return null;
  const tool = typeof raw.tool === 'string' ? raw.tool.trim() : '';
  if (!tool) return null;
  return {
    action: typeof raw.action === 'string' && raw.action.trim() ? raw.action : null,
    tool,
    provider: typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider : null,
    depends_on: Array.isArray(raw.depends_on) ? raw.depends_on.map(String) : [],
    params: isRecord(raw.params) ? { ...raw.params } : {},
    required_capabilities: Array.isArray(raw.required_capabilities) ? raw.required_capabilities.map(String) : [],
    degrade_mode: typeof raw.degrade_mode === 'string' && raw.degrade_mode.trim() ? raw.degrade_mode : null,
    consumer_hints: isRecord(raw.consumer_hints) ? { ...raw.consumer_hints } : null,
  };
}

export function compileWorkflowRuntimeRequest(params: {
  projectRoot: string | null;
  workflowId: string;
  runId: string | null;
  step: PersistedWorkflowPlanStep;
}): WorkflowRuntimeRequest {
  if (!params.step.execution) {
    throw new Error(`workflow step ${params.step.step_id} is missing execution metadata`);
  }
  const { execution } = params.step;
  const artifactHint = typeof execution.consumer_hints?.artifact === 'string'
    ? execution.consumer_hints.artifact.trim()
    : '';
  const projectRequired = execution.consumer_hints?.project_required === true;
  const runRequired = execution.consumer_hints?.run_required === true;
  if (projectRequired && !params.projectRoot) {
    throw new Error(`workflow step ${params.step.step_id} requires project_root`);
  }
  if (runRequired && !params.runId) {
    throw new Error(`workflow step ${params.step.step_id} requires run_id`);
  }
  return {
    project_root: params.projectRoot ?? '',
    workflow_id: params.workflowId,
    run_id: params.runId ?? '',
    step_id: params.step.step_id,
    description: params.step.description,
    tool: execution.tool,
    provider: execution.provider,
    action: execution.action,
    params: { ...execution.params },
    depends_on: [...execution.depends_on],
    required_capabilities: [...execution.required_capabilities],
    degrade_mode: normalizeDegradeMode(execution.degrade_mode),
    artifact_key: artifactHint || params.step.step_id,
    project_required: projectRequired,
    run_required: runRequired,
  };
}

export function normalizeWorkflowRuntimeResult(
  request: WorkflowRuntimeRequest,
  toolResult: McpToolResult,
): WorkflowRuntimeResult {
  if (!toolResult.ok || toolResult.isError) {
    const message = toolMessage(toolResult, request.tool);
    const code: WorkflowRuntimeDiagnosticCode = /unsupported|not available|not found/i.test(message)
      ? 'unsupported_tool'
      : 'tool_call_failed';
    return makeTerminalResult(
      request,
      {
        payload: toolResult.json,
        raw_text: toolResult.rawText,
        summary_text: message,
      },
      [{ code, message, ...(toolResult.errorCode ? { details: { error_code: toolResult.errorCode } } : {}) }],
    );
  }

  const payload = toolResult.json ?? toolResult.rawText;
  const artifacts = collectArtifactUris(toolResult.json);

  return {
    status: 'completed',
    payload,
    raw_text: toolResult.rawText,
    summary_text: textSummary(toolResult.json, toolResult.rawText),
    canonical_artifact_uri: artifacts.canonical_artifact_uri,
    additional_artifact_uris: artifacts.additional_artifact_uris,
    diagnostics: artifacts.diagnostics.map(diagnostic =>
      diagnostic.code === 'multiple_artifacts'
        ? {
            ...diagnostic,
            message: `workflow step ${request.step_id} returned multiple artifact URIs; using the first as canonical`,
          }
        : diagnostic),
  };
}

function parseWorkflowJsonEnv<T>(
  name: 'AUTORESEARCH_RUN_MCP_ARGS_JSON' | 'AUTORESEARCH_RUN_MCP_ENV_JSON',
  raw: string,
): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    if (name === 'AUTORESEARCH_RUN_MCP_ARGS_JSON') {
      throw new Error('AUTORESEARCH_RUN_MCP_ARGS_JSON must decode to a JSON string array');
    }
    throw new Error('AUTORESEARCH_RUN_MCP_ENV_JSON must decode to a JSON object');
  }
}

export function loadWorkflowToolServerConfigFromEnv(): WorkflowToolServerConfig | null {
  const command = (process.env.AUTORESEARCH_RUN_MCP_COMMAND ?? '').trim();
  if (!command) return null;
  const argsRaw = (process.env.AUTORESEARCH_RUN_MCP_ARGS_JSON ?? '').trim();
  const envRaw = (process.env.AUTORESEARCH_RUN_MCP_ENV_JSON ?? '').trim();
  const args = argsRaw ? parseWorkflowJsonEnv<unknown>('AUTORESEARCH_RUN_MCP_ARGS_JSON', argsRaw) : [];
  if (!Array.isArray(args) || !args.every(item => typeof item === 'string')) {
    throw new Error('AUTORESEARCH_RUN_MCP_ARGS_JSON must decode to a JSON string array');
  }
  let env: Record<string, string> | undefined;
  if (envRaw) {
    const parsed = parseWorkflowJsonEnv<unknown>('AUTORESEARCH_RUN_MCP_ENV_JSON', envRaw);
    if (!isRecord(parsed)) {
      throw new Error('AUTORESEARCH_RUN_MCP_ENV_JSON must decode to a JSON object');
    }
    env = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  }
  return { command, args, env };
}

async function withWorkflowToolCaller<T>(
  deps: WorkflowRuntimeDeps,
  fn: (toolCaller: ToolCaller) => Promise<T>,
): Promise<T> {
  if (deps.workflowToolCaller) {
    return fn(deps.workflowToolCaller);
  }
  const serverConfig = loadWorkflowToolServerConfigFromEnv();
  if (!serverConfig) {
    throw new Error(
      'workflow step execution requires a configured MCP tool server; set AUTORESEARCH_RUN_MCP_COMMAND and optional AUTORESEARCH_RUN_MCP_ARGS_JSON/AUTORESEARCH_RUN_MCP_ENV_JSON',
    );
  }
  const client = new McpClient();
  await client.start(serverConfig.command, serverConfig.args, serverConfig.env);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export async function executeWorkflowRuntimeRequest(
  request: WorkflowRuntimeRequest,
  deps: WorkflowRuntimeDeps = {},
): Promise<WorkflowRuntimeResult> {
  if (isConnectionScanWithoutRecids(request)) {
    const skipped = skippedConnectionScanArtifact(request);
    return {
      status: 'skipped',
      payload: skipped.payload,
      raw_text: 'skipped because no_input_recids',
      summary_text: 'skipped because no_input_recids',
      canonical_artifact_uri: skipped.artifact_uri,
      additional_artifact_uris: [],
      diagnostics: [{
        code: 'skip_with_reason',
        message: 'skipped because no_input_recids',
        details: {
          reason: 'no_input_recids',
          step_id: request.step_id,
          artifact_uri: skipped.artifact_uri,
        },
      }],
    };
  }
  try {
    const toolResult = await withWorkflowToolCaller(deps, toolCaller => toolCaller.callTool(request.tool, request.params));
    return normalizeWorkflowRuntimeResult(request, toolResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code: WorkflowRuntimeDiagnosticCode = message.startsWith('AUTORESEARCH_RUN_MCP_')
      ? 'malformed_mcp_env'
      : message.includes('requires a configured MCP tool server')
        ? 'no_mcp_tool_server'
        : /McpClient|MCP process|No stdout|not initialized|timed out/i.test(message)
          ? 'mcp_server_unavailable'
          : /unsupported|not available|not found/i.test(message)
            ? 'unsupported_tool'
            : 'tool_call_failed';
    const diagnostics: WorkflowRuntimeDiagnostic[] = [{ code, message }];
    if (isInfrastructureDiagnosticCode(code)) {
      return {
        status: 'failed',
        payload: null,
        raw_text: '',
        summary_text: message,
        canonical_artifact_uri: null,
        additional_artifact_uris: [],
        diagnostics,
      };
    }
    return makeTerminalResult(
      request,
      {
        payload: null,
        raw_text: '',
        summary_text: message,
      },
      diagnostics,
    );
  }
}
