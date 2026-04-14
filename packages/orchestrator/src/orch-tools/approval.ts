import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidParams, notFound } from '@autoresearch/shared';
import { z } from 'zod';
import { createStateManager, requireState } from './common.js';
import { consumeApprovedFinalConclusions } from './final-conclusions.js';
import { readApprovalsView } from './run-read-model.js';
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
  if (category === 'A5') {
    const finalConclusions = consumeApprovedFinalConclusions({
      approvalId: params.approval_id,
      note: params.note,
      packetJsonPath,
      packetPathRel,
      packetSha256: actualSha256,
      projectRoot,
      state,
    });
    try {
      manager.approveRun(state, params.approval_id, params.note, {
        final_status: 'completed',
        state_note: `final conclusions ${params.approval_id} granted`,
        details: {
          final_conclusions_path: finalConclusions.final_conclusions_path,
          final_conclusions_uri: finalConclusions.final_conclusions_uri,
        },
        artifact_updates: {
          final_conclusions_v1: finalConclusions.final_conclusions_path,
        },
      });
    } catch (error) {
      finalConclusions.cleanup();
      throw error;
    }
    return {
      approved: true,
      approval_id: params.approval_id,
      category,
      run_status: 'completed',
      uri: `orch://runs/${state.run_id}`,
      final_conclusions_path: finalConclusions.final_conclusions_path,
      final_conclusions_uri: finalConclusions.final_conclusions_uri,
      message: `Approved: ${params.approval_id}`,
    };
  }

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
  const { run_id, approvals, total } = readApprovalsView(projectRoot, state, params);
  return { run_id, approvals, total };
}
