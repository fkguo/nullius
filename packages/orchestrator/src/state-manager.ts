// @autoresearch/orchestrator — StateManager (NEW-05a Stage 1)
// Read-only state operations for Stage 1 (write operations added in Stage 2).
// Compatible with Python orchestrator_state.py.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunState, ApprovalPolicy } from './types.js';

const AUTOPILOT_DIRNAME = '.autopilot';
const STATE_FILENAME = 'state.json';
const APPROVAL_POLICY_FILENAME = 'approval_policy.json';

function autopilotDir(repoRoot: string): string {
  const override = process.env['HEP_AUTOPILOT_DIR'];
  if (override) {
    return path.isAbsolute(override) ? override : path.join(repoRoot, override);
  }
  return path.join(repoRoot, AUTOPILOT_DIRNAME);
}

function defaultState(): RunState {
  return {
    schema_version: 1,
    run_id: null,
    workflow_id: null,
    run_status: 'idle',
    current_step: null,
    plan: null,
    plan_md_path: null,
    checkpoints: { last_checkpoint_at: null, checkpoint_interval_seconds: 900 },
    pending_approval: null,
    approval_seq: { A1: 0, A2: 0, A3: 0, A4: 0, A5: 0 },
    gate_satisfied: {},
    approval_history: [],
    artifacts: {},
    notes: '',
  };
}

export class StateManager {
  private readonly dir: string;

  constructor(repoRoot: string) {
    this.dir = autopilotDir(repoRoot);
  }

  get statePath(): string {
    return path.join(this.dir, STATE_FILENAME);
  }

  get policyPath(): string {
    return path.join(this.dir, APPROVAL_POLICY_FILENAME);
  }

  /** Read current state. Returns default state if file doesn't exist. */
  readState(): RunState {
    if (!fs.existsSync(this.statePath)) {
      return defaultState();
    }
    const raw = fs.readFileSync(this.statePath, 'utf-8');
    return JSON.parse(raw) as RunState;
  }

  /** Read approval policy. Returns empty policy if file doesn't exist. */
  readPolicy(): ApprovalPolicy {
    if (!fs.existsSync(this.policyPath)) {
      return {};
    }
    const raw = fs.readFileSync(this.policyPath, 'utf-8');
    return JSON.parse(raw) as ApprovalPolicy;
  }

  /** Check if the run is in a terminal state. */
  isTerminal(state: RunState): boolean {
    return ['completed', 'failed', 'rejected'].includes(state.run_status);
  }

  /** Check if the run has a pending approval that has timed out. */
  isApprovalTimedOut(state: RunState): boolean {
    const pending = state.pending_approval;
    if (!pending?.timeout_at) return false;
    try {
      const deadline = new Date(pending.timeout_at);
      return Date.now() > deadline.getTime();
    } catch {
      return false;
    }
  }

  /** Check if the approval budget is exhausted.
   *  Reads budgets.max_approvals from the policy (matching Python path). */
  isApprovalBudgetExhausted(state: RunState): boolean {
    const policy = this.readPolicy();
    const maxApprovals = policy.budgets?.max_approvals ?? 0;
    if (maxApprovals <= 0) return false;
    const approvedCount = state.approval_history.filter(
      (h) => h.decision === 'approved',
    ).length;
    return approvedCount >= maxApprovals;
  }

  /** Get a summary of the current run status. */
  statusSummary(state: RunState): Record<string, unknown> {
    return {
      run_id: state.run_id,
      workflow_id: state.workflow_id,
      run_status: state.run_status,
      current_step: state.current_step,
      pending_approval: state.pending_approval
        ? {
            approval_id: state.pending_approval.approval_id,
            category: state.pending_approval.category,
            timed_out: this.isApprovalTimedOut(state),
          }
        : null,
      approvals_used: state.approval_history.filter((h) => h.decision === 'approved').length,
      notes: state.notes || undefined,
    };
  }
}
