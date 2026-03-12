import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidParams } from '@autoresearch/shared';
import { StateManager } from '../state-manager.js';
import { utcNowIso } from '../util.js';
import { ensureDir, sha256Text, toPosixRelative, writeJsonAtomic, writeTextAtomic } from './io.js';
import type { ApprovalRequiredExecutionResult, PreparedManifest } from './types.js';

function previewApprovalId(current: number): string {
  return `A3-${String(current + 1).padStart(4, '0')}`;
}

function approvalArtifacts(projectRoot: string, runId: string, approvalId: string) {
  const approvalDir = path.join(projectRoot, 'artifacts', 'runs', runId, 'approvals', approvalId);
  return {
    approvalDir,
    packetPath: path.join(approvalDir, 'packet_short.md'),
    packetJsonPath: path.join(approvalDir, 'approval_packet_v1.json'),
    packetFullPath: path.join(approvalDir, 'packet.md'),
  };
}

function buildApprovalPacket(prepared: PreparedManifest, requestedAt: string, approvalId: string) {
  const commands = prepared.steps.map(step => step.argv.join(' '));
  const outputs = prepared.topLevelOutputs.length > 0
    ? prepared.topLevelOutputs
    : prepared.steps.flatMap(step => step.expectedOutputs.map(output => `computation/${output}`));
  return {
    schema_version: 1,
    approval_id: approvalId,
    gate_id: 'A3',
    run_id: prepared.runId,
    workflow_id: 'computation',
    purpose: `Authorize execution of ${prepared.manifestRelativePath} for run ${prepared.runId}.`,
    plan: prepared.stepOrder.map(stepId => {
      const step = prepared.steps.find(candidate => candidate.id === stepId)!;
      return `${step.id}: ${step.tool} ${step.scriptRelativePath}`;
    }),
    risks: [
      'Project-local scripts will be executed within the run workspace.',
      'Declared outputs are enforced fail-closed; missing outputs mark the run failed.',
    ],
    budgets: {
      ...(prepared.manifest.computation_budget?.max_runtime_minutes !== undefined
        ? { max_runtime_minutes: Math.ceil(prepared.manifest.computation_budget.max_runtime_minutes) }
        : {}),
      ...(prepared.manifest.computation_budget?.max_disk_gb !== undefined
        ? { max_disk_gb: prepared.manifest.computation_budget.max_disk_gb }
        : {}),
    },
    outputs,
    rollback: `Reject approval or remove outputs under ${toPosixRelative(prepared.runDir, prepared.workspaceDir)}.`,
    commands,
    checklist: [
      'Verify the execution scope is limited to the current run workspace.',
      'Confirm the expected outputs and resource budget are acceptable.',
    ],
    requested_at: requestedAt,
    run_card_path: prepared.manifestRelativePath,
    run_card_sha256: prepared.manifestSha256,
    plan_step_ids: prepared.stepOrder,
    details_md: `Workspace: ${prepared.workspaceDir}\n\nContainment: validated within current run directory.`,
  };
}

function writeApprovalPacketArtifacts(projectRoot: string, prepared: PreparedManifest, approvalId: string): {
  packetPath: string;
  packetJsonPath: string;
  packetSha256: string;
} {
  const requestedAt = utcNowIso();
  const packet = buildApprovalPacket(prepared, requestedAt, approvalId);
  const artifacts = approvalArtifacts(projectRoot, prepared.runId, approvalId);
  ensureDir(artifacts.approvalDir);
  const packetJsonText = JSON.stringify(packet, null, 2) + '\n';
  writeTextAtomic(
    artifacts.packetPath,
    `# Approval: ${approvalId} (A3)\n\nRun: ${prepared.runId}\nManifest: ${prepared.manifestRelativePath}\nRequested: ${requestedAt}\n`,
  );
  writeTextAtomic(
    artifacts.packetFullPath,
    `# Approval packet — ${approvalId} (A3)\n\n${packet.purpose}\n\n## Commands\n${packet.commands.map(command => `- ${command}`).join('\n')}\n`,
  );
  writeJsonAtomic(artifacts.packetJsonPath, packet);
  return {
    packetPath: toPosixRelative(projectRoot, artifacts.packetPath),
    packetJsonPath: toPosixRelative(projectRoot, artifacts.packetJsonPath),
    packetSha256: sha256Text(packetJsonText),
  };
}

export function ensureA3Approval(
  projectRoot: string,
  prepared: PreparedManifest,
): ApprovalRequiredExecutionResult | null {
  const stateManager = new StateManager(projectRoot);
  const state = stateManager.readState();
  if (state.run_id !== prepared.runId) {
    throw invalidParams('orchestrator run_id does not match execution run_id', {
      orchestrator_run_id: state.run_id,
      execution_run_id: prepared.runId,
      next_actions: [{ tool: 'orch_run_create', args: { project_root: projectRoot, run_id: prepared.runId, workflow_id: 'computation' } }],
    });
  }
  const satisfiedA3 = typeof state.gate_satisfied.A3 === 'string' ? state.gate_satisfied.A3 : null;
  if (satisfiedA3) {
    return null;
  }
  const pending = state.pending_approval;
  if (pending?.category === 'A3' && pending.approval_id) {
    const artifacts = approvalArtifacts(projectRoot, prepared.runId, pending.approval_id);
    if (!fs.existsSync(artifacts.packetJsonPath)) {
      throw invalidParams('pending A3 approval is missing approval_packet_v1.json', {
        approval_id: pending.approval_id,
        packet_path: pending.packet_path,
      });
    }
    return {
      status: 'requires_approval',
      requires_approval: true,
      gate_id: 'A3',
      run_id: prepared.runId,
      approval_id: pending.approval_id,
      approval_packet_sha256: sha256Text(fs.readFileSync(artifacts.packetJsonPath, 'utf-8')),
      packet_path: pending.packet_path,
      packet_json_path: toPosixRelative(projectRoot, artifacts.packetJsonPath),
      message: `Approval required: ${pending.approval_id}`,
    };
  }
  const approvalId = previewApprovalId(state.approval_seq.A3 ?? 0);
  const packet = writeApprovalPacketArtifacts(projectRoot, prepared, approvalId);
  const packetPath = packet.packetPath;
  const mutatedState = stateManager.readState();
  const returnedApprovalId = stateManager.requestApproval(mutatedState, 'A3', { packet_path: packetPath });
  if (returnedApprovalId !== approvalId) {
    throw invalidParams('approval_id drifted while creating A3 request', {
      expected: approvalId,
      actual: returnedApprovalId,
    });
  }
  return {
    status: 'requires_approval',
    requires_approval: true,
    gate_id: 'A3',
    run_id: prepared.runId,
    approval_id: approvalId,
    approval_packet_sha256: packet.packetSha256,
    packet_path: packet.packetPath,
    packet_json_path: packet.packetJsonPath,
    message: `Approval required: ${approvalId}`,
  };
}
