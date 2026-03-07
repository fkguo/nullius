import { describe, expect, it } from 'vitest';

import { buildSamplingMetadata, parseSamplingMetadata } from '../sampling-metadata.js';

describe('sampling metadata contract', () => {
  it('parses the stable routing metadata shape', () => {
    expect(parseSamplingMetadata({
      module: 'sem02_claim_extraction',
      tool: 'inspire_critical_research',
      prompt_version: 'sem02_claim_extraction_v1',
      risk_level: 'read',
      cost_class: 'low',
      context: { claim_count: 2, mode: 'evidence' },
    })).toMatchObject({
      module: 'sem02_claim_extraction',
      tool: 'inspire_critical_research',
      prompt_version: 'sem02_claim_extraction_v1',
      risk_level: 'read',
      cost_class: 'low',
    });
  });

  it.each(['backend', 'model', 'route', 'route_key'])('rejects forbidden context key %s', (key) => {
    expect(() => buildSamplingMetadata({
      module: 'sem04_theoretical_conflicts',
      tool: 'inspire_critical_research',
      prompt_version: 'v2',
      risk_level: 'read',
      cost_class: 'high',
      context: { [key]: 'forbidden' },
    })).toThrow(/routing hints/i);
  });

  it('rejects unknown root-level fields in strict mode', () => {
    expect(() => parseSamplingMetadata({
      module: 'sem02_claim_extraction',
      tool: 'inspire_critical_research',
      prompt_version: 'sem02_claim_extraction_v1',
      risk_level: 'read',
      cost_class: 'low',
      route: 'balanced',
    })).toThrow();
  });
});
