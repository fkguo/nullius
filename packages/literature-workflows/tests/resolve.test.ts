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
      params: { query: 'nonlinear sigma model', size: 50 },
    });
  });

  it('marks deep literature discovery as a continuation contract, not a fixed small result window', () => {
    const plan = resolveWorkflowRecipe({
      recipe_id: 'literature_gap_analysis',
      phase: 'discover',
      inputs: { query: 'nonlinear sigma model' },
      available_tools: ['inspire_search'],
    });

    const seedSearch = plan.resolved_steps[0];
    expect(seedSearch?.params).toMatchObject({
      query: 'nonlinear sigma model',
      size: 50,
    });
    expect(seedSearch?.consumer_hints?.search_depth_contract).toMatchObject({
      mode: 'deep',
      default_page_size: 50,
      default_page_size_semantics: 'page_size_not_completion_threshold',
      pagination_required: true,
      cursor_or_page_tracking_required: true,
      continuation_required: true,
      returned_count_required: true,
      stop_reason_required: true,
      coverage_incomplete_status: 'coverage_incomplete',
      candidate_pool_artifact: 'seed_search_candidates',
      selection_rationale_required: true,
      query_expansion_expected: true,
      citation_expansion_expected: true,
    });
    expect(seedSearch?.consumer_hints?.literature_saturation_contract).toMatchObject({
      artifact: 'knowledge_base/methodology_traces/literature_saturation.json',
      saturated_required_for_completion: true,
      coverage_incomplete_allowed_only_as_debt: true,
      provider_coverage_required: true,
      providers_expected: ['inspire', 'arxiv', 'openalex', 'web'],
      candidate_pool_required: true,
      core_paper_references_required: true,
      core_paper_citations_required: true,
      metadata_only_not_evidence_ready: true,
      page_size_not_completion_threshold: true,
    });
  });

  it('carries source-first reading handoff in resolved literature evidence plans', () => {
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

    expect(plan.resolved_steps[0]?.consumer_hints?.reading_handoff_contract).toMatchObject({
      mode: 'source_first',
      source_preference: [
        'arxiv_latex_source',
        'full_text_pdf',
        'available_full_text',
        'metadata_only_not_evidence_ready',
      ],
      note_upgrade_required: true,
      expected_artifact: 'source_first_reading_notes',
      locators_required: true,
      key_equations_required: true,
      limitations_required: true,
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
        task_kind: 'review',
        action: 'analyze.paper_set_critical_review',
        provider: 'inspire',
        tool: 'inspire_critical_analysis',
        params: { recid: '1001' },
      },
      {
        id: 'citation_network',
        task_kind: 'finding',
        action: 'analyze.citation_network',
        provider: 'inspire',
        tool: 'inspire_network_analysis',
        params: { mode: 'citation', seed: '1001', limit: 50 },
      },
      {
        id: 'connection_scan',
        task_kind: 'finding',
        action: 'analyze.paper_connections',
        provider: 'inspire',
        tool: 'inspire_find_connections',
        params: { recids: ['1001', '2001'], include_external: true, max_external_depth: 1 },
      },
    ]);
  });

  it('keeps connection_scan in the resolved analyze plan even when recids is empty', () => {
    const plan = resolveWorkflowRecipe({
      recipe_id: 'literature_gap_analysis',
      phase: 'analyze',
      inputs: { topic: 'nonlinear sigma model', recids: [], analysis_seed: '1001' },
      available_tools: [
        'inspire_topic_analysis',
        'inspire_critical_analysis',
        'inspire_network_analysis',
        'inspire_find_connections',
      ],
    });

    const connectionScan = plan.resolved_steps.find(step => step.id === 'connection_scan');
    expect(connectionScan).toMatchObject({
      id: 'connection_scan',
      tool: 'inspire_find_connections',
      params: {
        recids: [],
        include_external: true,
        max_external_depth: 1,
      },
      degrade_mode: 'fail_closed',
    });
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
    expect(plan.resolved_steps[1]).toMatchObject({
      id: 'critical_analysis',
      task_kind: 'review',
      provider: 'inspire',
      tool: 'inspire_critical_analysis',
    });
    expect(plan.resolved_steps[2]).toMatchObject({
      id: 'citation_network',
      task_kind: 'finding',
      provider: 'inspire',
      tool: 'inspire_network_analysis',
    });
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

  it('keeps review-cycle task kinds explicit in the recipe layer', () => {
    const plan = resolveWorkflowRecipe({
      recipe_id: 'review_cycle',
      inputs: { recid: '1234', run_id: 'RUN-1' },
    });

    expect(plan.resolved_steps).toMatchObject([
      {
        id: 'critical_review',
        task_kind: 'review',
        tool: 'inspire_critical_analysis',
      },
      {
        id: 'render_latex',
        task_kind: 'draft_update',
        tool: 'hep_render_latex',
      },
      {
        id: 'export_project',
        task_kind: 'draft_update',
        tool: 'hep_export_project',
      },
    ]);
  });

  it('keeps landscape provenance and network task kinds explicit in the recipe layer', () => {
    const plan = resolveWorkflowRecipe({
      recipe_id: 'literature_landscape',
      phase: 'prework',
      inputs: { query: 'bootstrap amplitudes', topic: 'bootstrap amplitudes', seed_recid: '1234' },
      preferred_providers: ['openalex'],
      available_tools: ['openalex_search', 'inspire_topic_analysis', 'inspire_network_analysis', 'inspire_trace_original_source'],
    });

    expect(plan.resolved_steps).toMatchObject([
      { id: 'seed_search', task_kind: 'literature' },
      { id: 'topic_scan', task_kind: 'literature' },
      { id: 'citation_network', task_kind: 'finding' },
      { id: 'source_trace', task_kind: 'evidence_search' },
    ]);
  });

  it('resolves research_brainstorm as a provider-neutral durable harness', () => {
    const plan = resolveWorkflowRecipe({
      recipe_id: 'research_brainstorm',
      inputs: { topic: 'cold atom response functions', run_id: 'RB-1' },
    });

    expect(plan).toMatchObject({
      recipe_id: 'research_brainstorm',
      name: 'Research Brainstorm Durable Harness',
      entry_tool: 'literature_workflows.resolve',
    });
    expect(plan.resolved_steps.map(step => step.id)).toEqual([
      'open_brainstorm_context',
      'capture_candidate_angles',
      'screen_and_rank_angles',
      'converge_single_recommendation',
      'emit_next_contract',
    ]);
    expect(plan.resolved_steps.map(step => step.task_kind)).toEqual([
      'finding',
      'finding',
      'review',
      'finding',
      'draft_update',
    ]);
    expect(plan.resolved_steps.map(step => step.provider)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(plan.resolved_steps.map(step => step.consumer_hints?.artifact)).toEqual([
      'brainstorm_context',
      'candidate_angles',
      'screening_matrix',
      'single_recommendation',
      'next_contract',
    ]);
    expect(plan.resolved_steps.map(step => step.depends_on)).toEqual([
      [],
      ['open_brainstorm_context'],
      ['capture_candidate_angles'],
      ['screen_and_rank_angles'],
      ['converge_single_recommendation'],
    ]);

    for (const step of plan.resolved_steps) {
      expect(step.action).toBeUndefined();
      expect(step.tool).toMatch(/^research_brainstorm\./);
      expect(step.required_capabilities).toEqual([]);
      expect(step.params.execution_contract).toMatchObject({
        mode: 'planning_only',
        built_in_runtime: false,
      });
    }

    expect(plan.resolved_steps[0]?.params).toMatchObject({
      topic: 'cold atom response functions',
      run_id: 'RB-1',
      artifact_contract: {
        artifact: 'brainstorm_context',
        out_of_scope: expect.arrayContaining([
          'idea-engine execution',
          'research-team execution',
          'broad retrieval',
          'front-door expansion',
        ]),
      },
    });
    expect(plan.resolved_steps[4]?.params).toMatchObject({
      topic: 'cold atom response functions',
      artifact_contract: {
        artifact: 'next_contract',
        suggested_next_recipe: [
          'literature_landscape',
          'literature_gap_analysis',
          'derivation_cycle',
          'review_cycle',
        ],
        recommended_lane: 'operator_approved_followup',
        lane_type: 'workflow_recipe_handoff',
        research_question: 'cold atom response functions',
        approval_required: true,
      },
    });
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
