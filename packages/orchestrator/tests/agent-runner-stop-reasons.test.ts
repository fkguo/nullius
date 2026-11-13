import { describe, expect, it } from 'vitest';
import { isTerminalCompletionStopReason, normalizeStopReason } from '../src/agent-runner-stop-reasons.js';

describe('MCP sampling stop reasons', () => {
  it('continues a canonical MCP toolUse response instead of treating it as completion or an unknown reason', () => {
    expect(normalizeStopReason('toolUse')).toEqual({ normalized: 'tool_use', kind: 'tool_use' });
    expect(isTerminalCompletionStopReason('toolUse')).toBe(false);
  });

  it.each(['endTurn', 'stopSequence'])('recognizes %s as a terminal completion', stopReason => {
    expect(isTerminalCompletionStopReason(stopReason)).toBe(true);
  });

  it('keeps a token-limited reply distinct from successful completion', () => {
    expect(normalizeStopReason('maxTokens')).toEqual({ normalized: 'max_tokens', kind: 'truncation' });
    expect(isTerminalCompletionStopReason('maxTokens')).toBe(false);
  });

  it('continues to reject unsupported stop reasons', () => {
    expect(() => normalizeStopReason('unknownHostReason')).toThrow('Unknown assistant stop_reason');
    expect(isTerminalCompletionStopReason('unknownHostReason')).toBe(false);
  });
});
