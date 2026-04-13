import { describe, expect, it } from 'vitest';

import {
  parseReviewJudgeDecisionV1,
  safeParseReviewJudgeDecisionV1,
} from '../review-judge-decision.js';

describe('review judge decision runtime parser', () => {
  it('accepts an accept disposition', () => {
    const parsed = safeParseReviewJudgeDecisionV1({
      schema_version: 1,
      disposition: 'accept',
      reason: 'No further evidence search is required.',
    });
    expect(parsed.ok).toBe(true);
  });

  it('accepts a request_evidence_search disposition', () => {
    const parsed = safeParseReviewJudgeDecisionV1({
      schema_version: 1,
      disposition: 'request_evidence_search',
      reason: 'Need stronger support for the disputed claim.',
      query: 'targeted evidence refresh',
      target_evidence_node_id: 'evidence-1',
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejects request_evidence_search without a query', () => {
    const parsed = safeParseReviewJudgeDecisionV1({
      schema_version: 1,
      disposition: 'request_evidence_search',
      reason: 'Need a more specific search.',
      target_evidence_node_id: 'evidence-1',
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'query' })]),
    );
  });

  it('rejects request_evidence_search without a target evidence node', () => {
    const parsed = safeParseReviewJudgeDecisionV1({
      schema_version: 1,
      disposition: 'request_evidence_search',
      reason: 'Need a more specific search.',
      query: 'targeted evidence refresh',
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'target_evidence_node_id' })]),
    );
  });

  it('rejects an unsupported disposition', () => {
    expect(() => parseReviewJudgeDecisionV1({
      schema_version: 1,
      disposition: 'retry',
      reason: 'unsupported',
    })).toThrow(/disposition/);
  });
});
