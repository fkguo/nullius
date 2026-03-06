import type { ChatBackend, ChatBackendRequest, LlmResponse, MessagesCreateFn } from './chat-backend.js';

function toAnthropicParams(params: ChatBackendRequest): Parameters<MessagesCreateFn>[0] {
  return {
    model: params.model,
    max_tokens: params.maxTokens,
    messages: params.messages,
    tools: params.tools,
  };
}

export class AnthropicChatBackend implements ChatBackend {
  private boundCreateMessage: MessagesCreateFn | null;

  constructor(messagesCreate?: MessagesCreateFn) {
    this.boundCreateMessage = messagesCreate ?? null;
  }

  async createMessage(params: ChatBackendRequest): Promise<LlmResponse> {
    if (this.boundCreateMessage) {
      return this.boundCreateMessage(toAnthropicParams(params));
    }

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    this.boundCreateMessage = (request) =>
      client.messages.create(request as Parameters<typeof client.messages.create>[0]) as Promise<LlmResponse>;
    return this.boundCreateMessage(toAnthropicParams(params));
  }
}
