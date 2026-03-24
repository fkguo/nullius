import { describe, expect, it } from 'vitest';

import { getToolSpecs, getTools } from '../../src/tools/index.js';
import { zodToMcpInputSchema } from '../../src/tools/mcpSchema.js';

function getStandardSpec(name: string) {
  const spec = getToolSpecs('standard').find(tool => tool.name === name);
  expect(spec, `missing standard tool spec: ${name}`).toBeDefined();
  return spec!;
}

function getStandardSchemaProperties(name: string): string[] {
  const tool = getTools('standard').find(spec => spec.name === name);
  expect(tool, `missing standard tool definition: ${name}`).toBeDefined();
  return Object.keys(((tool?.inputSchema as Record<string, unknown>)?.properties ?? {}) as Record<string, unknown>).sort();
}

describe('INSPIRE research public surface (M-25)', () => {
  it('standard exposure retains only bounded atomic literature operators', () => {
    const standardNames = new Set(getToolSpecs('standard').map(spec => spec.name));

    expect(standardNames.has('inspire_grade_evidence')).toBe(true);
    expect(standardNames.has('inspire_detect_measurement_conflicts')).toBe(true);
    expect(standardNames.has('inspire_critical_analysis')).toBe(true);
    expect(standardNames.has('inspire_classify_reviews')).toBe(true);
    expect(standardNames.has('inspire_theoretical_conflicts')).toBe(true);
    expect(standardNames.has('inspire_topic_analysis')).toBe(true);
    expect(standardNames.has('inspire_network_analysis')).toBe(true);
    expect(standardNames.has('inspire_find_connections')).toBe(true);
    expect(standardNames.has('inspire_trace_original_source')).toBe(true);
    expect(standardNames.has('inspire_critical_research')).toBe(false);

    expect(standardNames.has('inspire_discover_papers')).toBe(false);
    expect(standardNames.has('inspire_field_survey')).toBe(false);
    expect(standardNames.has('inspire_deep_research')).toBe(false);
    expect(standardNames.has('inspire_research_navigator')).toBe(false);
  });

  it('retained public MCP schemas expose only dedicated top-level params', () => {
    expect(getStandardSchemaProperties('inspire_grade_evidence')).toEqual(['max_search_results', 'recid', 'search_confirmations']);
    expect(getStandardSchemaProperties('inspire_detect_measurement_conflicts')).toEqual([
      'include_tables',
      'min_tension_sigma',
      'recids',
      'target_quantities',
    ]);
    expect(getStandardSchemaProperties('inspire_critical_analysis')).toEqual([
      'assumption_max_depth',
      'check_literature',
      'include_assumptions',
      'include_evidence',
      'include_questions',
      'max_search_results',
      'recid',
      'search_confirmations',
    ]);
    expect(getStandardSchemaProperties('inspire_classify_reviews')).toEqual(['current_threshold_years', 'recids']);
    expect(getStandardSchemaProperties('inspire_theoretical_conflicts')).toEqual([
      'inputs',
      'max_candidates_total',
      'max_claim_candidates_per_paper',
      'max_llm_requests',
      'max_papers',
      'prompt_version',
      'recids',
      'run_id',
      'stable_sort',
      'subject_entity',
    ]);
    expect(getStandardSchemaProperties('inspire_topic_analysis')).toEqual(['limit', 'mode', 'options', 'time_range', 'topic']);
    expect(getStandardSchemaProperties('inspire_network_analysis')).toEqual(['limit', 'mode', 'options', 'seed']);
    expect(getStandardSchemaProperties('inspire_find_connections')).toEqual(['include_external', 'max_external_depth', 'recids']);
    expect(getStandardSchemaProperties('inspire_trace_original_source')).toEqual([
      'cross_validate',
      'max_depth',
      'max_refs_per_level',
      'recid',
    ]);
  });

  it('retained schemas fail closed on removed facade-era top-level params', () => {
    expect(getStandardSpec('inspire_grade_evidence').zodSchema.safeParse({
      mode: 'evidence',
      recid: '1',
    }).success).toBe(false);

    expect(getStandardSpec('inspire_detect_measurement_conflicts').zodSchema.safeParse({
      mode: 'conflicts',
      recids: ['1', '2'],
    }).success).toBe(false);

    expect(getStandardSpec('inspire_critical_analysis').zodSchema.safeParse({
      recid: '1',
      recids: ['1'],
    }).success).toBe(false);

    expect(getStandardSpec('inspire_classify_reviews').zodSchema.safeParse({
      mode: 'reviews',
      recids: ['1', '2'],
    }).success).toBe(false);

    expect(getStandardSpec('inspire_theoretical_conflicts').zodSchema.safeParse({
      run_id: 'run1',
      recids: ['1', '2'],
      llm_mode: 'internal',
    }).success).toBe(false);

    expect(getStandardSpec('inspire_topic_analysis').zodSchema.safeParse({
      mode: 'timeline',
      topic: 'qcd',
      topic_mode: 'timeline',
    }).success).toBe(false);

    expect(getStandardSpec('inspire_network_analysis').zodSchema.safeParse({
      mode: 'citation',
      seed: '123',
      network_mode: 'citation',
    }).success).toBe(false);

    expect(getStandardSpec('inspire_find_connections').zodSchema.safeParse({
      recids: ['1', '2'],
      seed_recids: ['1', '2'],
    }).success).toBe(false);

    expect(getStandardSpec('inspire_trace_original_source').zodSchema.safeParse({
      recid: '1',
      seed: '1',
    }).success).toBe(false);
  });

  it('retained schemas still satisfy gateway-compatible top-level object constraints', () => {
    for (const name of [
      'inspire_grade_evidence',
      'inspire_detect_measurement_conflicts',
      'inspire_critical_analysis',
      'inspire_classify_reviews',
      'inspire_theoretical_conflicts',
      'inspire_topic_analysis',
      'inspire_network_analysis',
      'inspire_find_connections',
      'inspire_trace_original_source',
    ]) {
      const schema = zodToMcpInputSchema(getStandardSpec(name).zodSchema);
      expect(schema.type).toBe('object');
      expect('oneOf' in schema).toBe(false);
      expect('anyOf' in schema).toBe(false);
      expect('allOf' in schema).toBe(false);
      expect((schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });
});
