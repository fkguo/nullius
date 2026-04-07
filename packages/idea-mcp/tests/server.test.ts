import { describe, expect, it } from 'vitest';
import { resolveIdeaBackend, resolveIdeaDataDir } from '../src/server.js';

describe('idea-mcp server backend selection', () => {
  it('does not let IDEA_CORE_PATH alone restore Python-first default authority', () => {
    expect(resolveIdeaBackend({ IDEA_CORE_PATH: '/tmp/idea-core' })).toBe('idea-engine');
  });

  it('requires an explicit backend switch for the legacy idea-core compatibility path', () => {
    expect(resolveIdeaBackend({ IDEA_MCP_BACKEND: 'idea-core-python' })).toBe('idea-core-python');
    expect(resolveIdeaDataDir({}, 'idea-engine')).toContain('/packages/idea-engine/runs');
    expect(resolveIdeaDataDir({}, 'idea-core-python')).toContain('/packages/idea-core/runs');
  });

  it('fails closed on unknown backend values', () => {
    expect(() => resolveIdeaBackend({ IDEA_MCP_BACKEND: 'legacy' })).toThrow(
      'Unsupported IDEA_MCP_BACKEND: legacy',
    );
  });
});
