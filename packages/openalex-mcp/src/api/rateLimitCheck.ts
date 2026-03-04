/**
 * Handler for openalex_rate_limit tool.
 *
 * Returns cached rate-limit state from the singleton, optionally refreshing
 * via a minimal-cost probe request (head of /works with per-page=1).
 */

import type { z } from 'zod';
import type { OpenAlexRateLimitSchema } from '../tools/schemas.js';
import { openalexFetch, getCostSummary, getResponseMeta } from './rateLimiter.js';

export async function handleRateLimit(
  args: z.output<typeof OpenAlexRateLimitSchema>,
): Promise<{
  cached: boolean;
  cost: ReturnType<typeof getCostSummary>;
  _meta: ReturnType<typeof getResponseMeta>;
}> {
  if (args.refresh) {
    // Minimal probe: fetch /works with per-page=1 to update headers
    try {
      const qs = new URLSearchParams({ 'per-page': '1' });
      await openalexFetch(`/works?${qs}`);
    } catch {
      // Ignore errors — we still return whatever state we have cached
    }
    return { cached: false, cost: getCostSummary(), _meta: getResponseMeta() };
  }

  return { cached: true, cost: getCostSummary(), _meta: getResponseMeta() };
}
