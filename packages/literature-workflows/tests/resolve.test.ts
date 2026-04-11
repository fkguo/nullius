import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkflowRecipe } from '../src/index.js';
import { getRecipeDir } from '../src/recipeLoader.js';

describe('literature workflow resolver', () => {
  it('keeps checked-in recipe authority package-local', () => {
    const recipeDir = getRecipeDir();

    expect(path.basename(recipeDir)).toBe('recipes');
    expect(recipeDir).toContain(`${path.sep}packages${path.sep}literature-workflows${path.sep}recipes`);
    expect(recipeDir).not.toContain(`${path.sep}meta${path.sep}recipes`);
  });

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
      task_kind: 'literature',
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
      task_kind: 'literature',
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
        task_kind: 'literature',
        action: 'analyze.topic_evolution',
        provider: 'inspire',
        tool: 'inspire_topic_analysis',
        params: { mode: 'timeline', topic: 'nonlinear sigma model', limit: 20 },
      },
      {
        id: 'critical_analysis',
        task_kind: 'literature',
        action: 'analyze.paper_set_critical_review',
        provider: 'inspire',
        tool: 'inspire_critical_analysis',
        params: { recid: '1001' },
      },
      {
        id: 'citation_network',
        task_kind: 'literature',
        action: 'analyze.citation_network',
        provider: 'inspire',
        tool: 'inspire_network_analysis',
        params: { mode: 'citation', seed: '1001', limit: 25 },
      },
      {
        id: 'connection_scan',
        task_kind: 'literature',
        action: 'analyze.paper_connections',
        provider: 'inspire',
        tool: 'inspire_find_connections',
        params: { recids: ['1001', '2001'], include_external: true, max_external_depth: 1 },
      },
    ]);
  });

  it('does not let provider preference overrule current analysis-capability maturity', () => {
    const plan = resolveWorkflowRecipe({
      recipe_id: 'literature_gap_analysis',
      phase: 'analyze',
      inputs: { topic: 'nonlinear sigma model', recids: ['1001', '2001'], analysis_seed: '1001' },
      preferred_providers: ['openalex', 'arxiv'],
      available_tools: [
        'inspire_topic_analysis',
        'inspire_critical_analysis',
        'inspire_network_analysis',
        'inspire_find_connections',
        'openalex_search',
        'arxiv_search',
      ],
    });

    expect(plan.resolved_steps.map(step => step.provider)).toEqual([
      'inspire',
      'inspire',
      'inspire',
      'inspire',
    ]);
  });

  it('keeps materialize.evidence_build on the current first-host adapter seam', () => {
    const plan = resolveWorkflowRecipe({
      recipe_id: 'literature_to_evidence',
      inputs: {
        query: 'bootstrap amplitudes',
        run_id: 'RUN-1',
        project_id: 'project-1',
        paper_id: 'paper-1',
      },
      available_tools: ['inspire_search', 'hep_project_build_evidence'],
    });

    expect(plan.resolved_steps).toMatchObject([
      {
        id: 'search_export',
        task_kind: 'literature',
        action: 'discover.seed_search',
        provider: 'inspire',
        tool: 'inspire_search',
      },
      {
        id: 'build_evidence',
        task_kind: 'literature',
        action: 'materialize.evidence_build',
        tool: 'hep_project_build_evidence',
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
