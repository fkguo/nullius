import * as fs from 'fs';
import type { BibEntry } from '../tools/research/latex/bibliographyExtractor.js';
import type { CitekeyMapping } from '../tools/research/latex/citekeyMapper.js';
import { getRunArtifactPath } from './paths.js';
import type { RunArtifactRef } from './runs.js';

export interface BibliographyRawArtifact {
  version: 1;
  generated_at: string;
  source: {
    identifier: string;
    arxiv_id?: string;
    source_file?: string;
  };
  entries: BibEntry[];
}

export interface CitekeyToInspireArtifact {
  version: 1;
  generated_at: string;
  mappings: Record<string, CitekeyMapping>;
  stats: {
    total: number;
    matched: number;
    not_found: number;
    errors: number;
    by_method: Record<string, number>;
  };
}

export interface AllowedCitationsArtifact {
  version: 1;
  generated_at: string;
  include_mapped_references: boolean;
  allowed_citations_primary: string[];
  allowed_citations_secondary: string[];
  manual_add: string[];
  manual_remove: string[];
  allowed_citations: string[];
}

function normalizeAllowedCitationToken(token: string): string | null {
  const t = token.trim();
  if (!t) return null;
  const m = t.match(/^(?:inspire:)?(\d+)$/);
  if (m) return `inspire:${m[1]}`;
  return t;
}

export function buildAllowedCitationsArtifact(params: {
  include_mapped_references: boolean;
  allowed_citations_primary: string[];
  allowed_citations_secondary: string[];
  manual_add?: string[];
  manual_remove?: string[];
}): AllowedCitationsArtifact {
  const manualAdd = params.manual_add ?? [];
  const manualRemove = params.manual_remove ?? [];

  const primary = params.allowed_citations_primary
    .map(normalizeAllowedCitationToken)
    .filter((v): v is string => Boolean(v));
  const secondary = params.allowed_citations_secondary
    .map(normalizeAllowedCitationToken)
    .filter((v): v is string => Boolean(v));

  const manualAddNorm = manualAdd
    .map(normalizeAllowedCitationToken)
    .filter((v): v is string => Boolean(v));
  const manualRemoveNorm = new Set(
    manualRemove
      .map(normalizeAllowedCitationToken)
      .filter((v): v is string => Boolean(v))
  );

  const allowedSet = new Set<string>();
  for (const c of primary) allowedSet.add(c);
  if (params.include_mapped_references) {
    for (const c of secondary) allowedSet.add(c);
  }
  for (const c of manualAddNorm) allowedSet.add(c);
  for (const c of manualRemoveNorm) allowedSet.delete(c);

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    include_mapped_references: params.include_mapped_references,
    allowed_citations_primary: Array.from(new Set(primary)),
    allowed_citations_secondary: Array.from(new Set(secondary)),
    manual_add: Array.from(new Set(manualAddNorm)),
    manual_remove: Array.from(manualRemoveNorm),
    allowed_citations: Array.from(allowedSet).sort(),
  };
}

export function buildCitekeyToInspireStats(mappings: Record<string, CitekeyMapping>): CitekeyToInspireArtifact['stats'] {
  const stats: CitekeyToInspireArtifact['stats'] = {
    total: 0,
    matched: 0,
    not_found: 0,
    errors: 0,
    by_method: {},
  };

  for (const mapping of Object.values(mappings)) {
    stats.total += 1;
    if (mapping.status === 'matched') stats.matched += 1;
    else if (mapping.status === 'not_found') stats.not_found += 1;
    else stats.errors += 1;

    if (mapping.match_method) {
      stats.by_method[mapping.match_method] = (stats.by_method[mapping.match_method] || 0) + 1;
    }
  }

  return stats;
}

export function writeRunJsonArtifact(runId: string, artifactName: string, data: unknown): RunArtifactRef {
  const artifactPath = getRunArtifactPath(runId, artifactName);
  fs.writeFileSync(artifactPath, JSON.stringify(data, null, 2), 'utf-8');
  return {
    name: artifactName,
    uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactName)}`,
    mimeType: 'application/json',
  };
}

