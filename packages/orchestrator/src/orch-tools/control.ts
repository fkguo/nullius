import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  APPROVAL_GATE_TO_POLICY_KEY,
  APPROVAL_REQUIRED_DEFAULTS,
  getApprovalPolicyKey,
} from '@autoresearch/shared';
import { z } from 'zod';
import {
  createStateManager,
  requireState,
} from './common.js';
import { readFinalConclusionsView, readResearchOutcomeProjectionView } from './final-conclusions.js';
import { readLearningSummaryView } from './learning-summary.js';
import { readInnovateProposalView, readOptimizeProposalView, readRepairProposalView } from './repair-proposal.js';
import { buildRunStatusView, readProjectRecentDigestView, readProjectSurfaceDriftView } from './run-read-model.js';
import { readSkillProposalView } from './skill-proposal.js';
import { readTeamSummaryView } from './team-summary.js';
import {
  OrchPolicyQuerySchema,
  OrchRunExportSchema,
  OrchRunPauseSchema,
  OrchRunResumeSchema,
} from './schemas.js';

export async function handleOrchRunExport(
  params: z.output<typeof OrchRunExportSchema>,
): Promise<unknown> {
  const { manager, projectRoot } = createStateManager(params.project_root);
  const result: Record<string, unknown> = { project_root: projectRoot };
  const state = fs.existsSync(manager.statePath) ? manager.readState() : null;
  const projectSurfaceDrift = readProjectSurfaceDriftView(projectRoot);
  result.project_surface_drift = projectSurfaceDrift.project_surface_drift;
  result.project_surface_drift_error = projectSurfaceDrift.project_surface_drift_error;
  if (params.include_state) {
    result.state = state;
    if (result.state === null) {
      result.state_missing = true;
    }
  }
  if (params.include_artifacts) {
    const projectRecentDigest = readProjectRecentDigestView(projectRoot);
    const runsDir = path.join(projectRoot, 'artifacts', 'runs');
    if (fs.existsSync(runsDir)) {
      result.artifact_runs = fs.readdirSync(runsDir)
        .filter(runDir => fs.statSync(path.join(runsDir, runDir)).isDirectory())
        .map(runDir => ({
          run_id: runDir,
          files: fs.readdirSync(path.join(runsDir, runDir)).map(file => path.join('artifacts', 'runs', runDir, file)).slice(0, 50),
          uri: `orch://runs/${runDir}`,
        }));
    } else {
      result.artifact_runs = [];
    }
    result.project_recent_digest = projectRecentDigest.project_recent_digest;
    result.project_recent_digest_error = projectRecentDigest.project_recent_digest_error;
    if (state && state.run_id) {
      const statusView = buildRunStatusView(projectRoot, state);
      const finalConclusions = readFinalConclusionsView(projectRoot, state);
      const researchOutcomeProjection = readResearchOutcomeProjectionView(projectRoot, state);
      const repairProposal = readRepairProposalView(projectRoot, state);
      const optimizeProposal = readOptimizeProposalView(projectRoot, state);
      const innovateProposal = readInnovateProposalView(projectRoot, state);
      const skillProposal = readSkillProposalView(projectRoot, state);
      const learningSummary = readLearningSummaryView(projectRoot, state);
      const teamSummary = readTeamSummaryView(projectRoot, state);
      result.current_run_final_conclusions = finalConclusions.final_conclusions;
      result.current_run_final_conclusions_error = finalConclusions.final_conclusions_error;
      result.current_run_research_outcome_projection = researchOutcomeProjection.research_outcome_projection;
      result.current_run_research_outcome_projection_error = researchOutcomeProjection.research_outcome_projection_error;
      result.current_run_repair_mutation_proposal = repairProposal.repair_mutation_proposal;
      result.current_run_repair_mutation_proposal_error = repairProposal.repair_mutation_proposal_error;
      result.current_run_optimize_mutation_proposal = optimizeProposal.optimize_mutation_proposal;
      result.current_run_optimize_mutation_proposal_error = optimizeProposal.optimize_mutation_proposal_error;
      result.current_run_innovate_mutation_proposal = innovateProposal.innovate_mutation_proposal;
      result.current_run_innovate_mutation_proposal_error = innovateProposal.innovate_mutation_proposal_error;
      result.current_run_skill_proposal = skillProposal.skill_proposal;
      result.current_run_skill_proposal_error = skillProposal.skill_proposal_error;
      result.current_run_learning_summary = learningSummary.learning_summary;
      result.current_run_learning_summary_error = learningSummary.learning_summary_error;
      result.current_run_team_summary = teamSummary.team_summary;
      result.current_run_team_summary_error = teamSummary.team_summary_error;
      result.current_run_plan_view = statusView.plan_view ?? null;
      result.current_run_plan_view_warning = statusView.plan_view_warning ?? null;
      result.current_run_workflow_outputs = statusView.current_run_workflow_outputs ?? null;
      result.current_run_workflow_outputs_error = statusView.current_run_workflow_outputs_error ?? null;
      result.current_run_resume_context = statusView.resume_context ?? null;
      result.current_run_recovery_context = statusView.recovery_context ?? null;
    }
  }
  return {
    exported: true,
    ...result,
    uri: 'orch://runs/export',
    message: 'Export summary generated (no files copied; use artifacts/ directory for actual files).',
  };
}

export async function handleOrchRunPause(
  params: z.output<typeof OrchRunPauseSchema>,
): Promise<unknown> {
  const { manager, projectRoot } = createStateManager(params.project_root);
  const state = requireState(projectRoot, manager);
  manager.pauseRun(state, params.note);
  const updated = manager.readState();
  return {
    paused: true,
    run_id: updated.run_id,
    run_status: updated.run_status,
    uri: `orch://runs/${updated.run_id}`,
  };
}

export async function handleOrchRunResume(
  params: z.output<typeof OrchRunResumeSchema>,
): Promise<unknown> {
  const { manager, projectRoot } = createStateManager(params.project_root);
  const state = requireState(projectRoot, manager);
  manager.resumeRun(state, { note: params.note, force: params.force });
  const updated = manager.readState();
  return {
    resumed: true,
    run_id: updated.run_id,
    run_status: updated.run_status,
    uri: `orch://runs/${updated.run_id}`,
  };
}

export async function handleOrchPolicyQuery(
  params: z.output<typeof OrchPolicyQuerySchema>,
): Promise<unknown> {
  const { manager } = createStateManager(params.project_root);
  const policy = manager.readPolicy();
  const effectivePolicy = Object.keys(policy).length > 0
    ? policy
    : { require_approval_for: APPROVAL_REQUIRED_DEFAULTS };
  const result: Record<string, unknown> = {
    policy: effectivePolicy,
    gate_to_policy_key: APPROVAL_GATE_TO_POLICY_KEY,
    policy_path: fs.existsSync(manager.policyPath) ? manager.policyPath : null,
    policy_exists: fs.existsSync(manager.policyPath),
  };

  if (!params.operation) {
    return result;
  }
  result.operation = params.operation;
  const approvalRequired = (
    effectivePolicy as {
      require_approval_for?: Record<string, boolean>;
    }
  ).require_approval_for;
  result.requires_approval = approvalRequired ? (approvalRequired[params.operation] ?? true) : true;
  if (params.include_history && fs.existsSync(manager.statePath)) {
    const state = manager.readState();
    result.precedents = state.approval_history
      .filter(entry => entry.category !== null && getApprovalPolicyKey(entry.category) === params.operation)
      .slice(-5);
  }
  return result;
}
