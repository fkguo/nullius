// @autoresearch/orchestrator — approval gate helpers
// Implements approval timeout enforcement and budget limits.

import { createHash } from 'node:crypto';
import type { RunState, ApprovalPolicy, PendingApproval } from './types.js';

export interface ApprovalRequest {
  category: string;
  plan_step_ids?: string[];
  packet_path: string;
  timeoutSeconds?: number;
  onTimeout?: string;
}

export interface ApprovalCheckResult {
  allowed: boolean;
  reason?: string;
  action?: string;
}

/** Compute SHA-256 of a canonically serialized object.
 *  Uses recursive key sorting to match Python's json.dumps(sort_keys=True).
 *  NOTE: Python json.dumps uses (', ', ': ') separators by default.
 *  When Python implements approval packet hashing, both sides must agree
 *  on separators. Recommend: json.dumps(sort_keys=True, separators=(',',':'))
 *  for compact canonical form matching JSON.stringify. */
export function approvalPacketSha256(packet: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortKeysRecursive(packet));
  return createHash('sha256').update(canonical).digest('hex');
}

import { sortKeysRecursive } from './util.js';

export class ApprovalGate {
  private readonly policy: ApprovalPolicy;

  constructor(policy: ApprovalPolicy) {
    this.policy = policy;
  }

  /** Create a PendingApproval from a request.
   *  Timeout is read from policy.timeouts.<category>.timeout_seconds
   *  or falls back to the request-specified value, then 86400 (24h). */
  createPending(request: ApprovalRequest): PendingApproval {
    const categoryTimeouts = this.policy.timeouts?.[request.category];
    const timeoutSeconds = request.timeoutSeconds
      ?? categoryTimeouts?.timeout_seconds
      ?? 86400;
    const onTimeout = request.onTimeout
      ?? categoryTimeouts?.on_timeout
      ?? 'block';

    const now = new Date();
    const timeoutAt = new Date(now.getTime() + timeoutSeconds * 1000);

    return {
      approval_id: `apr_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      category: request.category,
      plan_step_ids: request.plan_step_ids ?? [],
      requested_at: now.toISOString(),
      timeout_at: timeoutAt.toISOString(),
      on_timeout: onTimeout,
      packet_path: request.packet_path,
    };
  }

  /** Check if a root-run approval action is allowed given current state. */
  checkApproval(state: RunState, approvalId: string): ApprovalCheckResult {
    const pending = state.pending_approval;
    if (!pending) {
      return { allowed: false, reason: 'No pending approval' };
    }
    if (pending.approval_id !== approvalId) {
      return { allowed: false, reason: `Approval ID mismatch: expected ${pending.approval_id}` };
    }

    // C-01: Check timeout
    if (pending.timeout_at) {
      try {
        const deadline = new Date(pending.timeout_at);
        if (Date.now() > deadline.getTime()) {
          return {
            allowed: false,
            reason: `Approval timed out at ${pending.timeout_at}`,
            action: pending.on_timeout,
          };
        }
      } catch {
        // Malformed timeout — allow approval to proceed
      }
    }

    // C-01: Check budget
    const maxApprovals = this.policy.budgets?.max_approvals ?? 0;
    if (maxApprovals > 0) {
      const approvedCount = state.approval_history.filter(
        (h) => h.decision === 'approved',
      ).length;
      if (approvedCount >= maxApprovals) {
        return {
          allowed: false,
          reason: `Approval budget exhausted (${approvedCount}/${maxApprovals})`,
          action: 'budget_exhausted',
        };
      }
    }

    return { allowed: true };
  }

  /** Check if the root-run pending approval has timed out (for checkpoint enforcement). */
  checkTimeout(state: RunState): ApprovalCheckResult {
    const pending = state.pending_approval;
    if (!pending?.timeout_at) {
      return { allowed: true };
    }

    try {
      const deadline = new Date(pending.timeout_at);
      if (Date.now() > deadline.getTime()) {
        return {
          allowed: false,
          reason: `Approval ${pending.approval_id} timed out`,
          action: pending.on_timeout,
        };
      }
    } catch {
      // Malformed timeout — no enforcement
    }

    return { allowed: true };
  }
}
