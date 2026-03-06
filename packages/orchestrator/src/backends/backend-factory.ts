import type { ResolvedChatRoute } from '../routing/types.js';
import { AnthropicChatBackend } from './anthropic-backend.js';
import type { ChatBackend, MessagesCreateFn } from './chat-backend.js';

export type ChatBackendFactory = (
  route: ResolvedChatRoute,
  options?: { messagesCreate?: MessagesCreateFn },
) => ChatBackend;

export function createChatBackend(
  route: ResolvedChatRoute,
  options: { messagesCreate?: MessagesCreateFn } = {},
): ChatBackend {
  switch (route.backend) {
    case 'anthropic':
      return new AnthropicChatBackend(options.messagesCreate);
    default:
      throw new Error(`Unknown backend: ${String(route.backend)}`);
  }
}
