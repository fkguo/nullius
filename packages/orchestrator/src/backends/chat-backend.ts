export type TextContent = { type: 'text'; text: string };
export type ToolUseContent = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ToolResultContent = { type: 'tool_result'; tool_use_id: string; content: string };
export type MessageContent = TextContent | ToolUseContent | ToolResultContent;

export type MessageParam = {
  role: 'user' | 'assistant';
  content: string | MessageContent[];
};

export type Tool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

export type LlmUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  total_tokens?: number;
};

export type LlmResponse = { content: MessageContent[]; stop_reason: string; usage?: LlmUsage | null };

export type MessagesCreateFn = (params: {
  model: string;
  max_tokens: number;
  messages: MessageParam[];
  tools: Tool[];
}) => Promise<LlmResponse>;

export type ChatBackendRequest = {
  model: string;
  maxTokens: number;
  messages: MessageParam[];
  tools: Tool[];
};

export interface ChatBackend {
  createMessage(params: ChatBackendRequest): Promise<LlmResponse>;
}
