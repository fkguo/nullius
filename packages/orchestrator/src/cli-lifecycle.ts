import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleOrchRunApprove } from './orch-tools/approval.js';
import { createStateManager, requireState } from './orch-tools/common.js';
import { handleOrchRunRequestFinalConclusions } from './orch-tools/final-conclusions.js';
import { handleOrchRunRecordProposalDecision } from './orch-tools/proposal-decision.js';
import { handleOrchRunRecordVerification } from './orch-tools/verification.js';
import { handleOrchRunPause, handleOrchRunResume } from './orch-tools/control.js';
import { handleOrchRunStatus } from './orch-tools/create-status-list.js';
import type { ParsedCliArgs } from './cli-args.js';

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
  if (payload.plan_view_warning) {
    io.stdout(`plan_view_warning: ${JSON.stringify(payload.plan_view_warning)}\n`);
  }
  if (payload.plan_view && typeof payload.plan_view === 'object') {
    const planView = payload.plan_view as Record<string, unknown>;
    if (planView.plan_md_path) {
      io.stdout(`plan_md_path: ${String(planView.plan_md_path)}\n`);
    }
    if (planView.plan_current_step_id) {
      io.stdout(`plan_current_step: ${String(planView.plan_current_step_id)}\n`);
    }
    const steps = Array.isArray(planView.steps) ? planView.steps : [];
    if (steps.length > 0) {
      io.stdout('plan_steps:\n');
      for (const rawStep of steps) {
        if (!rawStep || typeof rawStep !== 'object') continue;
        const step = rawStep as Record<string, unknown>;
        io.stdout(`  - ${String(step.step_id ?? '')} [${String(step.status ?? '')}]: ${String(step.description ?? '')}\n`);
      }
    }
  }
  const digestError = payload.project_recent_digest_error;
  if (digestError && typeof digestError === 'object') {
    io.stdout(`project_recent_digest_error: ${JSON.stringify(digestError)}\n`);
  }
  const digest = payload.project_recent_digest;
  if (!digest || typeof digest !== 'object') {
    return;
  }
  io.stdout('recent_digest:\n');
  const latestFinalConclusions = (digest as Record<string, unknown>).latest_final_conclusions;
  if (latestFinalConclusions && typeof latestFinalConclusions === 'object') {
    const entry = latestFinalConclusions as Record<string, unknown>;
    io.stdout(
      `  latest_final_conclusions: ${String(entry.run_id ?? '')} @ ${String(entry.created_at ?? '')} :: ${String(entry.summary ?? '')}\n`,
    );
  }
  const latestProposals = (digest as Record<string, unknown>).latest_proposals;
  if (latestProposals && typeof latestProposals === 'object') {
    for (const kind of ['repair', 'skill', 'optimize', 'innovate'] as const) {
      const entry = (latestProposals as Record<string, unknown>)[kind];
      if (!entry || typeof entry !== 'object') continue;
      const proposal = entry as Record<string, unknown>;
      const decision = typeof proposal.decision === 'string' ? ` [decision=${proposal.decision}]` : '';
      io.stdout(
        `  latest_${kind}_proposal: ${String(proposal.run_id ?? '')} :: ${String(proposal.summary ?? '')}${decision}\n`,
      );
    }
  }
  const activeTeamRun = (digest as Record<string, unknown>).active_team_run;
  if (activeTeamRun && typeof activeTeamRun === 'object') {
    const entry = activeTeamRun as Record<string, unknown>;
    io.stdout(
      `  active_team_run: ${String(entry.run_id ?? '')} status=${String(entry.run_status ?? '')} active_assignments=${String(entry.active_assignment_count ?? '')} pending_approvals=${String(entry.pending_approval_count ?? '')}\n`,
    );
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
  if (payload.final_conclusions_path) {
    io.stdout(`final_conclusions_path: ${String(payload.final_conclusions_path)}\n`);
  }
  if (payload.final_conclusions_uri) {
    io.stdout(`final_conclusions_uri: ${String(payload.final_conclusions_uri)}\n`);
  }
}

export async function runFinalConclusionsCommand(
  projectRoot: string,
  runId: string,
  note: string | null,
  io: CliIo,
): Promise<void> {
  const payload = await handleOrchRunRequestFinalConclusions({
    project_root: projectRoot,
    run_id: runId,
    ...(note ? { note } : {}),
  });
  writeJson(io, payload);
}

export async function runProposalDecisionCommand(
  projectRoot: string,
  parsed: Extract<ParsedCliArgs, { command: 'proposal-decision' }>,
  io: CliIo,
): Promise<void> {
  const payload = await handleOrchRunRecordProposalDecision({
    project_root: projectRoot,
    proposal_kind: parsed.proposalKind,
    proposal_id: parsed.proposalId,
    decision: parsed.decision,
    ...(parsed.note ? { note: parsed.note } : {}),
  });
  writeJson(io, payload);
}

export async function runVerifyCommand(
  projectRoot: string,
  parsed: Extract<ParsedCliArgs, { command: 'verify' }>,
  io: CliIo,
): Promise<void> {
  const payload = await handleOrchRunRecordVerification({
    project_root: projectRoot,
    run_id: parsed.runId,
    status: parsed.status,
    summary: parsed.summary,
    evidence_paths: parsed.evidencePaths,
    check_kind: parsed.checkKind,
    confidence_level: parsed.confidenceLevel,
    ...(parsed.confidenceScore !== null ? { confidence_score: parsed.confidenceScore } : {}),
    ...(parsed.notes ? { notes: parsed.notes } : {}),
  });
  writeJson(io, payload);
}
