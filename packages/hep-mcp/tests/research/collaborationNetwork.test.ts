import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/api/client.js', () => ({
  searchAll: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const { buildCollaborationNetwork } = await import('../../src/tools/research/collaborationNetwork.js');

describe('Collaboration network: large collaboration folding', () => {
  it('folds papers with author_count>threshold into collaboration node(s)', async () => {
    vi.mocked(api.searchAll).mockResolvedValueOnce({
      papers: [
        {
          recid: '1',
          title: 'ATLAS paper',
          authors: Array.from({ length: 10 }, (_, i) => `Author ${i + 1}`),
          author_count: 3000,
          collaborations: ['ATLAS'],
          citation_count: 100,
        },
        {
          recid: '2',
          title: 'Small team paper',
          authors: ['Alice', 'Bob'],
          author_count: 2,
          citation_count: 10,
        },
      ],
    } as any);

    const result = await buildCollaborationNetwork({
      seed: 'qcd',
      mode: 'topic',
      min_papers: 1,
    });

    expect(result.statistics.folded_collaboration_papers).toBe(1);
    expect(result.statistics.skipped_large_collaboration_papers).toBe(0);
    expect(result.warnings?.some(w => w.includes('Folded 1 paper'))).toBe(true);

    const nodeNames = result.top_collaborators.map(n => n.name);
    expect(nodeNames).toContain('atlas');

    expect(result.top_collaborations.length).toBe(1);
    const edge = result.top_collaborations[0];
    expect([edge.author1, edge.author2].sort()).toEqual(['alice', 'bob']);
  });

  it('warns and skips large-collaboration papers when collaborations are missing', async () => {
    vi.mocked(api.searchAll).mockResolvedValueOnce({
      papers: [
        {
          recid: '1',
          title: 'Big collaboration (missing collaborations)',
          authors: Array.from({ length: 10 }, (_, i) => `Author ${i + 1}`),
          author_count: 100,
          citation_count: 50,
        },
        {
          recid: '2',
          title: 'Small team paper',
          authors: ['Alice', 'Bob'],
          author_count: 2,
          citation_count: 10,
        },
      ],
    } as any);

    const result = await buildCollaborationNetwork({
      seed: 'qcd',
      mode: 'topic',
      min_papers: 1,
    });

    expect(result.statistics.folded_collaboration_papers).toBe(1);
    expect(result.statistics.skipped_large_collaboration_papers).toBe(1);
    expect(result.warnings?.some(w => w.includes('Skipped 1 large-collaboration paper'))).toBe(true);

    const nodeNames = result.top_collaborators.map(n => n.name);
    expect(nodeNames).toContain('alice');
    expect(nodeNames).toContain('bob');
    expect(nodeNames).not.toContain('author 1');
  });
});

