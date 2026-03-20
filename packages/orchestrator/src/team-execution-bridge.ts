import { ApprovalGate } from './approval-gate.js';
import type { MessageContent, MessageParam, MessagesCreateFn } from './backends/chat-backend.js';
import { createStateManager, requireState } from './orch-tools/common.js';
import { executeTeamDelegatedRuntime } from './team-execution-runtime.js';
import type { AgentToolHandlerContext } from './orch-tools/agent-runtime.js';
import type { ExecuteTeamDelegatedRuntimeInput } from './team-execution-runtime.js';
import type { TeamPermissionMatrix } from './team-execution-types.js';

type SamplingTextBlock = { type: 'text'; text: string };
type SamplingToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type SamplingToolResultBlock = {
  type: 'tool_result';
  toolUseId: string;
  content: SamplingTextBlock[];
};
type SamplingBlock = SamplingTextBlock | SamplingToolUseBlock | SamplingToolResultBlock;

function defaultTeamPermissions(): TeamPermissionMatrix {
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

function createLoopbackToolCaller(ctx: AgentToolHandlerContext) {
  return {
    callTool: async (name: string, args: Record<string, unknown>) => {
      if (!ctx.callTool) {
        throw new Error('team runtime requires tool-call loopback support');
      }
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
  if (typeof content === 'string') {
    return { type: 'text', text: content };
  }
  return content.map(block => {
    if (block.type === 'tool_result') {
      return {
        type: 'tool_result' as const,
        toolUseId: block.tool_use_id,
        content: [{ type: 'text' as const, text: block.content }],
      };
    }
    return block;
  });
}

function fromSamplingContent(content: SamplingBlock | SamplingBlock[]): MessageContent[] {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map(block => {
    if (block.type === 'tool_result') {
      return {
        type: 'tool_result' as const,
        tool_use_id: block.toolUseId,
        content: block.content.map(item => item.text).join('\n'),
      };
    }
    return block;
  });
}

function createSamplingAdapter(ctx: AgentToolHandlerContext): MessagesCreateFn {
  return async createParams => {
    if (!ctx.createMessage) {
      throw new Error('team runtime requires host sampling/createMessage support');
    }
    const response = await ctx.createMessage({
      messages: createParams.messages.map(message => ({
        role: message.role,
        content: toSamplingContent(message.content),
      })),
      maxTokens: createParams.max_tokens,
      modelPreferences: { hints: [{ name: createParams.model }] },
      tools: createParams.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema,
      })),
      toolChoice: { mode: 'auto' },
    });
    return {
      content: fromSamplingContent(response.content),
      stop_reason: response.stopReason ?? 'endTurn',
    };
  };
}

export async function executeDefaultTeamDelegatedRuntime(
  input: Omit<ExecuteTeamDelegatedRuntimeInput, 'permissions'>,
): Promise<ReturnType<typeof executeTeamDelegatedRuntime>> {
  return executeTeamDelegatedRuntime({ ...input, permissions: defaultTeamPermissions() });
}

export async function executeTeamRuntimeFromToolParams(
  params: {
    project_root: string;
    run_id: string;
    model: string;
    messages: ExecuteTeamDelegatedRuntimeInput['messages'];
    tools: ExecuteTeamDelegatedRuntimeInput['tools'];
    resume_from?: string;
    max_turns?: number;
    team?: {
      workspace_id?: string;
      task_id?: string;
      owner_role?: string;
      delegate_role?: string;
      delegate_id?: string;
      coordination_policy?: ExecuteTeamDelegatedRuntimeInput['coordinationPolicy'];
      task_kind?: ExecuteTeamDelegatedRuntimeInput['taskKind'];
      handoff_id?: string | null;
      handoff_kind?: ExecuteTeamDelegatedRuntimeInput['handoffKind'];
      checkpoint_id?: string | null;
      permissions?: TeamPermissionMatrix;
      interventions?: ExecuteTeamDelegatedRuntimeInput['interventions'];
    };
  },
  ctx: AgentToolHandlerContext,
): Promise<ReturnType<typeof executeTeamDelegatedRuntime>> {
  const { manager, projectRoot } = createStateManager(params.project_root);
  const state = requireState(projectRoot, manager);
  const team = params.team ?? {};
  return executeTeamDelegatedRuntime({
    projectRoot,
    runId: params.run_id,
    workspaceId: team.workspace_id ?? state.run_id ?? `workspace:${params.run_id}`,
    taskId: team.task_id ?? state.current_step?.step_id ?? 'delegate-task',
    ownerRole: team.owner_role ?? 'lead',
    delegateRole: team.delegate_role ?? 'delegate',
    delegateId: team.delegate_id ?? 'delegate-1',
    coordinationPolicy: team.coordination_policy ?? 'supervised_delegate',
    permissions: team.permissions ?? defaultTeamPermissions(),
    taskKind: team.task_kind,
    messages: params.messages,
    tools: params.tools,
    model: params.model,
    handoffId: team.handoff_id,
    handoffKind: team.handoff_kind,
    checkpointId: team.checkpoint_id,
    interventions: team.interventions,
    resumeFrom: params.resume_from,
    maxTurns: params.max_turns,
    mcpClient: createLoopbackToolCaller(ctx),
    approvalGate: new ApprovalGate({}),
    _messagesCreate: createSamplingAdapter(ctx),
  });
}
