// @autoresearch/orchestrator — public package exports
export const VERSION = '0.0.1';

export * from './types.js';
export { StateManager } from './state-manager.js';
export { LedgerWriter } from './ledger-writer.js';
export { McpClient, type McpToolResult, type McpClientOptions } from './mcp-client.js';
export { ApprovalGate, approvalPacketSha256, type ApprovalRequest, type ApprovalCheckResult } from './approval-gate.js';
export { retryWithBackoff, RetryExhaustedError, type RetryAttempt, type RetryResult } from './retry.js';
export { SpanCollector, ActiveSpan } from './tracing.js';
export { sortKeysRecursive, utcNowIso } from './util.js';
export {
  AgentRunner,
  _resetLaneQueue,
  type AgentEvent,
  type AgentRunnerOptions,
  type MessageParam,
  type Tool,
} from './agent-runner.js';
export { createChatBackend, type ChatBackendFactory } from './backends/backend-factory.js';
export { type ChatBackend } from './backends/chat-backend.js';
export { loadRoutingConfig, resolveChatRoute } from './routing/loader.js';
export { loadSamplingRoutingConfig, resolveSamplingRoute } from './routing/sampling-loader.js';
export { type ChatRoutingConfig, type ResolvedChatRoute } from './routing/types.js';
export { type SamplingRoutingConfig, type ResolvedSamplingRoute } from './routing/sampling-types.js';
export { executeSamplingRequest, type HostSamplingRequest, type SamplingExecutionAudit, type SamplingExecutionResult } from './sampling-handler.js';
export {
  RunManifestManager,
  type RunManifest,
  type StepCheckpoint,
} from './run-manifest.js';
export {
  bridgeStagedIdeaToComputation,
  buildTeamConfigForDelegatedFollowupTask,
  extractIdeaStagingHints,
  hasCompletedDelegatedFollowupAssignmentForTask,
  loadStagedIdeaSurfaceFromRunDir,
  planComputationFromRunDir,
  parseIdeaHandoffRecord,
  primeDelegatedFollowupTeamState,
  progressDelegatedComputationFollowups,
  readStagedContentArtifactFromRunDir,
  readIdeaHandoffRecord,
  selectDelegatedComputationFollowupTask,
  stageContentInRunDir,
  stageIdeaArtifactsIntoRun,
  executeComputationManifest,
  type ComputeBridgeInput,
  type ComputeBridgeResult,
  type DelegatedComputationFollowupTask,
  type DelegatedComputationFollowupLaunchResult,
  type DelegatedComputationFollowupLaunchStatus,
  type DelegatedFollowupTeamConfig,
  type ExecuteComputationManifestInput,
  type ExecuteComputationManifestResult,
  type StagedIdeaHintsSnapshotV1,
} from './computation/index.js';
export { ORCH_TOOL_SPECS } from './orch-tools/index.js';
export { getToolSpec, getToolSpecs, handleToolCall, type ToolExposureMode, type ToolSpec } from './tooling.js';
export {
  createLoopbackToolCaller,
  createSamplingAdapter,
  defaultTeamPermissions,
} from './team-execution-tool-bridge.js';
export * from './research-loop/index.js';
export * from './delegation-protocol.js';
export * from './team-execution-state.js';
export * from './team-execution-types.js';
export * from './team-execution-storage.js';
export * from './team-execution-runtime.js';
export * from './team-execution-bridge.js';
export * from './team-execution-view.js';
export * from './team-unified-runtime.js';
