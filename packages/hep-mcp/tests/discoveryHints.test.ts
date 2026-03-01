/**
 * NEW-CONN-01: Discovery next_actions hints tests.
 */

import { describe, it, expect } from 'vitest';
import {
  discoveryNextActions,
  deepResearchAnalyzeNextActions,
  zoteroImportNextActions,
  withNextActions,
} from '../src/tools/utils/discoveryHints.js';

describe('discoveryNextActions (NEW-CONN-01)', () => {
  it('returns empty for no papers', () => {
    expect(discoveryNextActions([])).toHaveLength(0);
    expect(discoveryNextActions(null)).toHaveLength(0);
    expect(discoveryNextActions(undefined)).toHaveLength(0);
  });

  it('returns hints when papers have recids', () => {
    const papers = [
      { recid: '12345', title: 'Paper A' },
      { recid: '67890', title: 'Paper B' },
    ];
    const actions = discoveryNextActions(papers);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].tool).toBe('inspire_deep_research');
    const args = actions[0].args as Record<string, unknown>;
    expect(args.identifiers).toEqual(['12345', '67890']);
  });

  it('caps identifiers at 10', () => {
    const papers = Array.from({ length: 20 }, (_, i) => ({ recid: String(i) }));
    const actions = discoveryNextActions(papers);
    const args = actions[0].args as Record<string, unknown>;
    expect(args.identifiers).toHaveLength(10);
  });

  it('handles numeric recids', () => {
    const papers = [{ recid: 12345 }];
    const actions = discoveryNextActions(papers);
    const args = actions[0].args as Record<string, unknown>;
    expect(args.identifiers).toEqual(['12345']);
  });

  it('handles id instead of recid', () => {
    const papers = [{ id: '99999' }];
    const actions = discoveryNextActions(papers);
    const args = actions[0].args as Record<string, unknown>;
    expect(args.identifiers).toEqual(['99999']);
  });
});

describe('deepResearchAnalyzeNextActions', () => {
  it('returns empty for no identifiers', () => {
    expect(deepResearchAnalyzeNextActions([])).toHaveLength(0);
  });

  it('suggests synthesize with identifiers', () => {
    const actions = deepResearchAnalyzeNextActions(['1', '2']);
    expect(actions).toHaveLength(1);
    expect(actions[0].args).toHaveProperty('mode', 'synthesize');
    expect(actions[0].args).toHaveProperty('identifiers', ['1', '2']);
  });
});

describe('zoteroImportNextActions', () => {
  it('returns empty for no identifiers', () => {
    expect(zoteroImportNextActions([])).toHaveLength(0);
  });

  it('suggests deep research with identifiers', () => {
    const actions = zoteroImportNextActions(['111', '222']);
    expect(actions).toHaveLength(1);
    expect(actions[0].tool).toBe('inspire_deep_research');
    expect(actions[0].args).toHaveProperty('identifiers', ['111', '222']);
  });
});

describe('withNextActions', () => {
  it('attaches next_actions to object', () => {
    const result = withNextActions({ papers: [] }, [{ tool: 'x', args: {}, reason: 'y' }]);
    expect(result.next_actions).toHaveLength(1);
  });

  it('returns original for empty actions', () => {
    const original = { papers: [], total: 0 };
    const result = withNextActions(original, []);
    expect(result).toBe(original);
    expect('next_actions' in result).toBe(false);
  });
});
