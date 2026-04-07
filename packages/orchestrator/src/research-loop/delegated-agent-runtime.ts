import * as path from 'node:path';
import type { ApprovalGate } from '../approval-gate.js';
import { AgentRunner, type AgentEvent, type MessageParam, type Tool } from '../agent-runner.js';
import type { ChatBackendFactory } from '../backends/backend-factory.js';
import type { MessagesCreateFn, ToolUseContent } from '../backends/chat-backend.js';
import { bindToolPermissionView, type ToolCaller, type ToolPermissionView } from '../mcp-client.js';
import { RunManifestManager, type RunManifest } from '../run-manifest.js';
import {
  buildRuntimeToolPermissionView,
  filterToolsForPermissionView,
} from '../tool-execution-policy.js';
import {
  writeRuntimeDiagnosticsBridgeArtifact,
  type RuntimeDiagnosticsSummaryV1,
} from '../runtime-diagnostics-bridge.js';
import type { SpanCollector } from '../tracing.js';
import {
  delegatedRuntimeArtifactRefs,
  type DelegatedRuntimeHandleV1,
} from '../delegated-runtime-handle.js';
import type { DelegatedRuntimeProjectionV1 } from './delegated-runtime-projection.js';

export interface ExecuteDelegatedAgentRuntimeInput {
  projectRoot: string;
  runId: string;
  model: string;
  messages: MessageParam[];
  tools: Tool[];
  mcpClient: ToolCaller;
  toolPermissionView?: ToolPermissionView;
  delegated_runtime_handle?: DelegatedRuntimeHandleV1;
  approvalGate: ApprovalGate;
  resumeFrom?: string;
  maxTurns?: number;
  routingConfig?: unknown;
  spanCollector?: SpanCollector;
  backendFactory?: ChatBackendFactory;
  _messagesCreate?: MessagesCreateFn;
}

export interface ExecuteDelegatedAgentRuntimeResult {
  events: AgentEvent[];
  runtime_projection: DelegatedRuntimeProjectionV1;
  manifest: RunManifest | null;
  manifest_path: string;
  spans_path: string;
  runtime_diagnostics_bridge_path: string;
  runtime_diagnostics_summary: RuntimeDiagnosticsSummaryV1;
  resume_from: string | null;
  resumed: boolean;
  skipped_step_ids: string[];
  last_completed_step: string | null;
}

function createManifestManager(projectRoot: string): RunManifestManager {
  return new RunManifestManager(path.join(projectRoot, 'artifacts', 'runs'));
}

function pendingToolUses(messages: MessageParam[]): ToolUseContent[] {
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) {
    return [];
  }
  return last.content.filter((block): block is ToolUseContent => block.type === 'tool_use');
}

function buildResumeManifest(manifest: RunManifest | null, resumeFrom?: string): RunManifest | null {
  if (!manifest) {
    return null;
  }
  const effectiveResumeFrom = resumeFrom ?? manifest.last_completed_step ?? manifest.resume_from;
  if (!effectiveResumeFrom) {
    return manifest;
  }
  return { ...manifest, resume_from: effectiveResumeFrom };
}

export async function executeDelegatedAgentRuntime(
  input: ExecuteDelegatedAgentRuntimeInput,
): Promise<ExecuteDelegatedAgentRuntimeResult> {
  if (input.delegated_runtime_handle
    && input.delegated_runtime_handle.identity.runtime_run_id !== input.runId) {
    throw new Error('delegated runtime handle run id mismatch');
  }
  const artifactRefs = input.delegated_runtime_handle?.artifacts
    ?? delegatedRuntimeArtifactRefs({ runtime_run_id: input.runId });
  const manifestManager = createManifestManager(input.projectRoot);
  const persistedManifest = manifestManager.loadManifest(input.runId);
  const runtimeManifest = buildResumeManifest(persistedManifest, input.resumeFrom);
  const toolPermissionView = input.toolPermissionView ?? buildRuntimeToolPermissionView({
    tools: input.tools,
    scope: 'agent_session',
    authority: 'runtime_tools',
  });
  const skippedStepIds = runtimeManifest
    ? pendingToolUses(input.messages)
      .map(toolUse => toolUse.id)
      .filter(stepId => manifestManager.shouldSkipStep(runtimeManifest, stepId))
    : [];
  const runner = new AgentRunner({
    model: input.model,
    maxTurns: input.maxTurns,
    runId: input.runId,
    mcpClient: bindToolPermissionView(input.mcpClient, toolPermissionView),
    approvalGate: input.approvalGate,
    spanCollector: input.spanCollector,
    routingConfig: input.routingConfig,
    backendFactory: input.backendFactory,
    manifestManager,
    _messagesCreate: input._messagesCreate,
  });
  const events: AgentEvent[] = [];
  const visibleTools = filterToolsForPermissionView(input.tools, toolPermissionView);
  for await (const event of runner.run(input.messages, visibleTools, runtimeManifest ? { manifest: runtimeManifest } : undefined)) {
    events.push(event);
  }
  const savedManifest = manifestManager.loadManifest(input.runId);
  const runtimeProjection = runner.runtimeProjection ?? {
    version: 1,
    turn_count: 0,
    recovery_turn_count: 0,
    dialogue_turn_count: 0,
    projected_turns: [],
    runtime_marker_kinds: [],
    approval_requested: false,
    terminal_outcome: null,
  };
  const diagnosticsBridge = writeRuntimeDiagnosticsBridgeArtifact({
    projectRoot: input.projectRoot,
    runId: input.runId,
    runtimeProjection,
    manifestPath: artifactRefs.manifest_path,
    spansPath: artifactRefs.spans_path,
    savedManifest,
  });
  if (diagnosticsBridge.artifactPath !== artifactRefs.runtime_diagnostics_bridge_path) {
    throw new Error('delegated runtime diagnostics bridge path mismatch');
  }
  return {
    events,
    runtime_projection: runtimeProjection,
    manifest: savedManifest,
    manifest_path: artifactRefs.manifest_path,
    spans_path: artifactRefs.spans_path,
    runtime_diagnostics_bridge_path: artifactRefs.runtime_diagnostics_bridge_path,
    runtime_diagnostics_summary: diagnosticsBridge.payload.summary,
    resume_from: runtimeManifest?.resume_from ?? null,
    resumed: runtimeManifest?.resume_from !== undefined,
    skipped_step_ids: skippedStepIds,
    last_completed_step: savedManifest?.last_completed_step ?? null,
  };
}
