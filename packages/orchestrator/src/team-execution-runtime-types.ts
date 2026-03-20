import type { AgentEvent } from './agent-runner.js';
import type { TeamExecutionState } from './team-execution-types.js';

export interface ExecuteTeamDelegatedRuntimeResult {
  assignment_id: string;
  events: AgentEvent[];
  last_completed_step: string | null;
  manifest_path: string;
  resume_from: string | null;
  resumed: boolean;
  skipped_step_ids: string[];
  team_state: TeamExecutionState;
  team_state_path: string;
}
