import type { TeamExecutionState } from './team-execution-types.js';
import type { TeamExecutionStateManager } from './team-execution-storage.js';
import { executeRuntimeBucket } from './team-unified-runtime-support.js';
import type {
  ExecuteUnifiedTeamRuntimeInput,
  TeamAssignmentExecutionResult,
} from './team-unified-runtime-types.js';

// Sequential is a first-class multi-assignment path: each assignment fully merges
// and saves team-local state before the next launch begins, but failures remain
// team-local and do not fabricate stage_gated-style blocking.
export function assertSequentialPolicyBoundary(
  coordinationPolicy: ExecuteUnifiedTeamRuntimeInput['coordinationPolicy'],
  assignments: TeamExecutionState['delegate_assignments'],
): void {
  if (coordinationPolicy !== 'supervised_delegate' || assignments.length === 1) return;
  throw new Error(
    'supervised_delegate only supports a single assignment; use sequential for multi-assignment team-local execution',
  );
}

export async function executeSequentialRuntime(
  input: ExecuteUnifiedTeamRuntimeInput,
  state: TeamExecutionState,
  manager: TeamExecutionStateManager,
  assignments: TeamExecutionState['delegate_assignments'],
): Promise<TeamAssignmentExecutionResult[]> {
  const results: TeamAssignmentExecutionResult[] = [];
  for (const assignment of assignments) {
    // Sequential continues through the ordered list even when an earlier
    // assignment fails; only stage_gated provides fail-stop stage blocking.
    const bucketResults = await executeRuntimeBucket(input, state, manager, {
      stage: assignment.stage,
      assignments: [assignment],
      concurrent: false,
    });
    results.push(...bucketResults);
  }
  return results;
}
