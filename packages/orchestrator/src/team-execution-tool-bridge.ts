import type { MessageContent, MessageParam, MessagesCreateFn } from './backends/chat-backend.js';
import type { AgentToolHandlerContext } from './orch-tools/agent-runtime.js';
import type { ExecuteTeamDelegatedRuntimeInput } from './team-execution-runtime.js';
import type { TeamPermissionMatrix } from './team-execution-types.js';
import type { TeamRuntimeAssignmentInput } from './team-unified-runtime-types.js';

type SamplingTextBlock = { type: 'text'; text: string };
type SamplingToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type SamplingToolResultBlock = {
  type: 'tool_result';
  toolUseId: string;
  content: SamplingTextBlock[];
};
type SamplingBlock = SamplingTextBlock | SamplingToolUseBlock | SamplingToolResultBlock;

export function defaultTeamPermissions(): TeamPermissionMatrix {
  return {
    delegation: [
      {
        from_role: 'lead',
        to_role: 'delegate',
        allowed_task_kinds: ['literature', 'idea', 'compute', 'evidence_search', 'finding', 'draft_update', 'review'],
        allowed_handoff_kinds: ['compute', 'feedback', 'literature', 'review', 'writing'],
      },
    ],
    interventions: [
      {
        actor_role: 'lead',
        allowed_scopes: ['task', 'team', 'project'],
        allowed_kinds: ['pause', 'resume', 'redirect', 'inject_task', 'approve', 'cancel', 'cascade_stop'],
      },
    ],
  };
}

export function createLoopbackToolCaller(ctx: AgentToolHandlerContext) {
  return {
    callTool: async (name: string, args: Record<string, unknown>) => {
      if (!ctx.callTool) throw new Error('team runtime requires tool-call loopback support');
      const result = await ctx.callTool(name, args);
      const rawText = result.content
        .filter(part => part.type === 'text')
        .map(part => part.text ?? '')
        .join('\n');
      let json: unknown = null;
      try {
        json = JSON.parse(rawText);
      } catch {
        json = null;
      }
      return { ok: !result.isError, isError: Boolean(result.isError), rawText, json, errorCode: null };
    },
  };
}

function toSamplingContent(content: MessageParam['content']): SamplingBlock | SamplingBlock[] {
  if (typeof content === 'string') return { type: 'text', text: content };
  return content.map(block => block.type === 'tool_result'
    ? { type: 'tool_result' as const, toolUseId: block.tool_use_id, content: [{ type: 'text' as const, text: block.content }] }
    : block);
}

function fromSamplingContent(content: SamplingBlock | SamplingBlock[]): MessageContent[] {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map(block => block.type === 'tool_result'
    ? { type: 'tool_result' as const, tool_use_id: block.toolUseId, content: block.content.map(item => item.text).join('\n') }
    : block);
}

export function createSamplingAdapter(ctx: AgentToolHandlerContext): MessagesCreateFn {
  return async createParams => {
    if (!ctx.createMessage) throw new Error('team runtime requires host sampling/createMessage support');
    const response = await ctx.createMessage({
      messages: createParams.messages.map(message => ({ role: message.role, content: toSamplingContent(message.content) })),
      maxTokens: createParams.max_tokens,
      modelPreferences: { hints: [{ name: createParams.model }] },
      tools: createParams.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema })),
      toolChoice: { mode: 'auto' },
    });
    return {
      content: fromSamplingContent(response.content),
      stop_reason: response.stopReason ?? 'endTurn',
    };
  };
}

export function buildTeamAssignments(
  team: {
    task_id?: string;
    task_kind?: ExecuteTeamDelegatedRuntimeInput['taskKind'];
    delegate_role?: string;
    delegate_id?: string;
    handoff_id?: string | null;
    handoff_kind?: ExecuteTeamDelegatedRuntimeInput['handoffKind'];
    checkpoint_id?: string | null;
    assignments?: Array<{
      stage?: number;
      task_id: string;
      task_kind?: ExecuteTeamDelegatedRuntimeInput['taskKind'];
      owner_role?: string;
      delegate_role?: string;
      delegate_id?: string;
      handoff_id?: string | null;
      handoff_kind?: ExecuteTeamDelegatedRuntimeInput['handoffKind'];
      checkpoint_id?: string | null;
    }>;
  },
  fallbackTaskId: string,
  fallbackOwnerRole: string,
  fallbackDelegateRole: string,
  fallbackDelegateId: string,
): TeamRuntimeAssignmentInput[] {
  const sharedTaskKind = team.task_kind ?? 'compute';
  if (team.assignments?.length) {
    return team.assignments.map((assignment, index) => ({
      stage: assignment.stage ?? index,
      task_id: assignment.task_id,
      task_kind: assignment.task_kind ?? sharedTaskKind,
      owner_role: assignment.owner_role ?? fallbackOwnerRole,
      delegate_role: assignment.delegate_role ?? team.delegate_role ?? fallbackDelegateRole,
      delegate_id: assignment.delegate_id ?? team.delegate_id ?? `${fallbackDelegateId}-${index + 1}`,
      handoff_id: assignment.handoff_id ?? null,
      handoff_kind: assignment.handoff_kind ?? null,
      checkpoint_id: assignment.checkpoint_id ?? null,
    }));
  }
  return [{
    stage: 0,
    task_id: team.task_id ?? fallbackTaskId,
    task_kind: sharedTaskKind,
    owner_role: fallbackOwnerRole,
    delegate_role: team.delegate_role ?? fallbackDelegateRole,
    delegate_id: team.delegate_id ?? fallbackDelegateId,
    handoff_id: team.handoff_id ?? null,
    handoff_kind: team.handoff_kind ?? null,
    checkpoint_id: team.checkpoint_id ?? null,
  }];
}
