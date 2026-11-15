import type { MessageContent, MessageParam, ToolResultContent } from './backends/chat-backend.js';

type CompactStats = { changedMessages: number; compactedBlocks: number; compactedToolResults: number; removedMessages: number };

const MARKER_PREFIX = '[runtime marker]';
const MAX_INLINE_CHARS = 240;
const MAX_TOOL_RESULT_CHARS = 320;
const MAX_RECENT_MESSAGES = 4;
const MAX_REMOVED_MESSAGE_PREVIEW = 3;

// Strings are immutable; this snapshot stays outside the excerpted dialogue.
// Tool results are evidence rather than instructions and never enter it.
export function captureUserInstructions(messages: readonly MessageParam[]): readonly string[] {
  return Object.freeze(messages.flatMap(message => message.role !== 'user' ? []
    : typeof message.content === 'string' ? [message.content]
      : message.content.filter(block => block.type === 'text').map(block => block.text)));
}

export function compactMessagesForOverflow(
  messages: MessageParam[],
  instructions: readonly string[] = captureUserInstructions(messages),
): { messages: MessageParam[]; stats: CompactStats } | null {
  // Validate before transforming: dropping a malformed exchange must not turn
  // invalid input into an apparently usable transcript.
  if (partitionToolExchanges(messages) === null) return null;
  const instructionTexts = new Set(instructions);
  const dialogue = messages.flatMap(message => {
    if (message.role !== 'user') return [message];
    if (typeof message.content === 'string') return instructionTexts.has(message.content) ? [] : [message];
    const content = message.content.filter(block => block.type !== 'text' || !instructionTexts.has(block.text));
    return content.length > 0 ? [{ ...message, content }] : [];
  });
  const compactedMessages = dialogue.map(compactMessage);
  const groups = partitionToolExchanges(compactedMessages.map(item => item.message))!;
  const stats: CompactStats = compactedMessages.reduce((acc, item) => ({
    changedMessages: acc.changedMessages + item.changedMessages,
    compactedBlocks: acc.compactedBlocks + item.compactedBlocks,
    compactedToolResults: acc.compactedToolResults + item.compactedToolResults,
    removedMessages: acc.removedMessages,
  }), { changedMessages: 0, compactedBlocks: 0, compactedToolResults: 0, removedMessages: 0 });
  let recentMessageCount = 0;
  let firstRecentGroup = groups.length;
  // The target is soft: a tool turn and all of its results are indivisible,
  // even if that exchange alone exceeds the target message count.
  while (firstRecentGroup > 0 && recentMessageCount < MAX_RECENT_MESSAGES) {
    firstRecentGroup -= 1;
    recentMessageCount += groups[firstRecentGroup]!.length;
  }
  const removed = groups.slice(0, firstRecentGroup).flat();
  stats.removedMessages = removed.length;
  if (stats.changedMessages === 0 && stats.removedMessages === 0) return null;
  const capsule: MessageParam[] = instructions.length === 0 ? [] : [{
    role: 'user',
    content: [
      { type: 'text', text: `${MARKER_PREFIX} Original user instructions below are retained verbatim, in their original order.` },
      ...instructions.map(text => ({ type: 'text' as const, text })),
    ],
  }];
  return {
    messages: [...capsule, {
      role: 'user',
      content: `${MARKER_PREFIX} Context compaction applied after provider window overflow.\n${summarizeRemovedMessages(removed)}\nExcerpts and removed-message identities are not complete evidence. Reacquire required source content before relying on it.`,
    }, ...groups.slice(firstRecentGroup).flat()],
    stats,
  };
}

function partitionToolExchanges(messages: MessageParam[]): MessageParam[][] | null {
  const groups: MessageParam[][] = [];
  const seen = new Set<string>();
  const pending = new Set<string>();
  let group: MessageParam[] = [];
  for (const message of messages) {
    group.push(message);
    const blocks = typeof message.content === 'string' ? [] : message.content;
    const uses = blocks.filter(block => block.type === 'tool_use');
    if (pending.size > 0) {
      // Complete the whole previous assistant turn in the immediately next
      // user message. All results must precede any ordinary text.
      if (message.role !== 'user' || uses.length > 0) return null;
      let textSeen = false;
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          if (textSeen || !pending.delete(block.tool_use_id)) return null;
        } else {
          if (pending.size > 0) return null;
          textSeen = true;
        }
      }
      if (pending.size > 0) return null;
      groups.push(group);
      group = [];
      continue;
    }
    if (uses.length > 0 && (message.role !== 'assistant' || pending.size > 0)) return null;
    for (const block of uses) {
      if (seen.has(block.id)) return null;
      seen.add(block.id);
      pending.add(block.id);
    }
    for (const block of blocks) {
      // Results without a preceding pending assistant turn are orphaned.
      if (block.type === 'tool_result') return null;
    }
    if (pending.size === 0) {
      groups.push(group);
      group = [];
    }
  }
  return pending.size === 0 ? groups : null;
}

function compactMessage(message: MessageParam): {
  message: MessageParam;
  changedMessages: number;
  compactedBlocks: number;
  compactedToolResults: number;
} {
  if (typeof message.content === 'string') {
    const compacted = message.role === 'user' ? message.content
      : compactText(message.content, 'assistant message', MAX_INLINE_CHARS);
    return compacted === message.content
      ? { message, changedMessages: 0, compactedBlocks: 0, compactedToolResults: 0 }
      : { message: { ...message, content: compacted }, changedMessages: 1, compactedBlocks: 1, compactedToolResults: 0 };
  }
  let compactedBlocks = 0;
  let compactedToolResults = 0;
  const content: MessageContent[] = message.content.map(block => {
    if (block.type === 'text' && message.role !== 'user') {
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
  return `${MARKER_PREFIX} ${label} compacted; original_chars=${text.length}; incomplete_excerpt="${excerpt(text)}"`;
}

function summarizeRemovedMessages(messages: MessageParam[]): string {
  const removedErrors = messages.reduce((count, message) => count + (typeof message.content === 'string' ? 0
    : message.content.filter(block => block.type === 'tool_result' && block.is_error === true).length), 0);
  const preview = messages.slice(0, MAX_REMOVED_MESSAGE_PREVIEW).map((message, index) => `${index + 1}. ${summarizeMessage(message)}`).join('\n');
  const extra = messages.length > MAX_REMOVED_MESSAGE_PREVIEW ? `\n+ ${messages.length - MAX_REMOVED_MESSAGE_PREVIEW} more removed message(s).` : '';
  return `removed_messages=${messages.length}; removed_tool_result_errors=${removedErrors} (this compaction pass only)\n${preview}${extra}`;
}

function summarizeMessage(message: MessageParam): string {
  if (typeof message.content === 'string') {
    return `${message.role} text removed`;
  }
  const parts = message.content.map(block => {
    if (block.type === 'tool_use') return `tool_use:${block.id}:${block.name}`;
    if (block.type === 'tool_result') return `tool_result:${block.tool_use_id}${block.is_error === true ? ' status=error' : ''} content removed`;
    return 'text removed';
  });
  return `${message.role} ${parts.join(' | ')}`;
}

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}
