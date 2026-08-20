import { describe, expect, it } from 'vitest';
import type { McpToolResult } from '../src/mcp-client.js';
import { parseRunGateApprovalRequest } from '../src/tool-approval-envelope.js';
import type { ToolExecutionPolicy } from '../src/tool-execution-policy.js';

const MAY_REQUEST_POLICY: ToolExecutionPolicy = {
  tool_name: 'approval_producer',
  metadata_source: 'registry',
  mutation_class: 'stateful',
  concurrency: 'serial_only',
  approval_behavior: 'may_request',
};

const READ_ONLY_POLICY: ToolExecutionPolicy = {
  tool_name: 'policy_query',
  metadata_source: 'registry',
  mutation_class: 'read_only',
  concurrency: 'batch_safe',
  approval_behavior: 'none',
};

function result(json: Record<string, unknown>): McpToolResult {
  return {
    ok: true,
    isError: false,
    rawText: JSON.stringify(json),
    json,
    errorCode: null,
  };
}

function envelope(): Record<string, unknown> {
  return {
    status: 'requires_approval',
    requires_approval: true,
    gate_id: 'A3',
    run_id: 'run-1',
    approval_id: 'A3-0001',
    packet_path: 'artifacts/runs/run-1/approval_packet.md',
    approval_packet_sha256: 'a'.repeat(64),
  };
}

describe('parseRunGateApprovalRequest', () => {
  it('accepts the complete hash-bound envelope from a registered producer', () => {
    expect(parseRunGateApprovalRequest('approval_producer', result(envelope()), MAY_REQUEST_POLICY)).toEqual({
      authority: 'run_gate',
      status: 'requires_approval',
      requiresApproval: true,
      gateId: 'A3',
      runId: 'run-1',
      approvalId: 'A3-0001',
      packetPath: 'artifacts/runs/run-1/approval_packet.md',
      approvalPacketSha256: 'a'.repeat(64),
    });
  });

  it('does not confuse an advisory requires_approval boolean with a gate request', () => {
    expect(parseRunGateApprovalRequest(
      'policy_query',
      result({ operation: 'compute_runs', requires_approval: true }),
      READ_ONLY_POLICY,
    )).toBeNull();
  });

  it('fails closed on a malformed envelope from a registered producer', () => {
    const malformed = envelope();
    delete malformed['approval_packet_sha256'];
    expect(() => parseRunGateApprovalRequest('approval_producer', result(malformed), MAY_REQUEST_POLICY))
      .toThrow(/approval_packet_sha256 is required/);
  });

  it('fails closed when an unregistered producer returns the canonical status', () => {
    expect(() => parseRunGateApprovalRequest('policy_query', result(envelope()), READ_ONLY_POLICY))
      .toThrow(/not registered as an approval producer/);
  });

  it('fails closed when a registered producer emits only the advisory flag', () => {
    expect(() => parseRunGateApprovalRequest(
      'approval_producer',
      result({ requires_approval: true }),
      MAY_REQUEST_POLICY,
    )).toThrow(/without the canonical run-gate status envelope/);
  });

  it.each([
    '/tmp/approval.json',
    '\\\\server\\share\\approval.json',
    'C:\\tmp\\approval.json',
    'artifacts/runs/run-1/../other.json',
  ])('rejects a non-project-relative approval packet path: %s', packetPath => {
    expect(() => parseRunGateApprovalRequest(
      'approval_producer',
      result({ ...envelope(), packet_path: packetPath }),
      MAY_REQUEST_POLICY,
    )).toThrow(/project-relative path without traversal/);
  });

  it('rejects an unknown run-gate identifier', () => {
    expect(() => parseRunGateApprovalRequest(
      'approval_producer',
      result({ ...envelope(), gate_id: 'A6' }),
      MAY_REQUEST_POLICY,
    )).toThrow(/A1 through A5/);
  });
});
