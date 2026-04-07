import { describe, expect, it } from 'vitest';
import { resolveWorkflowRecipe } from '../src/index.js';

describe('literature workflow resolver', () => {
  it('resolves literature gap discover through provider-neutral search authority', () => {
    const plan = resolveWorkflowRecipe({
      recipe_id: 'literature_gap_analysis',
      phase: 'discover',
      inputs: { query: 'nonlinear sigma model' },
      available_tools: ['inspire_search'],
    });

    expect(plan.entry_tool).toBe('literature_workflows.resolve');
    expect(plan.resolved_steps).toHaveLength(1);
    expect(plan.resolved_steps[0]).toMatchObject({
      id: 'seed_search',
      action: 'discover.seed_search',
      provider: 'inspire',
      tool: 'inspire_search',
      params: { query: 'nonlinear sigma model', size: 25 },
    });
  });

  it('supports provider-neutral discovery preference when the capability exists', () => {
    const plan = resolveWorkflowRecipe({
      recipe_id: 'literature_landscape',
      phase: 'prework',
      inputs: { query: 'bootstrap amplitudes', topic: 'bootstrap amplitudes', seed_recid: '1234' },
      preferred_providers: ['openalex'],
      available_tools: ['openalex_search', 'inspire_topic_analysis', 'inspire_network_analysis', 'inspire_trace_original_source'],
    });

    expect(plan.resolved_steps[0]).toMatchObject({
      id: 'seed_search',
      provider: 'openalex',
      tool: 'openalex_search',
    });
  });

  it('resolves literature gap analyze through bounded inspire analysis operators', () => {
    const plan = resolveWorkflowRecipe({
      recipe_id: 'literature_gap_analysis',
      phase: 'analyze',
      inputs: { topic: 'nonlinear sigma model', recids: ['1001', '2001'], analysis_seed: '1001' },
      available_tools: [
        'inspire_topic_analysis',
        'inspire_critical_analysis',
        'inspire_network_analysis',
        'inspire_find_connections',
      ],
    });

    expect(plan.entry_tool).toBe('literature_workflows.resolve');
    expect(plan.resolved_steps).toHaveLength(4);
    expect(plan.resolved_steps).toMatchObject([
      {
        id: 'topic_scan',
        action: 'analyze.topic_evolution',
        provider: 'inspire',
        tool: 'inspire_topic_analysis',
        params: { mode: 'timeline', topic: 'nonlinear sigma model', limit: 20 },
      },
      {
        id: 'critical_analysis',
        action: 'analyze.paper_set_critical_review',
        provider: 'inspire',
        tool: 'inspire_critical_analysis',
        params: { recid: '1001' },
      },
      {
        id: 'citation_network',
        action: 'analyze.citation_network',
        provider: 'inspire',
        tool: 'inspire_network_analysis',
        params: { mode: 'citation', seed: '1001', limit: 25 },
      },
      {
        id: 'connection_scan',
        action: 'analyze.paper_connections',
        provider: 'inspire',
        tool: 'inspire_find_connections',
        params: { recids: ['1001', '2001'], include_external: true, max_external_depth: 1 },
      },
    ]);
  });

  it('fails closed when no allowed provider satisfies the workflow action', () => {
    expect(() => resolveWorkflowRecipe({
      recipe_id: 'literature_gap_analysis',
      phase: 'analyze',
      inputs: { topic: 'test', recids: ['1001'], analysis_seed: '1001' },
      allowed_providers: ['openalex'],
    })).toThrow(/No provider satisfies workflow action analyze\.topic_evolution/);
  });
});
