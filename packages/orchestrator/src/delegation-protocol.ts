import type { ResearchHandoff } from './research-loop/handoff-types.js';
import type { ResearchTaskKind } from './research-loop/task-types.js';

type TeamCoordinationPolicy = 'sequential' | 'parallel' | 'stage_gated' | 'supervised_delegate';
type ResearchHandoffKind = ResearchHandoff['handoff_kind'];

export interface TeamDelegationProtocol {
  TASK: {
    assignment_id: string;
    task_id: string;
    task_kind: ResearchTaskKind;
    owner_role: string;
    delegate_role: string;
    delegate_id: string;
    stage: number;
  };
  EXPECTED_OUTCOME: {
    terminal_statuses: Array<'completed' | 'awaiting_approval' | 'failed'>;
    resumable: boolean;
    handoff_kind: ResearchHandoffKind | null;
  };
  REQUIRED_TOOLS: {
    tool_names: string[];
  };
  MUST_DO: {
    items: string[];
  };
  MUST_NOT_DO: {
    items: string[];
  };
  CONTEXT: {
    workspace_id: string;
    coordination_policy: TeamCoordinationPolicy;
    handoff_id: string | null;
    checkpoint_id: string | null;
  };
}

export interface BuildTeamDelegationProtocolInput {
  assignment_id: string;
  workspace_id: string;
  task_id: string;
  task_kind: ResearchTaskKind;
  owner_role: string;
  delegate_role: string;
  delegate_id: string;
  coordination_policy: TeamCoordinationPolicy;
  stage: number;
  handoff_id: string | null;
  handoff_kind: ResearchHandoffKind | null;
  checkpoint_id: string | null;
  required_tools: string[];
}

export function buildTeamDelegationProtocol(
  input: BuildTeamDelegationProtocolInput,
): TeamDelegationProtocol {
  return {
    TASK: {
      assignment_id: input.assignment_id,
      task_id: input.task_id,
      task_kind: input.task_kind,
      owner_role: input.owner_role,
      delegate_role: input.delegate_role,
      delegate_id: input.delegate_id,
      stage: input.stage,
    },
    EXPECTED_OUTCOME: {
      terminal_statuses: ['completed', 'awaiting_approval', 'failed'],
      resumable: true,
      handoff_kind: input.handoff_kind,
    },
    REQUIRED_TOOLS: {
      tool_names: [...input.required_tools],
    },
    MUST_DO: {
      items: [
        'Respect the team permission matrix before delegating or applying interventions.',
        'Keep progress resumable through the shared runtime manifest and checkpoint bindings.',
        'Treat workspace/task/handoff/checkpoint refs as the only substrate authority for project state.',
      ],
    },
    MUST_NOT_DO: {
      items: [
        'Do not invent a second project-state store outside the existing workspace/task/handoff refs.',
        'Do not bypass approval gates, tool loopback, or host sampling boundaries.',
        'Do not mutate unrelated assignments when handling this delegated task.',
      ],
    },
    CONTEXT: {
      workspace_id: input.workspace_id,
      coordination_policy: input.coordination_policy,
      handoff_id: input.handoff_id,
      checkpoint_id: input.checkpoint_id,
    },
  };
}

function renderProtocolValue(value: object | string[] | string | number | boolean | null): string {
  if (Array.isArray(value)) {
    return value.map(item => `- ${item}`).join('\n');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entry]) => Array.isArray(entry) ? `${key}:\n${renderProtocolValue(entry)}` : `${key}: ${String(entry)}`)
      .join('\n');
  }
  return String(value);
}

export function renderTeamDelegationProtocol(protocol: TeamDelegationProtocol): string {
  const sections = Object.entries(protocol) as Array<[keyof TeamDelegationProtocol, TeamDelegationProtocol[keyof TeamDelegationProtocol]]>;
  return sections
    .map(([section, value]) => `## ${section}\n${renderProtocolValue(value)}`)
    .join('\n\n');
}
