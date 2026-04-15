import { z } from 'zod';
import { createStateManager, requireState } from './common.js';
import { recordProposalDecision, type ProposalDecision, type ProposalKind } from '../proposal-decisions.js';

export async function handleOrchRunRecordProposalDecision(params: {
  project_root: string;
  proposal_kind: ProposalKind;
  proposal_id: string;
  decision: ProposalDecision;
  note?: string;
}): Promise<unknown> {
  const { manager, projectRoot } = createStateManager(params.project_root);
  const state = requireState(projectRoot, manager);
  const record = recordProposalDecision({
    projectRoot,
    state,
    proposalKind: params.proposal_kind,
    proposalId: params.proposal_id,
    decision: params.decision,
    ...(params.note ? { note: params.note } : {}),
  });
  manager.appendLedger('proposal_decision_recorded', {
    run_id: state.run_id,
    workflow_id: state.workflow_id,
    details: {
      proposal_kind: record.proposal_kind,
      proposal_id: record.proposal_id,
      proposal_fingerprint: record.proposal_fingerprint,
      decision: record.decision,
      decided_at: record.decided_at,
      suppress_duplicates: record.suppress_duplicates,
      ...(record.note ? { note: record.note } : {}),
    },
  });
  return {
    recorded: true,
    run_id: state.run_id,
    proposal_kind: record.proposal_kind,
    proposal_id: record.proposal_id,
    decision: record.decision,
    decided_at: record.decided_at,
    suppress_duplicates: record.suppress_duplicates,
    uri: state.run_id ? `orch://runs/${state.run_id}` : null,
  };
}

export const ProposalKindSchema = z.enum(['repair', 'skill', 'optimize', 'innovate']);
export const ProposalDecisionSchema = z.enum(['accepted_for_later', 'dismissed', 'already_captured']);
