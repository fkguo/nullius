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
  if (params.include_state) {
    result.state = fs.existsSync(manager.statePath) ? JSON.parse(fs.readFileSync(manager.statePath, 'utf-8')) : null;
    if (result.state === null) {
      result.state_missing = true;
    }
  }
  if (params.include_artifacts) {
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
