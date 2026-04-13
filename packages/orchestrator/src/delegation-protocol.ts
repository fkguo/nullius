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
    handoff_payload: Record<string, unknown> | null;
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
  handoff_payload: Record<string, unknown> | null;
  checkpoint_id: string | null;
  required_tools: string[];
}

export function buildTeamDelegationProtocol(
  input: BuildTeamDelegationProtocolInput,
): TeamDelegationProtocol {
  const taskScopedOutputInstructions =
    input.task_kind === 'draft_update' && input.handoff_kind === 'writing'
      ? [
          `Before declaring success, call orch_run_stage_content with task_id=${input.task_id}, task_kind=draft_update, and content_type=section_output.`,
          'If no matching task-scoped staged draft is submitted, this delegated draft_update assignment will not be treated as completed.',
        ]
      : input.task_kind === 'review' && input.handoff_kind === 'review'
        ? [
            `Before declaring success, call orch_run_stage_content with task_id=${input.task_id}, task_kind=review, and content_type=reviewer_report or revision_plan.`,
            `Also call orch_run_stage_content with task_id=${input.task_id}, task_kind=review, and content_type=judge_decision.`,
            'If either the narrative review output or the task-scoped judge_decision is missing, this delegated review assignment will not be treated as completed.',
          ]
        : [];
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
        ...taskScopedOutputInstructions,
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
      handoff_payload: input.handoff_payload,
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
