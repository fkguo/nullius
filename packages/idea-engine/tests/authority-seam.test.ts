import { describe, expect, it } from 'vitest';
import { builtinDomainPackById, loadBuiltinLibrarianRecipeBook, loadBuiltinSearchDomainPackRuntime } from '../src/service/domain-pack-registry.js';
import { buildLibrarianEvidencePacket, type LibrarianRecipeBook } from '../src/service/librarian-recipes.js';

function providerField(value: unknown): string {
  if (!value || typeof value !== 'object' || !('provider' in value) || typeof value.provider !== 'string') {
    throw new Error('expected provider field');
  }
  return value.provider;
}

function recipeProviders(packet: Record<string, unknown>): string[] {
  const recipes = packet.recipes;
  if (!Array.isArray(recipes)) {
    throw new Error('expected recipes array');
  }
  return recipes.map(providerField);
}

function evidenceProviders(packet: Record<string, unknown>): string[] {
  const evidenceItems = packet.evidence_items;
  if (!Array.isArray(evidenceItems)) {
    throw new Error('expected evidence_items array');
  }
  return evidenceItems.map(providerField);
}

describe('authority seam', () => {
  it('generic librarian packet builder accepts non-HEP providers through recipe books', () => {
    const recipeBook: LibrarianRecipeBook = {
      defaultTemplates: [
        {
          recipeId: 'openalex.generic.v1',
          provider: 'OpenAlex',
          queryTemplate: '{claim_text}',
          summaryTemplate: 'OpenAlex prior art for {claim_text}.',
          relevance: 0.75,
        },
      ],
      templatesByFamily: {},
      providerLandingUri: (provider, query) => `https://example.org/${provider}?q=${encodeURIComponent(query)}`,
    };

    const packet = buildLibrarianEvidencePacket({
      campaignId: '11111111-1111-4111-8111-111111111111',
      domain: 'math',
      generatedAt: '2026-03-16T00:00:00Z',
      islandId: 'island-0',
      operatorOutput: {
        backendId: 'custom.operator.backend',
        claimText: 'A generic provider should remain valid.',
        evidenceUrisUsed: [],
        hypothesis: 'Custom provider packets should validate.',
        operatorFamily: 'UnknownFamily',
        operatorId: 'custom.operator.v1',
        rationale: 'Generic seam test.',
        rationaleTitle: 'Custom provider packet',
        thesisStatement: 'The generic packet builder should not close provider authority.',
        traceInputs: {},
        traceParams: {},
      },
      recipeBook,
      stepId: '22222222-2222-4222-8222-222222222222',
      tick: 1,
    });

    expect(recipeProviders(packet)).toEqual(['OpenAlex']);
    expect(evidenceProviders(packet)).toEqual(['OpenAlex']);
  });

  it('loads the current hep slice through the built-in registry seam', () => {
    const descriptor = builtinDomainPackById('hep.operators.v1');
    const runtime = loadBuiltinSearchDomainPackRuntime('hep.operators.v1');
    const recipeBook = loadBuiltinLibrarianRecipeBook('hep.operators.v1');

    expect(descriptor?.operator_selection_policy).toBe('island_index_v1');
    expect(runtime.operatorSelectionPolicy).toBe(descriptor?.operator_selection_policy);
    expect(runtime.searchOperators).toHaveLength(3);
    expect(recipeBook.templatesByFamily.AnomalyAbduction?.map(template => template.provider)).toEqual([
      'INSPIRE',
      'PDG',
    ]);
  });
});
