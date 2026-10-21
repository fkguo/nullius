import { describe, expect, it } from 'vitest';
import { resolveWorkflowAcceptanceChecks, resolveWorkflowRecipe } from '../src/index.js';

function plan(phase = 'discover'): Record<string, unknown> {
  const resolved = resolveWorkflowRecipe({ recipe_id: 'literature_gap_analysis', phase,
    inputs: { query: 'generic query', topic: 'generic topic', analysis_seed: 1, recids: [1] } });
  return { workflow_id: resolved.recipe_id, steps: resolved.resolved_steps.map(s => ({
    step_id: s.id, execution: { consumer_hints: s.consumer_hints },
  })) };
}

describe('literature workflow acceptance policy', () => {
  it.each(['discover', 'analyze'])('binds one workflow-level check for the complete %s selection', phase => {
    const checks = resolveWorkflowAcceptanceChecks('literature_gap_analysis', plan(phase));
    expect(checks).toHaveLength(1);
    expect(checks[0].request).toMatchObject({ workflow_binding_required: true, source_first_reading_required: true,
      providers_expected: ['inspire', 'arxiv', 'openalex', 'web'] });
    expect(checks[0].checker_sources).toContain('skills/citation-triangulation/scripts/bin/triangulate_citation.py');
    expect(checks[0].checker_sources).toContain('skills/research-team/scripts/lib/literature_artifact_refs.py');
  });
  it('refuses stripped known recipe contracts and missing plans', () => {
    const current = plan();
    const step = (current.steps as { execution: { consumer_hints: Record<string, unknown> } }[])[0];
    delete step.execution.consumer_hints.literature_saturation_contract;
    expect(() => resolveWorkflowAcceptanceChecks('literature_gap_analysis', current)).toThrow();
    expect(() => resolveWorkflowAcceptanceChecks('literature_gap_analysis', null)).toThrow();
  });
  it('refuses omission of protected steps, unknown steps and duplicated steps', () => {
    const current = plan('analyze');
    const steps = current.steps as { step_id: string }[];
    expect(() => resolveWorkflowAcceptanceChecks('literature_gap_analysis', { ...current,
      steps: steps.filter(s => s.step_id !== 'citation_network') })).toThrow();
    expect(() => resolveWorkflowAcceptanceChecks('literature_gap_analysis', { ...current,
      steps: [...steps, { step_id: 'unknown', execution: {} }] })).toThrow();
    expect(() => resolveWorkflowAcceptanceChecks('literature_gap_analysis', { ...current,
      steps: [...steps, steps[0]] })).toThrow();
  });
  it('refuses malformed custom literature requirements but preserves unrelated workflows', () => {
    expect(resolveWorkflowAcceptanceChecks('custom', { steps: [{ step_id: 'one', execution: {} }] })).toEqual([]);
    expect(resolveWorkflowAcceptanceChecks('custom', null)).toEqual([]);
    expect(() => resolveWorkflowAcceptanceChecks('custom', { steps: [{ step_id: 'one', execution: {
      consumer_hints: { reading_handoff_contract: null },
    } }] })).toThrow();
  });
  it('refuses duplicate providers disguised as the required four entries', () => {
    const current = plan();
    const hints = ((current.steps as any[])[0].execution.consumer_hints);
    hints.literature_saturation_contract.providers_expected = ['inspire', 'inspire', 'arxiv', 'openalex'];
    expect(() => resolveWorkflowAcceptanceChecks('literature_gap_analysis', current)).toThrow();
  });
});
