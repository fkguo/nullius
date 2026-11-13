import type { CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function extractSamplingText(content: CreateMessageResult['content']): string {
  const chunks: string[] = [];
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    if (typeof (block as { text?: unknown }).text === 'string') {
      chunks.push((block as { text: string }).text);
    }
  }
  return chunks.join('\n').trim();
}
