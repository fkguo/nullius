/** Query and sample accounting for bounded topic metadata views. */
import * as api from '../../api/client.js';

export type { TopicMetadataQuery } from '@nullius/shared';
import type { TopicMetadataQuery } from '@nullius/shared';

/** Parentheses preserve the requested population when the topic contains OR. */
export function topicPeriodQuery(topic: string, start: number, end: number): string {
  return `(${topic}) and date:${start}->${end}`;
}

export function topicTimeRange(start: number | undefined, end: number): { start: number; end: number } {
  const effectiveStart = start ?? end - 20;
  if (!Number.isInteger(effectiveStart) || !Number.isInteger(end) || effectiveStart > end) {
    throw new Error('Topic time range requires integer years with start <= end');
  }
  return { start: effectiveStart, end };
}

export async function queryTopicMetadata(
  query: string,
  options: { size: number; sort?: string },
): Promise<{ result: api.SearchResult | null; observation: TopicMetadataQuery }> {
  try {
    const result = await api.search(query, options);
    return {
      result,
      observation: {
        status: 'available',
        query,
        requested_page_size: options.size,
        sort: options.sort,
        returned_count: result.papers.length,
        sample_complete: !result.has_more && !result.next_url && result.papers.length >= result.total,
        has_more: result.has_more,
        next_url: result.next_url,
        warning: result.warning,
      },
    };
  } catch (error) {
    return {
      result: null,
      observation: {
        status: 'unavailable',
        query,
        requested_page_size: options.size,
        sort: options.sort,
        returned_count: null,
        sample_complete: null,
        has_more: null,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
