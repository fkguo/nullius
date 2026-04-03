import type { MessageParam, ToolResultContent } from './backends/chat-backend.js';

type CompactStats = { changedMessages: number; compactedBlocks: number; compactedToolResults: number; removedMessages: number };

const MARKER_PREFIX = '[runtime marker]';
const MAX_INLINE_CHARS = 240;
const MAX_TOOL_RESULT_CHARS = 320;
const MAX_RECENT_MESSAGES = 4;
const MAX_REMOVED_MESSAGE_PREVIEW = 3;

export function compactMessagesForOverflow(messages: MessageParam[]): { messages: MessageParam[]; stats: CompactStats } | null {
  const compactedMessages = messages.map(compactMessage);
  const compacted = compactedMessages.map(item => item.message);
  const stats: CompactStats = compactedMessages.reduce((acc, item) => ({
    changedMessages: acc.changedMessages + item.changedMessages,
    compactedBlocks: acc.compactedBlocks + item.compactedBlocks,
    compactedToolResults: acc.compactedToolResults + item.compactedToolResults,
    removedMessages: acc.removedMessages,
  }), { changedMessages: 0, compactedBlocks: 0, compactedToolResults: 0, removedMessages: 0 });
  if (compacted.length > MAX_RECENT_MESSAGES + 1) {
    const head = compacted[0] ? [compacted[0]] : [];
    const tail = compacted.slice(-MAX_RECENT_MESSAGES);
    const removed = compacted.slice(head.length, compacted.length - tail.length);
    compacted.splice(0, compacted.length, ...head, {
      role: 'user',
      content: `${MARKER_PREFIX} Context compaction applied after provider window overflow.\n${summarizeRemovedMessages(removed)}`,
    }, ...tail);
    stats.removedMessages = removed.length;
  }
  return stats.changedMessages > 0 || stats.removedMessages > 0 ? { messages: compacted, stats } : null;
}

function compactMessage(message: MessageParam): {
  message: MessageParam;
  changedMessages: number;
  compactedBlocks: number;
  compactedToolResults: number;
} {
  if (typeof message.content === 'string') {
    const compacted = compactText(message.content, message.role === 'user' ? 'user message' : 'assistant message', MAX_INLINE_CHARS);
    return compacted === message.content
      ? { message, changedMessages: 0, compactedBlocks: 0, compactedToolResults: 0 }
      : { message: { ...message, content: compacted }, changedMessages: 1, compactedBlocks: 1, compactedToolResults: 0 };
  }
  let compactedBlocks = 0;
  let compactedToolResults = 0;
  const content = message.content.map(block => {
    if (block.type === 'text') {
      const compacted = compactText(block.text, `${message.role} text block`, MAX_INLINE_CHARS);
      if (compacted !== block.text) {
        compactedBlocks += 1;
        return { ...block, text: compacted };
      }
      return block;
    }
    if (block.type === 'tool_result') {
      const compacted = compactToolResult(block);
      if (compacted !== block) {
        compactedBlocks += 1;
        compactedToolResults += 1;
      }
      return compacted;
    }
    return block;
  });
  return compactedBlocks === 0
    ? { message, changedMessages: 0, compactedBlocks: 0, compactedToolResults: 0 }
    : { message: { ...message, content }, changedMessages: 1, compactedBlocks, compactedToolResults };
}

function compactToolResult(block: ToolResultContent): ToolResultContent {
  const compacted = compactText(block.content, `tool_result ${block.tool_use_id}`, MAX_TOOL_RESULT_CHARS);
  return compacted === block.content ? block : { ...block, content: compacted };
}

function compactText(text: string, label: string, limit: number): string {
  if (text.startsWith(MARKER_PREFIX) || text.length <= limit) {
    return text;
  }
  return `${MARKER_PREFIX} ${label} compacted; original_chars=${text.length}; excerpt="${excerpt(text)}"`;
}

function summarizeRemovedMessages(messages: MessageParam[]): string {
  const preview = messages.slice(0, MAX_REMOVED_MESSAGE_PREVIEW).map((message, index) => `${index + 1}. ${summarizeMessage(message)}`).join('\n');
  const extra = messages.length > MAX_REMOVED_MESSAGE_PREVIEW ? `\n+ ${messages.length - MAX_REMOVED_MESSAGE_PREVIEW} more removed message(s).` : '';
  return `removed_messages=${messages.length}\n${preview}${extra}`;
}

function summarizeMessage(message: MessageParam): string {
  if (typeof message.content === 'string') {
    return `${message.role} text="${excerpt(message.content)}"`;
  }
  const parts = message.content.map(block => {
    if (block.type === 'tool_use') return `tool_use:${block.name}`;
    if (block.type === 'tool_result') return `tool_result:${block.tool_use_id}="${excerpt(block.content)}"`;
    return `text="${excerpt(block.text)}"`;
  });
  return `${message.role} ${parts.join(' | ')}`;
}

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}
