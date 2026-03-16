import type { LibrarianRecipeBook, LibrarianRecipeTemplate } from './librarian-recipes.js';

const DEFAULT_TEMPLATES: readonly LibrarianRecipeTemplate[] = [
  { recipeId: 'inspire.generic.hep.v1', provider: 'INSPIRE', queryTemplate: 'primarch:{domain} AND fulltext:"{claim_text}"', summaryTemplate: 'INSPIRE generic HEP retrieval template for claim-level prior art.', relevance: 0.84 },
  { recipeId: 'pdg.generic.hep.v1', provider: 'PDG', queryTemplate: '"{claim_text}"', summaryTemplate: 'PDG generic HEP retrieval template for data/constraint baselines.', relevance: 0.8 },
];

const TEMPLATES_BY_FAMILY: Readonly<Record<string, readonly LibrarianRecipeTemplate[]>> = {
  AnomalyAbduction: [
    { recipeId: 'inspire.anomaly_abduction.v1', provider: 'INSPIRE', queryTemplate: 'primarch:{domain} AND fulltext:"{claim_text}" AND fulltext:"anomaly"', summaryTemplate: 'INSPIRE template for anomaly-abduction prior art and correlated-observable checks for {operator_family}.', relevance: 0.92 },
    { recipeId: 'pdg.anomaly_constraints.v1', provider: 'PDG', queryTemplate: '"{claim_text}" anomaly constraints', summaryTemplate: 'PDG template for anomaly constraints and baseline world averages tied to the current claim.', relevance: 0.88 },
  ],
  SymmetryOperator: [
    { recipeId: 'inspire.symmetry_selection_rules.v1', provider: 'INSPIRE', queryTemplate: 'primarch:{domain} AND fulltext:"{hypothesis}" AND fulltext:"symmetry selection rule"', summaryTemplate: 'INSPIRE template for symmetry-based selection rules and allowed/forbidden channels.', relevance: 0.9 },
    { recipeId: 'pdg.symmetry_baselines.v1', provider: 'PDG', queryTemplate: '"{hypothesis}" branching ratio baseline', summaryTemplate: 'PDG template for symmetry-sensitive observables and branching-ratio baselines.', relevance: 0.86 },
  ],
  LimitExplorer: [
    { recipeId: 'inspire.limit_regime.v1', provider: 'INSPIRE', queryTemplate: 'primarch:{domain} AND fulltext:"{hypothesis}" AND fulltext:"limit scaling"', summaryTemplate: 'INSPIRE template for controlled limits (decoupling/large-N/soft-collinear) and scaling checks.', relevance: 0.89 },
    { recipeId: 'pdg.limit_measurements.v1', provider: 'PDG', queryTemplate: '"{hypothesis}" limit measurement', summaryTemplate: 'PDG template for measurements constraining the proposed limit regime.', relevance: 0.85 },
  ],
};

function hepProviderLandingUri(provider: string, query: string): string {
  const encoded = encodeURIComponent(query).replaceAll('%20', '+');
  if (provider === 'INSPIRE') return `https://inspirehep.net/literature?sort=mostrecent&q=${encoded}`;
  if (provider === 'PDG') return `https://pdg.lbl.gov/search?query=${encoded}`;
  return `https://example.org/search?provider=${encodeURIComponent(provider)}&q=${encoded}`;
}

export function buildHepLibrarianRecipeBook(): LibrarianRecipeBook {
  return {
    defaultTemplates: DEFAULT_TEMPLATES,
    templatesByFamily: TEMPLATES_BY_FAMILY,
    providerLandingUri: hepProviderLandingUri,
  };
}
