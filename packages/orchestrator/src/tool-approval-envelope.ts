import { internalError } from '@nullius/shared';
import type { McpToolResult } from './mcp-jsonrpc.js';
import type { ToolExecutionPolicy } from './tool-execution-policy.js';

export interface RunGateApprovalRequest {
  authority: 'run_gate';
  status: 'requires_approval';
  requiresApproval: true;
  gateId: string;
  runId: string;
  approvalId: string;
  packetPath: string;
  approvalPacketSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredNonEmptyString(
  value: Record<string, unknown>,
  key: string,
  toolName: string,
): string {
  const resolved = value[key];
  if (typeof resolved !== 'string' || resolved.trim() === '') {
    throw internalError(`Tool ${toolName} returned a malformed run-gate approval envelope: ${key} is required.`);
  }
  return resolved;
}

/**
 * Interpret only the canonical run-gate envelope as an approval boundary.
 *
 * A bare `requires_approval` boolean is deliberately not sufficient: read-only
 * policy-query tools use that field as advisory data. Conversely, a tool that
 * claims the canonical `requires_approval` status must be registered as an
 * approval producer and return the complete, hash-bound envelope.
 */
export function parseRunGateApprovalRequest(
  toolName: string,
  result: McpToolResult,
  policy: ToolExecutionPolicy,
): RunGateApprovalRequest | null {
  if (!isRecord(result.json)) {
    return null;
  }
  const status = result.json['status'];
  const advisoryFlag = result.json['requires_approval'];
  if (status !== 'requires_approval') {
    if (policy.approval_behavior === 'may_request' && advisoryFlag === true) {
      throw internalError(
        `Tool ${toolName} returned requires_approval=true without the canonical run-gate status envelope.`,
      );
    }
    return null;
  }
  if (policy.approval_behavior !== 'may_request') {
    throw internalError(
      `Tool ${toolName} returned a run-gate approval envelope but is not registered as an approval producer.`,
    );
  }
  if (!result.ok || result.isError) {
    throw internalError(`Tool ${toolName} returned an approval envelope as an error result.`);
  }
  if (advisoryFlag !== true) {
    throw internalError(
      `Tool ${toolName} returned status=requires_approval without requires_approval=true.`,
    );
  }
  const approvalPacketSha256 = requiredNonEmptyString(
    result.json,
    'approval_packet_sha256',
    toolName,
  );
  if (!/^[a-f0-9]{64}$/i.test(approvalPacketSha256)) {
    throw internalError(
      `Tool ${toolName} returned a malformed run-gate approval envelope: approval_packet_sha256 must be a SHA-256 digest.`,
    );
  }
  const gateId = requiredNonEmptyString(result.json, 'gate_id', toolName);
  if (!/^A[1-5]$/.test(gateId)) {
    throw internalError(
      `Tool ${toolName} returned a malformed run-gate approval envelope: gate_id must be A1 through A5.`,
    );
  }
  const packetPath = requiredNonEmptyString(result.json, 'packet_path', toolName);
  if (packetPath.startsWith('/')
    || packetPath.startsWith('\\')
    || /^[a-zA-Z]:[\\/]/.test(packetPath)
    || packetPath.split(/[\\/]/).includes('..')) {
    throw internalError(
      `Tool ${toolName} returned a malformed run-gate approval envelope: packet_path must be a project-relative path without traversal.`,
    );
  }
  return {
    authority: 'run_gate',
    status: 'requires_approval',
    requiresApproval: true,
    gateId,
    runId: requiredNonEmptyString(result.json, 'run_id', toolName),
    approvalId: requiredNonEmptyString(result.json, 'approval_id', toolName),
    packetPath,
    approvalPacketSha256: approvalPacketSha256.toLowerCase(),
  };
}
