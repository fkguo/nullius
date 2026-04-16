import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FinalConclusionsV1, MutationProposalV1, SkillProposalV2 } from '@autoresearch/shared';
import { invalidParams } from '@autoresearch/shared';
import { readFinalConclusionsView, readResearchOutcomeProjectionView } from './final-conclusions.js';
import { readLearningSummaryView } from './learning-summary.js';
import { readInnovateProposalView, readOptimizeProposalView, readRepairProposalView } from './repair-proposal.js';
import { readSkillProposalView } from './skill-proposal.js';
import { readTeamSummaryView } from './team-summary.js';
import { deriveLedgerStatusFromOperatorEvent } from '../operator-read-model-summary.js';
import { decisionOverlayForFingerprint, mutationProposalFingerprint, skillProposalFingerprint } from '../proposal-decisions.js';
import type { RunState } from '../types.js';
import { StateManager } from '../state-manager.js';
import { pauseFilePath, readJson, type ApprovalGateFilter } from './common.js';
import { TeamExecutionStateManager } from '../team-execution-storage.js';
import { buildTeamLiveStatusView } from '../team-execution-view.js';

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

const PROJECT_RECENT_RUN_LIMIT = 5;
const ACTIVE_DIGEST_RUN_STATUSES = new Set([
  'running',
  'awaiting_approval',
  'paused',
  'blocked',
  'needs_recovery',
]);

type DigestProposalKind = 'repair' | 'skill' | 'optimize' | 'innovate';
const CURATED_WORKFLOW_OUTPUT_KEYS = ['topic_analysis', 'critical_analysis', 'network_analysis', 'connection_scan'] as const;
const RESEARCH_NOTEBOOK_TEMPLATE_LINES = new Set([
  '# research_notebook.md',
  'This file is the human-facing research notebook.',
  'Write narrative derivations, interpretation, figures, and references here.',
  'Keep machine-stable gate structure in [research_contract.md](research_contract.md).',
  '## Goal',
  '- One-sentence objective:',
  '- Why it matters:',
  '## Derivation Notes',
  '- State assumptions explicitly.',
  '- Keep the reasoning readable; move machine-checkable pointers to [research_contract.md](research_contract.md).',
  '## Results',
  '- Key figures/tables:',
  '- Main takeaways:',
  '## Open Questions',
  '- What is still uncertain?',
  '- What would falsify the current direction?',
  '## References',
  '- Add stable links and local note pointers here as the project grows.',
]);

function artifactPathFromUri(uri: string): string | null {
  const marker = '/artifact/';
  const index = uri.indexOf(marker);
  if (index < 0) return null;
  return decodeURIComponent(uri.slice(index + marker.length));
}

function hasSubstantiveResearchNotebook(projectRoot: string): boolean {
  const notebookPath = path.join(projectRoot, 'research_notebook.md');
  if (!fs.existsSync(notebookPath)) return false;
  try {
    const content = fs.readFileSync(notebookPath, 'utf-8');
    const lines = content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .filter(line => !line.startsWith('Project: '))
      .filter(line => !line.startsWith('Last updated: '))
      .filter(line => !RESEARCH_NOTEBOOK_TEMPLATE_LINES.has(line));
    return lines.length > 0;
  } catch {
    return false;
  }
}

function readCurrentRunWorkflowOutputsView(state: RunState): {
  current_run_workflow_outputs: Record<string, unknown> | null;
  current_run_workflow_outputs_error: Record<string, unknown> | null;
} {
  const outputs = state.workflow_outputs ?? {};
  const entries = Object.entries(outputs);
  if (entries.length === 0) {
    return {
      current_run_workflow_outputs: null,
      current_run_workflow_outputs_error: null,
    };
  }

  const picked: Record<string, unknown> = {};
  const errors: Record<string, unknown>[] = [];
  // Keep this view intentionally narrow and agent-oriented; the raw inventory remains in state.workflow_outputs.
  for (const key of CURATED_WORKFLOW_OUTPUT_KEYS) {
    const output = outputs[key];
    if (!output) continue;
    const runtimeStatus = typeof output.runtime_status === 'string' ? output.runtime_status : null;
    const artifactUri = typeof output.artifact_uri === 'string' ? output.artifact_uri : null;
    const summaryText = typeof output.summary_text === 'string' ? output.summary_text : null;
    if (!runtimeStatus) {
      errors.push({
        code: 'WORKFLOW_OUTPUT_INVALID',
        output_key: key,
        message: `workflow output ${key} is missing runtime_status`,
      });
      continue;
    }
    picked[key] = {
      status: runtimeStatus,
      artifact_path: artifactUri ? artifactPathFromUri(artifactUri) : null,
      artifact_uri: artifactUri,
      summary: summaryText,
    };
  }

  return {
    current_run_workflow_outputs: Object.keys(picked).length > 0 ? picked : null,
    current_run_workflow_outputs_error: errors.length > 0
      ? {
          code: 'CURRENT_RUN_WORKFLOW_OUTPUTS_PARTIAL',
          message: `Built current_run_workflow_outputs with ${errors.length} invalid output entr${errors.length === 1 ? 'y' : 'ies'}.`,
          curated_output_keys: [...CURATED_WORKFLOW_OUTPUT_KEYS],
          output_errors: errors,
        }
      : null,
  };
}

function readResumeContextView(projectRoot: string, state: RunState): Record<string, unknown> {
  const readOrder = [
    'AGENTS.md',
    'project_charter.md',
    'research_plan.md',
    'research_contract.md',
    'research_notebook.md',
  ];
  const recommendedFiles = readOrder.filter((file) => {
    if (file !== 'research_notebook.md') return true;
    return hasSubstantiveResearchNotebook(projectRoot);
  });
  return {
    read_order: readOrder,
    status_command: 'autoresearch status --json',
    current_run_id: state.run_id,
    run_status: state.run_status,
    plan_md_path: state.plan_md_path,
    workflow_output_keys: Object.keys(state.workflow_outputs ?? {}),
    curated_workflow_output_keys: [...CURATED_WORKFLOW_OUTPUT_KEYS],
    recommended_files: recommendedFiles,
  };
}

function readPlanView(projectRoot: string, state: RunState): {
  plan_view: Record<string, unknown> | null;
  plan_view_warning: Record<string, unknown> | null;
} {
  const plan = state.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { plan_view: null, plan_view_warning: null };
  }
  const steps = Array.isArray(plan.steps)
    ? (plan.steps as unknown[])
      .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object' && !Array.isArray(step))
      .map(step => ({
        step_id: typeof step.step_id === 'string' ? step.step_id : null,
        status: typeof step.status === 'string' ? step.status : null,
        description: typeof step.description === 'string' ? step.description : null,
      }))
    : [];

  const view = {
    plan_id: typeof plan.plan_id === 'string' ? plan.plan_id : null,
    workflow_id: typeof plan.workflow_id === 'string' ? plan.workflow_id : state.workflow_id ?? null,
    plan_md_path: state.plan_md_path,
    plan_current_step_id: typeof plan.current_step_id === 'string' ? plan.current_step_id : null,
    step_count: steps.length,
    steps,
  };

  const planMdPath = typeof state.plan_md_path === 'string' && state.plan_md_path.length > 0
    ? path.resolve(projectRoot, state.plan_md_path)
    : null;
  if (!planMdPath) {
    return {
      plan_view: view,
      plan_view_warning: {
        code: 'PLAN_VIEW_REBUILT_FROM_STATE',
        message: 'Plan view was rebuilt from state.plan because plan_md_path is unavailable.',
      },
    };
  }

  try {
    const expected = new StateManager(projectRoot).renderPlanMd(plan);
    if (!fs.existsSync(planMdPath)) {
      return {
        plan_view: view,
        plan_view_warning: {
          code: 'PLAN_VIEW_REBUILT_FROM_STATE',
          message: `Plan view was rebuilt from state.plan because derived plan view is missing at ${state.plan_md_path}.`,
        },
      };
    }
    const onDisk = fs.readFileSync(planMdPath, 'utf-8');
    if (onDisk !== expected) {
      return {
        plan_view: view,
        plan_view_warning: {
          code: 'PLAN_VIEW_REBUILT_FROM_STATE',
          message: `Plan view was rebuilt from state.plan because derived plan view at ${state.plan_md_path} is stale.`,
        },
      };
    }
  } catch (error) {
    return {
      plan_view: view,
      plan_view_warning: {
        code: 'PLAN_VIEW_REBUILT_FROM_STATE',
        message: error instanceof Error
          ? `Plan view was rebuilt from state.plan because derived plan view could not be trusted: ${error.message}`
          : 'Plan view was rebuilt from state.plan because derived plan view could not be trusted.',
      },
    };
  }

  return { plan_view: view, plan_view_warning: null };
}

function pushDigestError(
  errors: Record<string, unknown>[],
  seen: Set<string>,
  error: Record<string, unknown>,
): void {
  const key = JSON.stringify(error);
  if (seen.has(key)) return;
  seen.add(key);
  errors.push(error);
}

function summarizeDigestProposal(kind: DigestProposalKind, proposal: MutationProposalV1 | SkillProposalV2): string {
  switch (kind) {
    case 'repair':
      return 'Repeated failed compute signals matched the same repair-worthy pattern more than once.';
    case 'skill': {
      const patternKind = 'trigger' in proposal ? proposal.trigger.pattern_kind ?? null : null;
      if (patternKind === 'package_usage_pattern') {
        return 'The same successful package/workflow pattern repeated across runs and now looks reusable as a playbook.';
      }
      if (patternKind === 'methodology_pattern') {
        return 'A repeated successful research methodology now looks stable enough to suggest as a reusable skill.';
      }
      return 'The same agent-trace pattern repeated enough times to justify a reusable skill suggestion.';
    }
    case 'optimize':
      return 'The same successful workflow repeated often enough to suggest a local optimization opportunity.';
    case 'innovate':
      return 'A repeated successful multi-ecosystem workflow suggests a higher-level innovation opportunity.';
  }
}

function readLatestFinalConclusionsForRun(projectRoot: string, runId: string): {
  entry: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
} {
  const relativePath = path.join('artifacts', 'runs', runId, 'final_conclusions_v1.json').split(path.sep).join('/');
  const filePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(filePath)) {
    return { entry: null, error: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<FinalConclusionsV1>;
    if (typeof parsed.summary !== 'string' || typeof parsed.created_at !== 'string') {
      throw new Error('final_conclusions_v1 is missing required summary/created_at fields');
    }
    return {
      entry: {
        run_id: runId,
        created_at: parsed.created_at,
        summary: parsed.summary,
        artifact_uri: `orch://runs/${runId}/artifact/final_conclusions_v1.json`,
      },
      error: null,
    };
  } catch (error) {
    return {
      entry: null,
      error: {
        code: 'FINAL_CONCLUSIONS_INVALID',
        run_id: runId,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function proposalFileName(kind: DigestProposalKind): string {
  switch (kind) {
    case 'repair':
      return 'mutation_proposal_repair_v1.json';
    case 'skill':
      return 'skill_proposal_v2.json';
    case 'optimize':
      return 'mutation_proposal_optimize_v1.json';
    case 'innovate':
      return 'mutation_proposal_innovate_v1.json';
  }
}

function readLatestProposalForRun(params: {
  projectRoot: string;
  runId: string;
  kind: DigestProposalKind;
}): {
  entry: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
} {
  const relativePath = path.join('artifacts', 'runs', params.runId, proposalFileName(params.kind)).split(path.sep).join('/');
  const filePath = path.join(params.projectRoot, relativePath);
  if (!fs.existsSync(filePath)) {
    return { entry: null, error: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MutationProposalV1 | SkillProposalV2;
    const proposalId = parsed && typeof parsed === 'object' && 'proposal_id' in parsed ? parsed.proposal_id : null;
    if (typeof proposalId !== 'string' || proposalId.length === 0) {
      throw new Error('proposal artifact is missing proposal_id');
    }
    const overlay = params.kind === 'skill'
      ? decisionOverlayForFingerprint({
          projectRoot: params.projectRoot,
          proposalKind: 'skill',
          proposalFingerprint: skillProposalFingerprint(parsed as SkillProposalV2),
        })
      : decisionOverlayForFingerprint({
          projectRoot: params.projectRoot,
          proposalKind: params.kind,
          proposalFingerprint: mutationProposalFingerprint(parsed as MutationProposalV1),
        });
    return {
      entry: {
        run_id: params.runId,
        proposal_id: proposalId,
        summary: summarizeDigestProposal(params.kind, parsed),
        decision: overlay.decision,
        decision_ts: overlay.decision_ts,
      },
      error: overlay.error && overlay.error.code !== 'PROPOSAL_DECISION_STORE_MISSING'
        ? {
            ...overlay.error,
            run_id: params.runId,
            proposal_kind: params.kind,
          }
        : null,
    };
  } catch (error) {
    return {
      entry: null,
      error: {
        code: `${params.kind.toUpperCase()}_PROPOSAL_INVALID`,
        run_id: params.runId,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function readActiveTeamRunForDigest(projectRoot: string, runId: string, runStatus: string): {
  entry: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
} {
  const manager = new TeamExecutionStateManager(projectRoot);
  const filePath = manager.pathFor(runId);
  if (!fs.existsSync(filePath)) {
    return { entry: null, error: null };
  }
  try {
    const loaded = manager.load(runId);
    if (!loaded) {
      throw new Error(`expected team state is missing at ${path.relative(projectRoot, filePath).split(path.sep).join('/')}.`);
    }
    const live = buildTeamLiveStatusView(loaded);
    return {
      entry: {
        run_id: runId,
        run_status: runStatus,
        blocked_stage: live.blocked_stage,
        active_assignment_count: live.active_assignments.length,
        pending_approval_count: live.pending_approvals.length,
      },
      error: null,
    };
  } catch (error) {
    return {
      entry: null,
      error: {
        code: 'TEAM_SUMMARY_INVALID',
        run_id: runId,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function buildRunStatusView(projectRoot: string, state: RunState) {
  const paused = fs.existsSync(pauseFilePath(projectRoot));
  const finalConclusions = readFinalConclusionsView(projectRoot, state);
  const researchOutcomeProjection = readResearchOutcomeProjectionView(projectRoot, state);
  const planView = readPlanView(projectRoot, state);
  const workflowOutputs = readCurrentRunWorkflowOutputsView(state);
  const resumeContext = readResumeContextView(projectRoot, state);
  const repairProposal = readRepairProposalView(projectRoot, state);
  const optimizeProposal = readOptimizeProposalView(projectRoot, state);
  const innovateProposal = readInnovateProposalView(projectRoot, state);
  const skillProposal = readSkillProposalView(projectRoot, state);
  const learningSummary = readLearningSummaryView(projectRoot, state);
  const teamSummary = readTeamSummaryView(projectRoot, state);
  const projectRecentDigest = readProjectRecentDigestView(projectRoot);
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
    artifacts: state.artifacts ?? {},
    workflow_outputs: state.workflow_outputs ?? {},
    current_run_workflow_outputs: workflowOutputs.current_run_workflow_outputs,
    current_run_workflow_outputs_error: workflowOutputs.current_run_workflow_outputs_error,
    resume_context: resumeContext,
    notes: state.notes ?? '',
    uri: state.run_id ? `orch://runs/${state.run_id}` : null,
    is_paused: paused,
    plan_view: planView.plan_view,
    plan_view_warning: planView.plan_view_warning,
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
    team_summary: teamSummary.team_summary,
    team_summary_error: teamSummary.team_summary_error,
    project_recent_digest: projectRecentDigest.project_recent_digest,
    project_recent_digest_error: projectRecentDigest.project_recent_digest_error,
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

export function readProjectRecentDigestView(projectRoot: string): {
  project_recent_digest: Record<string, unknown> | null;
  project_recent_digest_error: Record<string, unknown> | null;
} {
  const manager = new StateManager(projectRoot);
  const runList = readRunListView(manager, { limit: Number.MAX_SAFE_INTEGER, status_filter: 'all' });
  const ledgerMissing = runList.errors.find(error => error.code === 'LEDGER_MISSING');
  if (ledgerMissing) {
    return {
      project_recent_digest: null,
      project_recent_digest_error: {
        code: 'PROJECT_RECENT_DIGEST_LEDGER_MISSING',
        message: ledgerMissing.message,
      },
    };
  }

  const errors: Record<string, unknown>[] = [];
  const seenErrors = new Set<string>();
  for (const error of runList.errors) {
    if (error.code === 'LEDGER_EVENT_UNMAPPED') continue;
    pushDigestError(errors, seenErrors, error);
  }

  const digest: Record<string, unknown> = {
    recent_runs: runList.runs.slice(0, PROJECT_RECENT_RUN_LIMIT).map(run => ({
      run_id: run.run_id,
      last_status: run.last_status,
      timestamp_utc: run.timestamp_utc,
      uri: run.uri,
    })),
    latest_final_conclusions: null,
    latest_proposals: {
      repair: null,
      skill: null,
      optimize: null,
      innovate: null,
    },
    active_team_run: null,
  };
  const recentRunIds = new Set(
    (digest.recent_runs as Array<Record<string, unknown>>)
      .map(run => typeof run.run_id === 'string' ? run.run_id : '')
      .filter(runId => runId.length > 0),
  );

  for (const run of runList.runs) {
    const inspectRecentErrors = recentRunIds.has(run.run_id);
    if (!digest.latest_final_conclusions || inspectRecentErrors) {
      const finalConclusions = readLatestFinalConclusionsForRun(projectRoot, run.run_id);
      if (finalConclusions.entry && !digest.latest_final_conclusions) {
        digest.latest_final_conclusions = finalConclusions.entry;
      } else if (finalConclusions.error) {
        pushDigestError(errors, seenErrors, finalConclusions.error);
      }
    }

    const latestProposals = digest.latest_proposals as Record<DigestProposalKind, Record<string, unknown> | null>;
    for (const kind of ['repair', 'skill', 'optimize', 'innovate'] as const) {
      if (latestProposals[kind] && !inspectRecentErrors) continue;
      const proposal = readLatestProposalForRun({ projectRoot, runId: run.run_id, kind });
      if (proposal.entry && !latestProposals[kind]) {
        latestProposals[kind] = proposal.entry;
      } else if (proposal.error) {
        pushDigestError(errors, seenErrors, proposal.error);
      }
    }

    if (!digest.active_team_run && ACTIVE_DIGEST_RUN_STATUSES.has(run.last_status)) {
      const team = readActiveTeamRunForDigest(projectRoot, run.run_id, run.last_status);
      if (team.entry) {
        digest.active_team_run = team.entry;
      } else if (team.error) {
        pushDigestError(errors, seenErrors, team.error);
      }
    }
  }

  return {
    project_recent_digest: digest,
    project_recent_digest_error: errors.length > 0
      ? {
          code: 'PROJECT_RECENT_DIGEST_PARTIAL',
          message: `Built project_recent_digest with ${errors.length} read error(s).`,
          read_errors: errors,
        }
      : null,
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
