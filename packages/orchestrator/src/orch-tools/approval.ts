import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidParams, notFound } from '@autoresearch/shared';
import { z } from 'zod';
import { createStateManager, readJson, requireState } from './common.js';
import {
  OrchRunApproveSchema,
  OrchRunApprovalsListSchema,
  OrchRunRejectSchema,
} from './schemas.js';

function getPendingApproval(state: { pending_approval?: unknown }, approvalId: string) {
  const pending = state.pending_approval as Record<string, unknown> | null;
  if (!pending) {
    throw invalidParams('No pending approval found in state.', { approval_id: approvalId });
  }
  if (pending.approval_id !== approvalId) {
    throw invalidParams(
      `Pending approval is "${pending.approval_id}", not "${approvalId}".`,
      { expected: pending.approval_id, got: approvalId },
    );
  }
  return pending;
}

function approvalPacketJsonPath(projectRoot: string, packetPathRel: string): string {
  const packetDir = path.join(projectRoot, path.dirname(packetPathRel));
  return path.join(packetDir, 'approval_packet_v1.json');
}

export async function handleOrchRunApprove(
  params: z.output<typeof OrchRunApproveSchema>,
): Promise<unknown> {
  const { manager, projectRoot } = createStateManager(params.project_root);
  const state = requireState(projectRoot, manager);
  const pending = getPendingApproval(state, params.approval_id);
  const packetPathRel = typeof pending.packet_path === 'string' ? pending.packet_path : null;
  if (!packetPathRel) {
    throw invalidParams('Pending approval has no packet_path — cannot verify SHA-256.', {});
  }

  const packetJsonPath = approvalPacketJsonPath(projectRoot, packetPathRel);
  if (!fs.existsSync(packetJsonPath)) {
    throw notFound(`approval_packet_v1.json not found at ${packetJsonPath}`);
  }
  const actualSha256 = createHash('sha256').update(fs.readFileSync(packetJsonPath)).digest('hex');
  if (actualSha256 !== params.approval_packet_sha256) {
    throw invalidParams('approval_packet_sha256 mismatch — packet may have been tampered with.', {
      expected: params.approval_packet_sha256,
      actual: actualSha256,
    });
  }

  const category = typeof pending.category === 'string' ? pending.category : null;
  manager.approveRun(state, params.approval_id, params.note);
  return {
    approved: true,
    approval_id: params.approval_id,
    category,
    run_status: 'running',
    uri: `orch://runs/${state.run_id}`,
    message: `Approved: ${params.approval_id}`,
  };
}

export async function handleOrchRunReject(
  params: z.output<typeof OrchRunRejectSchema>,
): Promise<unknown> {
  const { manager, projectRoot } = createStateManager(params.project_root);
  const state = requireState(projectRoot, manager);
  const pending = getPendingApproval(state, params.approval_id);
  const category = typeof pending.category === 'string' ? pending.category : null;
  manager.rejectRun(state, params.approval_id, params.note);
  return {
    rejected: true,
    approval_id: params.approval_id,
    category,
    run_status: 'paused',
    uri: `orch://runs/${state.run_id}`,
    message: `Rejected: ${params.approval_id}. Run is now paused.`,
  };
}

export async function handleOrchRunApprovalsList(
  params: z.output<typeof OrchRunApprovalsListSchema>,
): Promise<unknown> {
  const { manager, projectRoot } = createStateManager(params.project_root);
  const state = requireState(projectRoot, manager);
  const runId = params.run_id ?? state.run_id;
  if (!runId) {
    throw invalidParams('No run_id in state and none provided.', {});
  }

  const approvals: Record<string, unknown>[] = [];
  const byApprovalId = new Map<string, Record<string, unknown>>();
  const upsertApproval = (entry: Record<string, unknown>) => {
    const approvalId = typeof entry.approval_id === 'string' ? entry.approval_id : null;
    if (!approvalId) {
      approvals.push(entry);
      return;
    }
    const existing = byApprovalId.get(approvalId);
    if (existing) {
      Object.assign(existing, entry);
      return;
    }
    byApprovalId.set(approvalId, entry);
    approvals.push(entry);
  };

  if (state.pending_approval) {
    const category = state.pending_approval.category ?? '';
    if (params.gate_filter === 'all' || category === params.gate_filter) {
      upsertApproval({ ...state.pending_approval, status: 'pending' });
    }
  }

  const approvalsDir = path.join(projectRoot, 'artifacts', 'runs', runId, 'approvals');
  if (fs.existsSync(approvalsDir)) {
    for (const dirName of fs.readdirSync(approvalsDir).sort()) {
      const dirPath = path.join(approvalsDir, dirName);
      if (!fs.statSync(dirPath).isDirectory()) {
        continue;
      }
      const gatePrefix = dirName.slice(0, 2);
      if (params.gate_filter !== 'all' && gatePrefix !== params.gate_filter) {
        continue;
      }
      const jsonPath = path.join(dirPath, 'approval_packet_v1.json');
      const shortPath = path.join(dirPath, 'packet_short.md');
      const approvalEntry: Record<string, unknown> = { dir: dirName };
      if (fs.existsSync(jsonPath)) {
        try {
          const packet = readJson(jsonPath) as Record<string, unknown>;
          approvalEntry.approval_id = packet.approval_id;
          approvalEntry.gate_id = packet.gate_id;
          approvalEntry.requested_at = packet.requested_at;
          approvalEntry.approval_packet_sha256 = createHash('sha256').update(fs.readFileSync(jsonPath)).digest('hex');
          approvalEntry.uri = `orch://runs/${runId}/approvals/${dirName}`;
          approvalEntry.packet_short_uri = shortPath;
        } catch {
          approvalEntry.parse_error = true;
        }
      }

      const historyEntry = state.approval_history.find(entry => entry.approval_id === approvalEntry.approval_id);
      if (historyEntry) {
        approvalEntry.status = historyEntry.decision === 'approved' ? 'approved' : 'rejected';
        approvalEntry.resolved_at = historyEntry.ts;
        approvalEntry.note = historyEntry.note;
        if (!params.include_history) {
          continue;
        }
      } else {
        approvalEntry.status = state.pending_approval?.approval_id === approvalEntry.approval_id ? 'pending' : 'unknown';
      }
      upsertApproval(approvalEntry);
    }
  }

  return {
    run_id: runId,
    approvals,
    total: approvals.length,
  };
}
