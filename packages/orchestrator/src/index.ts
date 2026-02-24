// @autoresearch/orchestrator — NEW-05a Stage 1
// TS orchestrator skeleton: StateManager, LedgerWriter, McpClient, ApprovalGate.
export const VERSION = '0.0.1';

export * from './types.js';
export { StateManager } from './state-manager.js';
export { LedgerWriter } from './ledger-writer.js';
export { McpClient, type McpToolResult } from './mcp-client.js';
export { ApprovalGate, approvalPacketSha256, type ApprovalRequest, type ApprovalCheckResult } from './approval-gate.js';
