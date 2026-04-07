import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleOrchRunApprove } from './orch-tools/approval.js';
import { createStateManager, requireState } from './orch-tools/common.js';
import { handleOrchRunPause, handleOrchRunResume } from './orch-tools/control.js';
import { handleOrchRunStatus } from './orch-tools/create-status-list.js';

export type CliIo = {
  cwd: string;
  stderr: (text: string) => void;
  stdout: (text: string) => void;
};

function writeJson(io: CliIo, payload: unknown): void {
  io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
}

function writeStatusText(io: CliIo, payload: Record<string, unknown>): void {
  io.stdout(`run_id: ${String(payload.run_id ?? '')}\n`);
  io.stdout(`run_status: ${String(payload.run_status ?? '')}\n`);
  io.stdout(`workflow_id: ${String(payload.workflow_id ?? '')}\n`);
  io.stdout(`project_uri: ${String(payload.uri ?? '')}\n`);
  if (payload.current_step) {
    io.stdout(`current_step: ${JSON.stringify(payload.current_step)}\n`);
  }
  if (payload.pending_approval) {
    io.stdout(`pending_approval: ${JSON.stringify(payload.pending_approval)}\n`);
  }
  if (payload.notes) {
    io.stdout(`notes: ${String(payload.notes)}\n`);
  }
}

function pendingApprovalPacketSha(projectRoot: string, approvalId: string): string {
  const { manager } = createStateManager(projectRoot);
  const state = requireState(projectRoot, manager);
  const pending = state.pending_approval as Record<string, unknown> | null;
  if (!pending || pending.approval_id !== approvalId) {
    throw new Error(`pending approval mismatch for ${approvalId}`);
  }
  const packetPath = typeof pending.packet_path === 'string' ? pending.packet_path : '';
  if (!packetPath) {
    throw new Error(`pending approval ${approvalId} is missing packet_path`);
  }
  const packetJsonPath = path.join(projectRoot, path.dirname(packetPath), 'approval_packet_v1.json');
  if (!fs.existsSync(packetJsonPath)) {
    throw new Error(`missing approval packet: ${packetJsonPath}`);
  }
  return createHash('sha256').update(fs.readFileSync(packetJsonPath)).digest('hex');
}

export async function runStatusCommand(projectRoot: string, json: boolean, io: CliIo): Promise<void> {
  const payload = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
  if (json) {
    writeJson(io, payload);
    return;
  }
  writeStatusText(io, payload);
}

export async function runPauseCommand(projectRoot: string, note: string | null, io: CliIo): Promise<void> {
  const payload = await handleOrchRunPause({ project_root: projectRoot, ...(note ? { note } : {}) }) as Record<string, unknown>;
  io.stdout(`paused: ${String(payload.run_id ?? '')}\n`);
}

export async function runResumeCommand(projectRoot: string, note: string | null, force: boolean, io: CliIo): Promise<void> {
  const payload = await handleOrchRunResume({
    project_root: projectRoot,
    force,
    ...(note ? { note } : {}),
  }) as Record<string, unknown>;
  io.stdout(`resumed: ${String(payload.run_id ?? '')}\n`);
}

export async function runApproveCommand(
  projectRoot: string,
  approvalId: string,
  note: string | null,
  io: CliIo,
): Promise<void> {
  const payload = await handleOrchRunApprove({
    _confirm: true,
    approval_id: approvalId,
    approval_packet_sha256: pendingApprovalPacketSha(projectRoot, approvalId),
    project_root: projectRoot,
    ...(note ? { note } : {}),
  }) as Record<string, unknown>;
  io.stdout(`approved: ${String(payload.approval_id ?? approvalId)}\n`);
}
