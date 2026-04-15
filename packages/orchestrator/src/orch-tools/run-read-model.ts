import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidParams } from '@autoresearch/shared';
import { readFinalConclusionsView, readResearchOutcomeProjectionView } from './final-conclusions.js';
import { readLearningSummaryView } from './learning-summary.js';
import { readInnovateProposalView, readOptimizeProposalView, readRepairProposalView } from './repair-proposal.js';
import { readSkillProposalView } from './skill-proposal.js';
import { deriveLedgerStatusFromOperatorEvent } from '../operator-read-model-summary.js';
import type { RunState } from '../types.js';
import { StateManager } from '../state-manager.js';
import { pauseFilePath, readJson, type ApprovalGateFilter } from './common.js';

export type VisibleRunStatusFilter =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'paused'
  | 'blocked'
  | 'needs_recovery'
  | 'rejected'
  | 'completed'
  | 'failed'
  | 'all';

export type ReadModelError = { code: string; message: string };

export type RunListEntry = {
  run_id: string;
  last_event: string;
  last_status: string;
  timestamp_utc: string;
  uri: string;
};

export type ApprovalEntry = Record<string, unknown>;

export function buildRunStatusView(projectRoot: string, state: RunState) {
  const paused = fs.existsSync(pauseFilePath(projectRoot));
  const finalConclusions = readFinalConclusionsView(projectRoot, state);
  const researchOutcomeProjection = readResearchOutcomeProjectionView(projectRoot, state);
  const repairProposal = readRepairProposalView(projectRoot, state);
  const optimizeProposal = readOptimizeProposalView(projectRoot, state);
  const innovateProposal = readInnovateProposalView(projectRoot, state);
  const skillProposal = readSkillProposalView(projectRoot, state);
  const learningSummary = readLearningSummaryView(projectRoot, state);
  return {
    run_id: state.run_id,
    run_status: paused ? 'paused' : state.run_status,
    workflow_id: state.workflow_id ?? null,
    current_step: state.current_step ?? null,
    pending_approval: state.pending_approval
      ? {
          ...state.pending_approval,
          agent_id: 'root',
          assignment_id: null,
          session_id: null,
        }
      : null,
    gate_satisfied: state.gate_satisfied ?? {},
    notes: state.notes ?? '',
    uri: state.run_id ? `orch://runs/${state.run_id}` : null,
    is_paused: paused,
    final_conclusions: finalConclusions.final_conclusions,
    final_conclusions_error: finalConclusions.final_conclusions_error,
    research_outcome_projection: researchOutcomeProjection.research_outcome_projection,
    research_outcome_projection_error: researchOutcomeProjection.research_outcome_projection_error,
    repair_mutation_proposal: repairProposal.repair_mutation_proposal,
    repair_mutation_proposal_error: repairProposal.repair_mutation_proposal_error,
    optimize_mutation_proposal: optimizeProposal.optimize_mutation_proposal,
    optimize_mutation_proposal_error: optimizeProposal.optimize_mutation_proposal_error,
    innovate_mutation_proposal: innovateProposal.innovate_mutation_proposal,
    innovate_mutation_proposal_error: innovateProposal.innovate_mutation_proposal_error,
    skill_proposal: skillProposal.skill_proposal,
    skill_proposal_error: skillProposal.skill_proposal_error,
    learning_summary: learningSummary.learning_summary,
    learning_summary_error: learningSummary.learning_summary_error,
  };
}

export function readRunListView(
  manager: StateManager,
  params: { limit: number; status_filter: VisibleRunStatusFilter },
): { runs: RunListEntry[]; total: number; returned: number; errors: ReadModelError[] } {
  if (!fs.existsSync(manager.ledgerPath)) {
    return {
      runs: [],
      total: 0,
      returned: 0,
      errors: [{ code: 'LEDGER_MISSING', message: `No ledger found at ${manager.ledgerPath}.` }],
    };
  }

  const runMap = new Map<string, RunListEntry>();
  let invalidLines = 0;
  const unmappedEvents = new Map<string, number>();
  const lines = fs.readFileSync(manager.ledgerPath, 'utf-8').split('\n').filter(line => line.trim());
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      invalidLines += 1;
      continue;
    }
    const runId = typeof event.run_id === 'string' ? event.run_id : null;
    if (!runId) continue;
    const eventType = typeof event.event_type === 'string' ? event.event_type : '';
    const timestamp = typeof event.ts === 'string'
      ? event.ts
      : (typeof event.timestamp_utc === 'string' ? event.timestamp_utc : '');
    const details = event.details && typeof event.details === 'object'
      ? event.details as Record<string, unknown>
      : {};
    const previous = runMap.get(runId)?.last_status ?? 'unknown';
    const { status, unmappedEvent } = deriveLedgerStatusFromOperatorEvent(eventType, details, previous);
    if (unmappedEvent) {
      unmappedEvents.set(unmappedEvent, (unmappedEvents.get(unmappedEvent) ?? 0) + 1);
    }
    runMap.set(runId, {
      run_id: runId,
      last_event: eventType,
      last_status: status,
      timestamp_utc: timestamp,
      uri: `orch://runs/${runId}`,
    });
  }

  let runs = [...runMap.values()].sort((left, right) => right.timestamp_utc.localeCompare(left.timestamp_utc));
  if (params.status_filter !== 'all') {
    runs = runs.filter(run => run.last_status === params.status_filter);
  }
  const limited = runs.slice(0, params.limit);
  const errors: ReadModelError[] = [];
  if (invalidLines > 0) {
    errors.push({ code: 'LEDGER_PARSE_ERROR', message: `Skipped ${invalidLines} invalid ledger line(s) in ${manager.ledgerPath}.` });
  }
  if (unmappedEvents.size > 0) {
    const summary = [...unmappedEvents.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([eventType, count]) => `${eventType} x${count}`)
      .join(', ');
    errors.push({
      code: 'LEDGER_EVENT_UNMAPPED',
      message: `Preserved previous status for ${[...unmappedEvents.values()].reduce((sum, count) => sum + count, 0)} ledger event(s) with no read-model mapping in ${manager.ledgerPath}: ${summary}.`,
    });
  }
  return {
    runs: limited,
    total: runMap.size,
    returned: limited.length,
    errors,
  };
}

export function readApprovalsView(
  projectRoot: string,
  state: RunState,
  params: {
    run_id?: string;
    gate_filter: ApprovalGateFilter;
    include_history: boolean;
  },
): { run_id: string; approvals: ApprovalEntry[]; total: number; errors: ReadModelError[] } {
  const runId = params.run_id ?? state.run_id;
  if (!runId) {
    throw invalidParams('No run_id in state and none provided.', {});
  }

  const approvals: ApprovalEntry[] = [];
  const errors: ReadModelError[] = [];
  const byApprovalId = new Map<string, ApprovalEntry>();
  const upsert = (entry: ApprovalEntry) => {
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
    const category = typeof state.pending_approval.category === 'string' ? state.pending_approval.category : '';
    if (params.gate_filter === 'all' || category === params.gate_filter) {
      upsert({
        ...state.pending_approval,
        agent_id: 'root',
        assignment_id: null,
        session_id: null,
        status: 'pending',
      });
    }
  }

  const approvalsDir = path.join(projectRoot, 'artifacts', 'runs', runId, 'approvals');
  if (!fs.existsSync(approvalsDir)) {
    return { run_id: runId, approvals, total: approvals.length, errors };
  }

  for (const dirName of fs.readdirSync(approvalsDir).sort()) {
    const dirPath = path.join(approvalsDir, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const gatePrefix = dirName.slice(0, 2);
    if (params.gate_filter !== 'all' && gatePrefix !== params.gate_filter) continue;
    const jsonPath = path.join(dirPath, 'approval_packet_v1.json');
    const entry: ApprovalEntry = { dir: dirName };
    if (fs.existsSync(jsonPath)) {
      try {
        const packet = readJson(jsonPath) as Record<string, unknown>;
        entry.approval_id = packet.approval_id;
        entry.gate_id = packet.gate_id;
        entry.requested_at = packet.requested_at;
        entry.approval_packet_sha256 = createHash('sha256').update(fs.readFileSync(jsonPath)).digest('hex');
        entry.uri = `orch://runs/${runId}/approvals/${dirName}`;
        entry.packet_short_uri = path.join(dirPath, 'packet_short.md');
      } catch {
        entry.parse_error = true;
        errors.push({ code: 'APPROVAL_PACKET_PARSE_ERROR', message: `Failed to parse ${jsonPath}.` });
      }
    } else {
      errors.push({ code: 'APPROVAL_PACKET_MISSING', message: `Missing approval_packet_v1.json in ${dirPath}.` });
    }

    const historyEntry = state.approval_history.find(item => item.approval_id === entry.approval_id);
    if (historyEntry) {
      entry.status = historyEntry.decision === 'approved' ? 'approved' : 'rejected';
      entry.resolved_at = historyEntry.ts;
      entry.note = historyEntry.note;
      if (!params.include_history) continue;
    } else {
      entry.status = state.pending_approval?.approval_id === entry.approval_id ? 'pending' : 'unknown';
    }
    entry.agent_id = 'root';
    entry.assignment_id = null;
    entry.session_id = null;
    upsert(entry);
  }

  return { run_id: runId, approvals, total: approvals.length, errors };
}
