import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpError, internalError } from '@nullius/shared';
import type { MessageContent, MessageParam, ToolResultContent, ToolUseContent } from './backends/chat-backend.js';
import { normalizeStopReason } from './agent-runner-stop-reasons.js';
import {
  buildTruncationRecovery,
  evaluateLowGainTurn,
  resetLowGainTracking,
  type AgentRuntimeMarkerEvent,
  type AgentRuntimeState,
} from './agent-runner-runtime-state.js';
import {
  groupToolUsesForExecution,
  snapshotJsonExecutionValue,
  type FrozenToolUseExecution,
  type FrozenToolUseExecutionGroup,
} from './agent-runner-tool-groups.js';
import type { McpToolResult, ToolCaller } from './mcp-client.js';
import {
  canonicalJson,
  createToolAttemptIdentity,
  type RunManifestManager,
  type ToolAttemptClassification,
  type ToolAttemptIdentity,
} from './run-manifest.js';
import type { SpanCollector } from './tracing.js';
import { parseRunGateApprovalRequest, type RunGateApprovalRequest } from './tool-approval-envelope.js';
import type { ToolPermissionView } from './tool-execution-policy.js';

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; input: unknown; result: unknown }
  | {
      type: 'approval_required';
      authority: 'run_gate';
      gateId: string;
      runId: string;
      approvalId: string;
      packetPath: string;
      approvalPacketSha256: string;
    }
  | {
      type: 'tool_outcome_unknown';
      stepId: string;
      name: string;
      inputSha256: string;
      phase: 'dialogue' | 'recovery';
      reason: 'dispatch_interrupted' | 'missing_durable_intent';
      message: string;
    }
  | AgentRuntimeMarkerEvent
  | { type: 'done'; stopReason: string; turnCount: number }
  | { type: 'error'; error: McpError };

export function asMcpError(error: unknown, prefix = ''): McpError {
  if (error instanceof McpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new McpError('INTERNAL_ERROR', `${prefix}${message}`);
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

type ToolExecutionSignature = { call: string; outcome: string; isError: boolean };

type ToolExecution = {
  events: AgentEvent[];
  toolResult: ToolResultContent | null;
  done: boolean;
  signature: ToolExecutionSignature | null;
  unknown: boolean;
};

function snapshotAssistantContent(blocks: MessageContent[]): MessageContent[] {
  const snapshot = snapshotJsonExecutionValue(blocks, 'assistant response.content');
  if (!Array.isArray(snapshot)) {
    throw internalError('Assistant response content must be an array.');
  }
  for (const [index, block] of snapshot.entries()) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw internalError(`Assistant response block ${index} must be an object.`);
    }
    const type = (block as Record<string, unknown>)['type'];
    if (type !== 'text' && type !== 'tool_use' && type !== 'tool_result') {
      throw internalError(`Assistant response block ${index} has an unsupported type.`);
    }
    if (type === 'text' && typeof (block as Record<string, unknown>)['text'] !== 'string') {
      throw internalError(`Assistant response text block ${index} is malformed.`);
    }
    if (type === 'tool_result'
      && (typeof (block as Record<string, unknown>)['tool_use_id'] !== 'string'
        || typeof (block as Record<string, unknown>)['content'] !== 'string')) {
      throw internalError(`Assistant response tool-result block ${index} is malformed.`);
    }
  }
  return snapshot as MessageContent[];
}

function toolExecutionSignature(block: ToolUseContent, result: McpToolResult): ToolExecutionSignature {
  const call = `${block.name}:${canonicalJson(block.input)}`;
  return {
    call,
    outcome: `${call}:${result.isError ? 'err' : 'ok'}:${hashText(result.rawText)}`,
    isError: result.isError,
  };
}

function toolCallEvent(block: ToolUseContent, result: McpToolResult): AgentEvent {
  return { type: 'tool_call', name: block.name, input: block.input, result: result.json ?? result.rawText };
}

function approvalEvents(request: RunGateApprovalRequest, turnCount: number): AgentEvent[] {
  return [
    {
      type: 'approval_required',
      authority: request.authority,
      gateId: request.gateId,
      runId: request.runId,
      approvalId: request.approvalId,
      packetPath: request.packetPath,
      approvalPacketSha256: request.approvalPacketSha256,
    },
    { type: 'done', stopReason: 'approval_required', turnCount },
  ];
}

function unknownExecution(params: {
  attempt: ToolAttemptIdentity;
  block: ToolUseContent;
  phase: 'dialogue' | 'recovery';
  turnCount: number;
  reason: 'dispatch_interrupted' | 'missing_durable_intent';
  error?: unknown;
}): ToolExecution {
  const detail = params.error instanceof Error ? params.error.message : params.error ? String(params.error) : '';
  const message = params.reason === 'missing_durable_intent'
    ? 'The pending tool call has no durable pre-dispatch intent. Automatic execution is unsafe.'
    : `The tool was dispatched but its outcome is not durably known.${detail ? ` ${detail}` : ''}`;
  return {
    events: [
      {
        type: 'tool_outcome_unknown',
        stepId: params.attempt.step_id,
        name: params.block.name,
        inputSha256: params.attempt.input_sha256,
        phase: params.phase,
        reason: params.reason,
        message,
      },
      { type: 'done', stopReason: 'tool_outcome_unknown', turnCount: params.turnCount },
    ],
    toolResult: null,
    done: true,
    signature: null,
    unknown: true,
  };
}

function committedExecution(params: {
  frozen: FrozenToolUseExecution;
  result: McpToolResult;
  turnCount: number;
}): ToolExecution {
  const approval = parseRunGateApprovalRequest(
    params.frozen.toolUse.name,
    params.result,
    params.frozen.executionPolicy,
  );
  if (approval) {
    throw internalError('A run-gate approval response must never be stored as a committed tool checkpoint.');
  }
  return {
    events: [toolCallEvent(params.frozen.toolUse, params.result)],
    toolResult: {
      type: 'tool_result',
      tool_use_id: params.frozen.toolUse.id,
      content: params.result.rawText,
    },
    done: false,
    signature: toolExecutionSignature(params.frozen.toolUse, params.result),
    unknown: false,
  };
}

async function callDispatchedTool(params: {
  frozen: FrozenToolUseExecution;
  attempt: ToolAttemptIdentity;
  turnCount: number;
  phase: 'dialogue' | 'recovery';
  traceId: string;
  mcpClient: ToolCaller;
  spanCollector: SpanCollector | null;
  manifestManager: RunManifestManager;
  runId: string;
  approvalRunId: string;
}): Promise<ToolExecution> {
  const { frozen, attempt } = params;
  const toolSpan = params.spanCollector?.startSpan(frozen.toolUse.name, params.traceId);
  let result: McpToolResult;
  try {
    result = await params.mcpClient.callTool(frozen.toolUse.name, frozen.toolUse.input);
  } catch (error) {
    toolSpan?.end('ERROR');
    return unknownExecution({
      attempt,
      block: frozen.toolUse,
      phase: params.phase,
      turnCount: params.turnCount,
      reason: 'dispatch_interrupted',
      error,
    });
  }

  let approval: RunGateApprovalRequest | null;
  try {
    approval = parseRunGateApprovalRequest(frozen.toolUse.name, result, frozen.executionPolicy);
  } catch (error) {
    try {
      params.manifestManager.commitToolAttempt(params.runId, attempt, result);
    } catch (commitError) {
      toolSpan?.end('ERROR');
      return unknownExecution({
        attempt,
        block: frozen.toolUse,
        phase: params.phase,
        turnCount: params.turnCount,
        reason: 'dispatch_interrupted',
        error: commitError,
      });
    }
    toolSpan?.end('ERROR');
    throw error;
  }

  if (approval) {
    if (approval.runId !== params.approvalRunId) {
      try {
        params.manifestManager.commitToolAttempt(params.runId, attempt, result);
      } catch (commitError) {
        toolSpan?.end('ERROR');
        return unknownExecution({
          attempt,
          block: frozen.toolUse,
          phase: params.phase,
          turnCount: params.turnCount,
          reason: 'dispatch_interrupted',
          error: commitError,
        });
      }
      toolSpan?.end('ERROR');
      throw internalError(
        `Tool ${frozen.toolUse.name} returned an approval for run ${approval.runId}, expected ${params.approvalRunId}.`,
      );
    }
    try {
      params.manifestManager.resetOutcomeUnknownAtApprovalBoundary(params.runId, attempt, {
        authority: approval.authority,
        gate_id: approval.gateId,
        run_id: approval.runId,
        approval_id: approval.approvalId,
        packet_path: approval.packetPath,
        approval_packet_sha256: approval.approvalPacketSha256,
      });
    } catch (error) {
      toolSpan?.end('ERROR');
      return unknownExecution({
        attempt,
        block: frozen.toolUse,
        phase: params.phase,
        turnCount: params.turnCount,
        reason: 'dispatch_interrupted',
        error,
      });
    }
    toolSpan?.end('OK');
    return {
      events: [toolCallEvent(frozen.toolUse, result), ...approvalEvents(approval, params.turnCount)],
      toolResult: null,
      done: true,
      signature: toolExecutionSignature(frozen.toolUse, result),
      unknown: false,
    };
  }

  try {
    params.manifestManager.commitToolAttempt(params.runId, attempt, result);
  } catch (error) {
    toolSpan?.end('ERROR');
    return unknownExecution({
      attempt,
      block: frozen.toolUse,
      phase: params.phase,
      turnCount: params.turnCount,
      reason: 'dispatch_interrupted',
      error,
    });
  }
  toolSpan?.end(result.isError ? 'ERROR' : 'OK');
  return committedExecution({ frozen, result, turnCount: params.turnCount });
}

function classificationByStep(
  classifications: ReadonlyArray<ToolAttemptClassification>,
): Map<string, ToolAttemptClassification> {
  return new Map(classifications.map(classification => [classification.identity.step_id, classification]));
}

function normalizedProjectRoot(value: string): string {
  const expanded = value === '~'
    ? os.homedir()
    : value.startsWith('~/')
      ? path.join(os.homedir(), value.slice(2))
      : value;
  return path.resolve(expanded);
}

async function executePreparedToolUseGroups(params: {
  groups: ReadonlyArray<FrozenToolUseExecutionGroup>;
  attempts: ReadonlyArray<ToolAttemptIdentity>;
  turnCount: number;
  phase: 'dialogue' | 'recovery';
  traceId: string;
  mcpClient: ToolCaller;
  spanCollector: SpanCollector | null;
  manifestManager: RunManifestManager;
  runId: string;
  approvalRunId: string;
}): Promise<{ events: AgentEvent[]; toolResults: ToolResultContent[]; done: boolean; signatures: ToolExecutionSignature[] }> {
  const classifications = params.manifestManager.classifyToolAttempts(params.runId, params.attempts);
  const classificationMap = classificationByStep(classifications);
  const unsafe = classifications.find(item => item.state === 'outcome_unknown' || item.state === 'missing');
  if (unsafe) {
    const frozen = params.groups.flat().find(item => item.toolUse.id === unsafe.identity.step_id);
    if (!frozen) throw internalError(`Missing frozen tool use for ${unsafe.identity.step_id}.`);
    const unknown = unknownExecution({
      attempt: unsafe.identity,
      block: frozen.toolUse,
      phase: params.phase,
      turnCount: params.turnCount,
      reason: unsafe.state === 'missing' ? 'missing_durable_intent' : 'dispatch_interrupted',
    });
    return { events: unknown.events, toolResults: [], done: true, signatures: [] };
  }

  const events: AgentEvent[] = [];
  const toolResults: ToolResultContent[] = [];
  const signatures: ToolExecutionSignature[] = [];

  for (const group of params.groups) {
    const toDispatch = group.filter(item => classificationMap.get(item.toolUse.id)?.state === 'not_started');
    if (toDispatch.length > 0) {
      params.manifestManager.markToolIntentsDispatched(
        params.runId,
        toDispatch.map(item => params.attempts.find(attempt => attempt.step_id === item.toolUse.id)!),
      );
    }

    const executions = await Promise.all(group.map(async frozen => {
      const attempt = params.attempts.find(item => item.step_id === frozen.toolUse.id);
      if (!attempt) throw internalError(`Missing tool attempt identity for ${frozen.toolUse.id}.`);
      const classification = classificationMap.get(frozen.toolUse.id);
      if (!classification) throw internalError(`Missing tool attempt classification for ${frozen.toolUse.id}.`);
      if (classification.state === 'committed') {
        return committedExecution({ frozen, result: classification.result, turnCount: params.turnCount });
      }
      return callDispatchedTool({ ...params, frozen, attempt });
    }));

    const unknown = executions.find(execution => execution.unknown);
    if (unknown) {
      return { events: [...events, ...unknown.events], toolResults: [], done: true, signatures };
    }
    for (const execution of executions) {
      events.push(...execution.events);
      if (execution.signature) signatures.push(execution.signature);
      if (execution.done) {
        return { events, toolResults: [], done: true, signatures };
      }
      if (execution.toolResult) toolResults.push(execution.toolResult);
    }
  }
  return { events, toolResults, done: false, signatures };
}

function prepareToolUses(params: {
  blocks: ToolUseContent[];
  runId: string;
  approvalRunId: string;
  approvalProjectRoot: string;
  permissionView: ToolPermissionView;
  manifestManager: RunManifestManager;
  observe: boolean;
}): { groups: ReadonlyArray<FrozenToolUseExecutionGroup>; attempts: ToolAttemptIdentity[] } {
  // Authorize and freeze the entire turn before persisting or dispatching any
  // model-authored call. Approval-producing tools must target the root run in
  // their input; validating only the returned envelope would be too late for a
  // stateful tool that already acted on a different run.
  const groups = groupToolUsesForExecution(params.blocks, params.permissionView);
  for (const frozen of groups.flat()) {
    if (frozen.executionPolicy.approval_behavior !== 'may_request') continue;
    if (frozen.toolUse.input['run_id'] !== params.approvalRunId) {
      throw internalError(
        `Approval-producing tool ${frozen.toolUse.name} must target root run ${params.approvalRunId}.`,
      );
    }
    const requestedProjectRoot = frozen.toolUse.input['project_root'];
    if (typeof requestedProjectRoot !== 'string'
      || normalizedProjectRoot(requestedProjectRoot) !== normalizedProjectRoot(params.approvalProjectRoot)) {
      throw internalError(
        `Approval-producing tool ${frozen.toolUse.name} must target the delegated runtime project root.`,
      );
    }
  }
  const attempts = groups.flat().map(frozen => createToolAttemptIdentity({
    stepId: frozen.toolUse.id,
    toolName: frozen.toolUse.name,
    input: frozen.toolUse.input,
  }));
  if (params.observe) params.manifestManager.observeToolIntents(params.runId, attempts);
  return { groups, attempts };
}

export async function handleAssistantResponse(params: {
  blocks: MessageContent[];
  messages: MessageParam[];
  stopReason: string;
  turnCount: number;
  runtimeState: AgentRuntimeState;
  traceId: string;
  runId: string;
  approvalRunId: string;
  approvalProjectRoot: string;
  mcpClient: ToolCaller;
  permissionView: ToolPermissionView;
  manifestManager: RunManifestManager;
  spanCollector: SpanCollector | null;
}): Promise<{ events: AgentEvent[]; messages: MessageParam[]; done: boolean }> {
  const assistantContent = snapshotAssistantContent(params.blocks);
  const toolUses = assistantContent.filter((block): block is ToolUseContent => block.type === 'tool_use');
  const events: AgentEvent[] = assistantContent.flatMap(block => (
    block.type === 'text' && block.text.trim() ? [{ type: 'text' as const, text: block.text }] : []
  ));
  const stopReason = normalizeStopReason(params.stopReason);

  if (toolUses.length > 0) {
    if (stopReason.kind === 'truncation') {
      throw internalError('Assistant response hit max_tokens while requesting tool execution.');
    }
    const prepared = prepareToolUses({
      blocks: toolUses,
      runId: params.runId,
      approvalRunId: params.approvalRunId,
      approvalProjectRoot: params.approvalProjectRoot,
      permissionView: params.permissionView,
      manifestManager: params.manifestManager,
      observe: true,
    });
    const executed = await executePreparedToolUseGroups({
      ...prepared,
      turnCount: params.turnCount,
      phase: 'dialogue',
      traceId: params.traceId,
      mcpClient: params.mcpClient,
      spanCollector: params.spanCollector,
      manifestManager: params.manifestManager,
      runId: params.runId,
      approvalRunId: params.approvalRunId,
    });
    events.push(...executed.events);
    if (executed.done) return { events, messages: params.messages, done: true };

    const callSignature = executed.signatures.map(signature => signature.call).join('|');
    const outcomeSignature = executed.signatures.map(signature => signature.outcome).join('|');
    const toolErrorCount = executed.signatures.filter(signature => signature.isError).length;
    const lowGain = evaluateLowGainTurn({
      turnCount: params.turnCount,
      runtimeState: params.runtimeState,
      toolCallSignature: callSignature,
      toolOutcomeSignature: outcomeSignature,
      toolCallCount: executed.signatures.length,
      toolErrorCount,
    });
    events.push(...lowGain.markers);
    if (lowGain.shouldStop) {
      events.push({ type: 'done', stopReason: 'diminishing_returns', turnCount: params.turnCount });
      return { events, messages: params.messages, done: true };
    }
    return {
      events,
      messages: [
        ...params.messages,
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: executed.toolResults },
      ],
      done: false,
    };
  }

  if (stopReason.kind === 'tool_use') {
    throw internalError('Assistant returned tool_use stop_reason without tool_use blocks.');
  }
  if (stopReason.kind === 'truncation') {
    resetLowGainTracking(params.runtimeState);
    const recovery = buildTruncationRecovery({
      messages: params.messages,
      assistantContent,
      turnCount: params.turnCount,
      runtimeState: params.runtimeState,
    });
    if (!recovery) {
      throw internalError('Assistant response remained truncated after the bounded recovery budget was exhausted.');
    }
    events.push(recovery.marker);
    return { events, messages: recovery.messages, done: false };
  }
  events.push({ type: 'done', stopReason: stopReason.normalized, turnCount: params.turnCount });
  return { events, messages: params.messages, done: true };
}

export async function resolveIncompleteToolUses(params: {
  messages: MessageParam[];
  runId: string;
  approvalRunId: string;
  approvalProjectRoot: string;
  mcpClient: ToolCaller;
  permissionView: ToolPermissionView;
  manifestManager: RunManifestManager;
  traceId?: string;
  spanCollector?: SpanCollector | null;
}): Promise<{ events: AgentEvent[]; messages: MessageParam[]; done: boolean } | null> {
  const last = params.messages[params.messages.length - 1];
  if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) return null;
  const pendingToolUses = last.content.filter((block): block is ToolUseContent => block.type === 'tool_use');
  if (pendingToolUses.length === 0) return null;

  const prepared = prepareToolUses({
    blocks: pendingToolUses,
    runId: params.runId,
    approvalRunId: params.approvalRunId,
    approvalProjectRoot: params.approvalProjectRoot,
    permissionView: params.permissionView,
    manifestManager: params.manifestManager,
    observe: false,
  });
  const executed = await executePreparedToolUseGroups({
    ...prepared,
    turnCount: 0,
    phase: 'recovery',
    traceId: params.traceId ?? 'recovery',
    mcpClient: params.mcpClient,
    spanCollector: params.spanCollector ?? null,
    manifestManager: params.manifestManager,
    runId: params.runId,
    approvalRunId: params.approvalRunId,
  });
  if (executed.done) return { events: executed.events, messages: params.messages, done: true };
  return {
    events: executed.events,
    messages: [...params.messages, { role: 'user', content: executed.toolResults }],
    done: false,
  };
}
