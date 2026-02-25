// @autoresearch/orchestrator — NEW-05a Stage 3b
// TS orchestrator: StateManager (read+write), LedgerWriter, McpClient, ApprovalGate.
export const VERSION = '0.0.1';

export * from './types.js';
export { StateManager } from './state-manager.js';
export { LedgerWriter } from './ledger-writer.js';
export { McpClient, type McpToolResult, type McpClientOptions } from './mcp-client.js';
export { ApprovalGate, approvalPacketSha256, type ApprovalRequest, type ApprovalCheckResult } from './approval-gate.js';
export { retryWithBackoff, RetryExhaustedError, type RetryAttempt, type RetryResult } from './retry.js';
export { SpanCollector, ActiveSpan } from './tracing.js';
export { sortKeysRecursive, utcNowIso } from './util.js';
