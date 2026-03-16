import type { SearchOperatorOutput } from './search-operator.js';
import { sha256Hex } from './sha256-hex.js';

export interface LibrarianRecipeTemplate {
  provider: string;
  queryTemplate: string;
  recipeId: string;
  relevance: number;
  summaryTemplate: string;
}

export interface LibrarianRecipeBook {
  defaultTemplates: readonly LibrarianRecipeTemplate[];
  providerLandingUri: (provider: string, query: string) => string;
  templatesByFamily: Readonly<Record<string, readonly LibrarianRecipeTemplate[]>>;
}

function sanitizeForQuery(text: string): string {
  return [...text]
    .filter(char => char === '\n' || char === '\t' || (char >= ' ' && char !== '\x7f'))
    .join('')
    .replaceAll('"', '\\"')
    .trim();
}

function compactText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const compact = value.split(/\s+/).filter(Boolean).join(' ');
  return compact ? sanitizeForQuery(compact) : fallback;
}

function templatesForFamily(recipeBook: LibrarianRecipeBook, operatorFamily: string): readonly LibrarianRecipeTemplate[] {
  return recipeBook.templatesByFamily[operatorFamily] ?? recipeBook.defaultTemplates;
}

function renderRecipe(
  recipeBook: LibrarianRecipeBook,
  template: LibrarianRecipeTemplate,
  fields: Record<string, string>,
): Record<string, unknown> {
  const query = template.queryTemplate
    .replaceAll('{domain}', fields.domain)
    .replaceAll('{operator_family}', fields.operator_family)
    .replaceAll('{claim_text}', fields.claim_text)
    .replaceAll('{hypothesis}', fields.hypothesis)
    .replaceAll('{rationale_title}', fields.rationale_title);
  const summary = template.summaryTemplate
    .replaceAll('{domain}', fields.domain)
    .replaceAll('{operator_family}', fields.operator_family)
    .replaceAll('{claim_text}', fields.claim_text)
    .replaceAll('{hypothesis}', fields.hypothesis)
    .replaceAll('{rationale_title}', fields.rationale_title);
  const hit = {
    uri: recipeBook.providerLandingUri(template.provider, query),
    summary,
    summary_source: 'template',
    relevance: Number(template.relevance.toFixed(3)),
  };
  return {
    recipe_id: template.recipeId,
    provider: template.provider,
    query_template: template.queryTemplate,
    query,
    api_source: template.provider,
    api_query: query,
    raw_response_hash: `sha256:${sha256Hex(`${template.provider}|${query}|${summary}`)}`,
    hits: [hit],
  };
}

export function buildLibrarianEvidencePacket(options: {
  campaignId: string;
  domain: string;
  generatedAt: string;
  islandId: string;
  operatorOutput: SearchOperatorOutput;
  recipeBook: LibrarianRecipeBook;
  stepId: string;
  tick: number;
}): Record<string, unknown> {
  const fields = {
    claim_text: compactText(options.operatorOutput.claimText, 'candidate claim'),
    domain: compactText(options.domain, 'research-domain'),
    hypothesis: compactText(options.operatorOutput.hypothesis, 'testable hypothesis'),
    operator_family: compactText(options.operatorOutput.operatorFamily, 'UnknownFamily'),
    rationale_title: compactText(options.operatorOutput.rationaleTitle, 'untitled rationale'),
  };
  const recipes = templatesForFamily(options.recipeBook, options.operatorOutput.operatorFamily)
    .map(template => renderRecipe(options.recipeBook, template, fields));
  return {
    packet_type: 'librarian_evidence_packet_v1',
    packet_schema_version: 1,
    relevance_policy: 'template_prior_v1',
    packet_id: `librarian-${options.stepId}-tick-${String(options.tick).padStart(3, '0')}`,
    campaign_id: options.campaignId,
    step_id: options.stepId,
    tick: options.tick,
    island_id: options.islandId,
    operator_id: options.operatorOutput.operatorId,
    operator_family: options.operatorOutput.operatorFamily,
    generated_by_role: 'Librarian',
    recipes,
    evidence_items: recipes.map(recipe => {
      const hit = (recipe.hits as Array<Record<string, unknown>>)[0]!;
      return { provider: recipe.provider, recipe_id: recipe.recipe_id, uri: hit.uri, summary: hit.summary, relevance: hit.relevance };
    }),
    retrieval_timestamp: options.generatedAt,
    generated_at: options.generatedAt,
  };
}

export function claimEvidenceUris(options: {
  operatorEvidenceUris: string[];
  packetPayload: Record<string, unknown>;
  packetRef: string;
}): string[] {
  const uris = [options.packetRef];
  for (const item of (options.packetPayload.evidence_items as Array<Record<string, unknown>> | undefined) ?? []) {
    if (typeof item.uri === 'string' && item.uri) uris.push(item.uri);
  }
  uris.push(...options.operatorEvidenceUris);
  return [...new Set(uris)];
}
