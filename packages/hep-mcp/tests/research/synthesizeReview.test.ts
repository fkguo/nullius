import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/tools/research/deepAnalyze.js', () => ({
  deepAnalyze: vi.fn(),
}));

vi.mock('../../src/tools/research/criticalAnalysis.js', () => ({
  performCriticalAnalysis: vi.fn(),
}));

vi.mock('../../src/tools/research/conflictDetector.js', () => ({
  detectConflicts: vi.fn(),
}));

vi.mock('../../src/api/client.js', () => ({
  batchGetPapers: vi.fn(),
}));

const deepAnalyze = await import('../../src/tools/research/deepAnalyze.js');
const api = await import('../../src/api/client.js');
const criticalAnalysis = await import('../../src/tools/research/criticalAnalysis.js');
const conflictDetector = await import('../../src/tools/research/conflictDetector.js');
const { synthesizeReview } = await import('../../src/tools/research/synthesizeReview.js');

describe('synthesizeReview key-equation consumption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('only emits semantically selected key equations', async () => {
    vi.mocked(criticalAnalysis.performCriticalAnalysis).mockResolvedValue([] as any);
    vi.mocked(conflictDetector.detectConflicts).mockResolvedValue({ conflicts: [] } as any);
    vi.mocked(deepAnalyze.deepAnalyze).mockResolvedValueOnce({
      papers: [{
        recid: 'p1',
        title: 'Paper One',
        success: true,
        key_equations: [
          {
            latex: 'E = mc^2',
            label: 'eq:selected',
            importance_score: 90,
            importance_band: 'high',
            selection_status: 'selected',
            confidence: 0.94,
            reason_code: 'central_claim_equation',
            selection_rationale: 'Main reported relation.',
            provenance: { backend: 'mcp_sampling', status: 'applied', authority: 'semantic_conclusion', reason_code: 'central_claim_equation' },
            reference_count: 2,
            section: 'Results',
          },
          {
            latex: 'a=b',
            label: 'eq:uncertain',
            importance_score: 0,
            selection_status: 'uncertain',
            confidence: 0.3,
            reason_code: 'supporting_definition',
            provenance: { backend: 'mcp_sampling', status: 'applied', authority: 'semantic_conclusion', reason_code: 'supporting_definition' },
            reference_count: 4,
            section: 'Setup',
          },
        ],
      }],
      summary: { total_papers: 1, successful: 1, failed: 0, total_equations: 2, total_theorems: 0 },
    } as any);
    vi.mocked(api.batchGetPapers).mockResolvedValueOnce([{ recid: 'p1', year: 2024, citation_count: 12 }] as any);

    const result = await synthesizeReview({
      identifiers: ['p1'],
      review_type: 'overview',
      options: { include_equations: true },
    });

    expect(result.review.key_equations).toHaveLength(1);
    expect(result.review.key_equations?.[0]).toEqual(expect.objectContaining({
      latex: 'E = mc^2',
      importance: 'high',
    }));
    expect(result.review.key_equations?.[0]?.description).toContain('Main reported relation.');
  });
});
