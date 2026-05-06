import { describe, expect, it } from 'vitest';
import * as fs from 'fs';

import {
  EvidenceLocalizationStatusSchema,
  SemanticAssessmentStatusSchema,
} from '@autoresearch/shared';

import { parseProvenanceMatchingResponse } from '../../src/tools/research/provenanceMatchingSampling.js';
import { parseKeyEquationSamplingResponse } from '../../src/tools/research/latex/keyEquationSampling.js';

function readResearchContractTemplate(): string {
  const templateUrl = new URL(
    '../../../project-contracts/src/project_contracts/scaffold_templates/research_contract.md',
    import.meta.url,
  );
  return fs.readFileSync(templateUrl, 'utf-8');
}

describe('evidence surface extraction preflight', () => {
  it('keeps shared substrate statuses separate from provider-local match vocabularies', () => {
    expect(EvidenceLocalizationStatusSchema.safeParse('localized').success).toBe(true);
    expect(EvidenceLocalizationStatusSchema.safeParse('fallback_available').success).toBe(true);
    expect(EvidenceLocalizationStatusSchema.safeParse('abstained').success).toBe(true);
    expect(EvidenceLocalizationStatusSchema.safeParse('matched').success).toBe(false);

    expect(SemanticAssessmentStatusSchema.safeParse('applied').success).toBe(true);
    expect(SemanticAssessmentStatusSchema.safeParse('unavailable').success).toBe(true);
    expect(SemanticAssessmentStatusSchema.safeParse('selected').success).toBe(false);
  });

  it('keeps provider-local fail-closed statuses out of sampling payload schemas', () => {
    expect(parseProvenanceMatchingResponse({
      status: 'sampling_unavailable',
      selected_candidate_key: null,
      relationship: 'unknown',
      confidence: 0,
      reason_code: 'sampling_unavailable',
      reason: 'No sampling support.',
    })).toBeNull();

    expect(parseKeyEquationSamplingResponse({
      overall_status: 'unavailable',
      evaluations: [],
    })).toBeNull();
  });

  it('keeps the generic scaffold contract on gap statuses instead of provider-local result terms', () => {
    const template = readResearchContractTemplate();

    expect(template).toContain('mark the state `uncertain`, `abstained`, `unavailable`, or as a reading gap');
    expect(template).not.toContain('selected_candidate_key');
    expect(template).not.toContain('sampling_unavailable');
    expect(template).not.toContain('input_not_traceable');
  });
});
