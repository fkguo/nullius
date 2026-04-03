import { invalidParams } from '@autoresearch/shared';
import { z } from 'zod';
import { ApprovalGate } from '../approval-gate.js';
import type { LlmUsage, MessageContent, MessageParam, MessagesCreateFn } from '../backends/chat-backend.js';
import type { McpToolResult, ToolCaller } from '../mcp-client.js';
import { executeDelegatedAgentRuntime } from '../research-loop/delegated-agent-runtime.js';
import { executeTeamRuntimeFromToolParams } from '../team-execution-bridge.js';
import { OrchRunExecuteAgentSchema } from './schemas.js';

type SamplingTextBlock = { type: 'text'; text: string };
type SamplingToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type SamplingToolResultBlock = {
  type: 'tool_result';
  toolUseId: string;
  content: SamplingTextBlock[];
  isError?: boolean;
};
type SamplingBlock = SamplingTextBlock | SamplingToolUseBlock | SamplingToolResultBlock;
type SamplingMessage = { role: MessageParam['role']; content: SamplingBlock | SamplingBlock[] };
type SamplingTool = { name: string; description?: string; inputSchema: Record<string, unknown> };
type SamplingCreateMessage = (params: {
  messages: SamplingMessage[];
  maxTokens: number;
  modelPreferences?: { hints?: Array<{ name?: string }> };
  tools?: SamplingTool[];
  toolChoice?: { mode?: 'auto' | 'required' | 'none' };
}) => Promise<{ model: string; content: SamplingBlock | SamplingBlock[]; stopReason?: string; usage?: LlmUsage | null }>;
type LoopbackToolCall = (name: string, args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;
export type AgentToolHandlerContext = {
  createMessage?: SamplingCreateMessage;
  callTool?: LoopbackToolCall;
};

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

function toSamplingContent(content: MessageParam['content']): SamplingBlock | SamplingBlock[] {
  if (typeof content === 'string') {
    return { type: 'text', text: content };
  }
  return content.map(block => {
    if (block.type === 'tool_result') {
      return {
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        content: [{ type: 'text', text: block.content }],
      };
    }
    return block;
  });
}

function fromSamplingContent(content: SamplingBlock | SamplingBlock[]): MessageContent[] {
  return asArray(content).map(block => {
    if (block.type === 'tool_result') {
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content.map(item => item.text).join('\n'),
      };
    }
    return block;
  });
}

function createSamplingAdapter(createMessage: SamplingCreateMessage): MessagesCreateFn {
  return async params => {
    const response = await createMessage({
      messages: params.messages.map(message => ({
        role: message.role,
        content: toSamplingContent(message.content),
      })),
      maxTokens: params.max_tokens,
      modelPreferences: { hints: [{ name: params.model }] },
      ...(params.tools.length > 0
        ? {
            tools: params.tools.map(tool => ({
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              inputSchema: tool.input_schema,
            })),
            toolChoice: { mode: 'auto' as const },
          }
        : {}),
    });
    return {
      content: fromSamplingContent(response.content),
      stop_reason: response.stopReason ?? 'endTurn',
      usage: response.usage ?? null,
    };
  };
}

function toLoopbackToolResult(result: Awaited<ReturnType<LoopbackToolCall>>): McpToolResult {
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
  return {
    ok: !result.isError,
    isError: Boolean(result.isError),
    rawText,
    json,
    errorCode: null,
  };
}

function createLoopbackToolCaller(callTool: LoopbackToolCall): ToolCaller {
  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
      return toLoopbackToolResult(await callTool(name, args));
    },
  };
}

export async function handleOrchRunExecuteAgent(
  params: z.output<typeof OrchRunExecuteAgentSchema>,
  ctx: AgentToolHandlerContext = {},
): Promise<unknown> {
  if (!ctx.createMessage) {
    throw invalidParams('orch_run_execute_agent requires host sampling/createMessage support.', {
      missing_context: 'createMessage',
    });
  }
  if (!ctx.callTool) {
    throw invalidParams('orch_run_execute_agent requires host tool-call loopback support.', {
      missing_context: 'callTool',
    });
  }
  if (params.team) {
    return executeTeamRuntimeFromToolParams(params, ctx);
  }
  return executeDelegatedAgentRuntime({
    projectRoot: params.project_root,
    runId: params.run_id,
    model: params.model,
    messages: params.messages,
    tools: params.tools,
    mcpClient: createLoopbackToolCaller(ctx.callTool),
    approvalGate: new ApprovalGate({}),
    resumeFrom: params.resume_from,
    maxTurns: params.max_turns,
    _messagesCreate: createSamplingAdapter(ctx.createMessage),
  });
}
