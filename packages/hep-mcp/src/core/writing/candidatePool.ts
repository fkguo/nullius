import pLimit from 'p-limit';
import { z } from 'zod';
import {
  extractRecidFromUrl,
  normalizeArxivID,
  invalidParams,
  type Paper,
  type PaperSummary,
} from '@autoresearch/shared';

import * as api from '../../api/client.js';
import { getRun, type RunArtifactRef } from '../runs.js';
import { writeRunJsonArtifact } from '../citations.js';
import { cachedExternalApiJsonCall } from '../cache/externalApiCache.js';

import { CandidatePaperSchema, type CandidatePaper, type PaperId } from './papersetPlanner.js';

export const CandidatePoolArtifactV1Schema = z
  .object({
    version: z.literal(1),
    generated_at: z.string().min(1),
    run_id: z.string().min(1),
    project_id: z.string().min(1),
    seed_identifiers: z.array(z.string().min(1)),
    candidates: z.array(CandidatePaperSchema),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type CandidatePoolArtifactV1 = z.output<typeof CandidatePoolArtifactV1Schema>;

export const CandidatePoolExpandedArtifactV1Schema = z
  .object({
    version: z.literal(1),
    generated_at: z.string().min(1),
    run_id: z.string().min(1),
    project_id: z.string().min(1),
    seed_identifiers: z.array(z.string().min(1)),
    resolved_seed_recids: z.array(z.string().regex(/^\d+$/)),
    expansion: z
      .object({
        depth: z.number().int().positive(),
        include_references: z.boolean(),
        include_citations: z.boolean(),
        references_size: z.number().int().positive().optional(),
        citations_size: z.number().int().positive().optional(),
        concurrency: z.number().int().positive(),
        max_api_calls: z.number().int().positive(),
        max_candidates: z.number().int().positive(),
        min_candidates: z.number().int().nonnegative(),
        enrich_abstracts_top_k: z.number().int().nonnegative(),
      })
      .strict(),
    edges: z
      .array(
        z
          .object({
            source_paper_id: z.string().min(1),
            references: z.array(z.string().min(1)),
            citations: z.array(z.string().min(1)),
          })
          .strict()
      )
      .optional()
      .default([]),
    unresolved_identifiers: z
      .array(
        z
          .object({
            input: z.string().min(1),
            normalized: z.string().optional(),
            kind: z.enum(['recid', 'doi', 'arxiv', 'unknown']),
            reason: z.string().min(1),
          })
          .strict()
      )
      .optional()
      .default([]),
    stats: z
      .object({
        seeds_total: z.number().int().nonnegative(),
        seeds_resolved: z.number().int().nonnegative(),
        api_calls: z.number().int().nonnegative(),
        candidates_total: z.number().int().nonnegative(),
        references_total: z.number().int().nonnegative(),
        citations_total: z.number().int().nonnegative(),
        abstracts_enriched: z.number().int().nonnegative(),
    })
    .strict(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type CandidatePoolExpandedArtifactV1 = z.output<typeof CandidatePoolExpandedArtifactV1Schema>;

type ExternalApiCallIndexItemV1 = {
  version: 1;
  namespace: string;
  operation: string;
  request_hash: string;
  cache_hit: boolean;
  cached_response_uri: string;
  request_uri: string;
  response_uri: string;
};

type ExternalApiCallIndexArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  calls: ExternalApiCallIndexItemV1[];
  stats: { calls_total: number; cache_hits: number; cache_misses: number };
};

function nowIso(): string {
  return new Date().toISOString();
}

function stripUrlSuffix(input: string): string {
  return input.replace(/[?#].*$/, '');
}

function isLikelyArxivId(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  return (
    /^\d{4}\.\d{4,5}(v\d+)?$/i.test(trimmed) ||
    /^[a-z-]+\/\d{7}(v\d+)?$/i.test(trimmed)
  );
}

function normalizeSeedIdentifier(raw: string): { kind: 'recid' | 'doi' | 'arxiv' | 'unknown'; normalized: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'unknown', normalized: '' };

  const prefixedRecid = trimmed.match(/^inspire:(\d+)$/i);
  if (prefixedRecid?.[1]) return { kind: 'recid', normalized: prefixedRecid[1] };

  const recidFromUrl = extractRecidFromUrl(trimmed);
  if (recidFromUrl) return { kind: 'recid', normalized: recidFromUrl };
  if (/^\d+$/.test(trimmed)) return { kind: 'recid', normalized: trimmed };

  const doi = (() => {
    const m = trimmed.match(/^https?:\/\/doi\.org\/(10\..+)$/i);
    if (m?.[1]) return stripUrlSuffix(m[1].trim());
    const direct = trimmed.replace(/^doi:/i, '').trim();
    if (direct.startsWith('10.')) return stripUrlSuffix(direct);
    return undefined;
  })();
  if (doi) return { kind: 'doi', normalized: doi };

  const arxiv = (() => {
    const prefixed = trimmed.match(/^arxiv:(.+)$/i);
    const withoutPrefix = prefixed?.[1] ? prefixed[1].trim() : trimmed;
    const m = trimmed.match(/^https?:\/\/arxiv\.org\/abs\/(.+)$/i);
    const candidate = m?.[1] ? stripUrlSuffix(m[1].trim()) : withoutPrefix;
    const norm = normalizeArxivID(candidate);
    if (!norm) return undefined;
    const cleaned = stripUrlSuffix(norm.trim());
    return isLikelyArxivId(cleaned) ? cleaned : undefined;
  })();
  if (arxiv) return { kind: 'arxiv', normalized: arxiv };

  return { kind: 'unknown', normalized: trimmed };
}

function paperIdFromRecid(recid: string): PaperId {
  return `inspire:${recid}` as PaperId;
}

function paperIdFromArxivId(arxivId: string): PaperId {
  return `arxiv:${arxivId}` as PaperId;
}

function candidateFromInspirePaper(paper: Paper | PaperSummary): CandidatePaper | null {
  const recid = paper.recid?.trim();
  const arxivId = paper.arxiv_id?.trim();
  const doi = paper.doi?.trim();

  const paperId = recid ? paperIdFromRecid(recid) : arxivId ? paperIdFromArxivId(arxivId) : null;
  if (!paperId) return null;

  const arxivCats = Array.isArray(paper.arxiv_categories) ? paper.arxiv_categories : [];
  const derivedCats = arxivCats.length > 0 ? arxivCats : paper.arxiv_primary_category ? [paper.arxiv_primary_category] : [];

  return {
    paper_id: paperId,
    inspire_recid: recid && /^\d+$/.test(recid) ? recid : undefined,
    arxiv_id: arxivId || undefined,
    doi: doi || undefined,
    title: typeof paper.title === 'string' && paper.title.trim() ? paper.title.trim() : undefined,
    authors: Array.isArray(paper.authors) ? paper.authors.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim()) : [],
    year: typeof paper.year === 'number' ? paper.year : undefined,
    abstract: 'abstract' in paper && typeof paper.abstract === 'string' && paper.abstract.trim() ? paper.abstract.trim() : undefined,
    arxiv_categories: derivedCats.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim()),
    citation_count: typeof paper.citation_count === 'number' ? paper.citation_count : undefined,
    provenance: [],
  };
}

function mergeCandidate(existing: CandidatePaper, incoming: CandidatePaper): CandidatePaper {
  return {
    paper_id: existing.paper_id,
    inspire_recid: existing.inspire_recid ?? incoming.inspire_recid,
    arxiv_id: existing.arxiv_id ?? incoming.arxiv_id,
    doi: existing.doi ?? incoming.doi,
    title: existing.title ?? incoming.title,
    authors: Array.isArray(existing.authors) && existing.authors.length > 0 ? existing.authors : incoming.authors ?? [],
    year: existing.year ?? incoming.year,
    abstract: existing.abstract ?? incoming.abstract,
    arxiv_categories:
      Array.isArray(existing.arxiv_categories) && existing.arxiv_categories.length > 0
        ? existing.arxiv_categories
        : incoming.arxiv_categories ?? [],
    citation_count: existing.citation_count ?? incoming.citation_count,
    provenance: [...(existing.provenance ?? []), ...(incoming.provenance ?? [])],
  };
}

export async function buildRunWritingCandidatePoolFromInspireNetwork(params: {
  run_id: string;
  seed_identifiers: string[];
  depth?: number;
  include_references?: boolean;
  include_citations?: boolean;
  references_size?: number;
  citations_size?: number;
  concurrency?: number;
  max_api_calls?: number;
  max_candidates?: number;
  min_candidates?: number;
  enrich_abstracts_top_k?: number;
  candidate_pool_artifact_name?: string;
  expanded_artifact_name?: string;
}): Promise<{
  run_id: string;
  project_id: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
}> {
  const runId = params.run_id;
  const run = getRun(runId);

  const seedIdentifiers = params.seed_identifiers.map(s => s.trim()).filter(Boolean);
  if (seedIdentifiers.length === 0) {
    throw invalidParams('seed_identifiers cannot be empty', { run_id: runId });
  }

  const depth = params.depth ?? 1;
  if (!Number.isInteger(depth) || depth <= 0) {
    throw invalidParams('depth must be a positive integer', { run_id: runId, depth: params.depth });
  }

  const includeReferences = params.include_references ?? true;
  const includeCitations = params.include_citations ?? true;
  if (!includeReferences && !includeCitations) {
    throw invalidParams('At least one of include_references/include_citations must be true', { run_id: runId });
  }

  const referencesSize = params.references_size ?? 25;
  const citationsSize = params.citations_size ?? 25;
  const concurrency = params.concurrency ?? 4;
  const maxApiCalls = params.max_api_calls ?? 200;
  const maxCandidates = params.max_candidates ?? 300;
  const minCandidates = params.min_candidates ?? 20;
  const enrichAbstractsTopK = params.enrich_abstracts_top_k ?? 80;

  if (concurrency <= 0 || !Number.isInteger(concurrency)) {
    throw invalidParams('concurrency must be a positive integer', { run_id: runId, concurrency: params.concurrency });
  }
  if (maxApiCalls <= 0 || !Number.isInteger(maxApiCalls)) {
    throw invalidParams('max_api_calls must be a positive integer', { run_id: runId, max_api_calls: params.max_api_calls });
  }
  if (maxCandidates <= 0 || !Number.isInteger(maxCandidates)) {
    throw invalidParams('max_candidates must be a positive integer', { run_id: runId, max_candidates: params.max_candidates });
  }
  if (minCandidates < 0 || !Number.isInteger(minCandidates)) {
    throw invalidParams('min_candidates must be a non-negative integer', { run_id: runId, min_candidates: params.min_candidates });
  }
  if (enrichAbstractsTopK < 0 || !Number.isInteger(enrichAbstractsTopK)) {
    throw invalidParams('enrich_abstracts_top_k must be a non-negative integer', { run_id: runId, enrich_abstracts_top_k: params.enrich_abstracts_top_k });
  }

  const candidatePoolArtifactName = params.candidate_pool_artifact_name?.trim()
    ? params.candidate_pool_artifact_name.trim()
    : 'writing_candidate_pool_v1.json';
  const expandedArtifactName = params.expanded_artifact_name?.trim()
    ? params.expanded_artifact_name.trim()
    : 'writing_candidate_pool_expanded_v1.json';

  let apiCalls = 0;
  const unresolved: CandidatePoolExpandedArtifactV1['unresolved_identifiers'] = [];
  const externalApiCalls: ExternalApiCallIndexItemV1[] = [];

  const resolvedSeedRecids: string[] = [];
  const seedPapers: Paper[] = [];

  for (const input of seedIdentifiers) {
    const classified = normalizeSeedIdentifier(input);
    if (!classified.normalized || classified.kind === 'unknown') {
      unresolved.push({ input, normalized: classified.normalized, kind: classified.kind, reason: 'unsupported_identifier' });
      continue;
    }

    try {
      if (classified.kind === 'recid') {
        const cached = await cachedExternalApiJsonCall({
          run_id: runId,
          namespace: 'inspire',
          operation: 'getPaper',
          request: { recid: classified.normalized },
          fetch: async () => {
            if (apiCalls + 1 > maxApiCalls) {
              throw invalidParams('Candidate pool build exceeded max_api_calls during seed resolution', {
                run_id: runId,
                max_api_calls: maxApiCalls,
                api_calls: apiCalls,
              });
            }
            apiCalls += 1;
            return api.getPaper(classified.normalized);
          },
        });
        const [requestRef, responseRef] = cached.artifacts;
        externalApiCalls.push({
          version: 1,
          namespace: 'inspire',
          operation: 'getPaper',
          request_hash: cached.request_hash,
          cache_hit: cached.cache_hit,
          cached_response_uri: cached.cached_response_uri,
          request_uri: requestRef.uri,
          response_uri: responseRef.uri,
        });
        const paper = cached.response;
        if (!paper.recid) {
          unresolved.push({ input, normalized: classified.normalized, kind: classified.kind, reason: 'resolved_paper_missing_recid' });
          continue;
        }
        resolvedSeedRecids.push(paper.recid);
        seedPapers.push(paper);
      } else if (classified.kind === 'doi') {
        const cached = await cachedExternalApiJsonCall({
          run_id: runId,
          namespace: 'inspire',
          operation: 'getByDoi',
          request: { doi: classified.normalized },
          fetch: async () => {
            if (apiCalls + 1 > maxApiCalls) {
              throw invalidParams('Candidate pool build exceeded max_api_calls during DOI resolution', {
                run_id: runId,
                max_api_calls: maxApiCalls,
                api_calls: apiCalls,
              });
            }
            apiCalls += 1;
            return api.getByDoi(classified.normalized);
          },
        });
        const [requestRef, responseRef] = cached.artifacts;
        externalApiCalls.push({
          version: 1,
          namespace: 'inspire',
          operation: 'getByDoi',
          request_hash: cached.request_hash,
          cache_hit: cached.cache_hit,
          cached_response_uri: cached.cached_response_uri,
          request_uri: requestRef.uri,
          response_uri: responseRef.uri,
        });
        const paper = cached.response;
        if (!paper.recid) {
          unresolved.push({ input, normalized: classified.normalized, kind: classified.kind, reason: 'doi_not_found' });
          continue;
        }
        resolvedSeedRecids.push(paper.recid);
        seedPapers.push(paper);
      } else if (classified.kind === 'arxiv') {
        const cached = await cachedExternalApiJsonCall({
          run_id: runId,
          namespace: 'inspire',
          operation: 'getByArxiv',
          request: { arxiv_id: classified.normalized },
          fetch: async () => {
            if (apiCalls + 1 > maxApiCalls) {
              throw invalidParams('Candidate pool build exceeded max_api_calls during arXiv resolution', {
                run_id: runId,
                max_api_calls: maxApiCalls,
                api_calls: apiCalls,
              });
            }
            apiCalls += 1;
            return api.getByArxiv(classified.normalized);
          },
        });
        const [requestRef, responseRef] = cached.artifacts;
        externalApiCalls.push({
          version: 1,
          namespace: 'inspire',
          operation: 'getByArxiv',
          request_hash: cached.request_hash,
          cache_hit: cached.cache_hit,
          cached_response_uri: cached.cached_response_uri,
          request_uri: requestRef.uri,
          response_uri: responseRef.uri,
        });
        const paper = cached.response;
        if (!paper.recid) {
          unresolved.push({ input, normalized: classified.normalized, kind: classified.kind, reason: 'arxiv_not_found_in_inspire' });
          continue;
        }
        resolvedSeedRecids.push(paper.recid);
        seedPapers.push(paper);
      }
    } catch (err) {
      if ((err as any)?.code === 'INVALID_PARAMS') throw err;
      unresolved.push({
        input,
        normalized: classified.normalized,
        kind: classified.kind,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const uniqueSeedRecids = Array.from(new Set(resolvedSeedRecids));
  if (uniqueSeedRecids.length === 0) {
    throw invalidParams('No seed identifiers could be resolved to INSPIRE recids (INSPIRE-first; fail-fast)', {
      run_id: runId,
      seed_identifiers: seedIdentifiers,
      unresolved_identifiers: unresolved,
      next_actions: [
        'Provide at least one INSPIRE recid/DOI/arXiv ID that exists in INSPIRE-HEP.',
        'If the paper is arXiv-only (not in INSPIRE), wait for M12 arXiv provider integration.',
      ],
    });
  }

  const candidatesById = new Map<string, CandidatePaper>();
  const assertWithinMaxCandidates = (context: { current_level: number }): void => {
    if (candidatesById.size <= maxCandidates) return;
    throw invalidParams('Candidate pool exceeds max_candidates (fail-fast)', {
      run_id: runId,
      candidates: candidatesById.size,
      max_candidates: maxCandidates,
      depth,
      current_level: context.current_level,
      next_actions: ['Reduce references_size/citations_size or depth; or increase max_candidates.'],
    });
  };

  for (const paper of seedPapers) {
    if (!paper.recid) continue;
    const candidate = candidateFromInspirePaper(paper);
    if (!candidate) continue;
    candidate.provenance = [{ kind: 'seed', source_paper_id: paperIdFromRecid(paper.recid) }];
    const existing = candidatesById.get(candidate.paper_id);
    candidatesById.set(candidate.paper_id, existing ? mergeCandidate(existing, candidate) : candidate);
    assertWithinMaxCandidates({ current_level: 0 });
  }

  const edgeRecords: CandidatePoolExpandedArtifactV1['edges'] = [];
  let referencesTotal = 0;
  let citationsTotal = 0;

  const limit = pLimit(concurrency);
  const visited = new Set<string>();

  let frontier: string[] = uniqueSeedRecids;
  for (let level = 1; level <= depth; level++) {
    const nextFrontier: string[] = [];

    for (const recid of frontier) visited.add(recid);

    const tasks = frontier.map(recid =>
      limit(async () => {
        const sourceId = paperIdFromRecid(recid);
        const refs: PaperSummary[] = [];
        const cits: PaperSummary[] = [];

        if (includeReferences) {
          const cached = await cachedExternalApiJsonCall({
            run_id: runId,
            namespace: 'inspire',
            operation: 'getReferences',
            request: { recid, size: referencesSize },
            fetch: async () => {
              if (apiCalls + 1 > maxApiCalls) {
                throw invalidParams('Candidate pool build exceeded max_api_calls during references expansion (fail-fast)', {
                  run_id: runId,
                  max_api_calls: maxApiCalls,
                  api_calls: apiCalls,
                  recid,
                  references_size: referencesSize,
                });
              }
              apiCalls += 1;
              return api.getReferences(recid, referencesSize);
            },
          });
          const [requestRef, responseRef] = cached.artifacts;
          externalApiCalls.push({
            version: 1,
            namespace: 'inspire',
            operation: 'getReferences',
            request_hash: cached.request_hash,
            cache_hit: cached.cache_hit,
            cached_response_uri: cached.cached_response_uri,
            request_uri: requestRef.uri,
            response_uri: responseRef.uri,
          });
          refs.push(...(cached.response as PaperSummary[]));
        }
        if (includeCitations) {
          const cached = await cachedExternalApiJsonCall({
            run_id: runId,
            namespace: 'inspire',
            operation: 'getCitations',
            request: { recid, sort: 'mostcited', size: citationsSize },
            fetch: async () => {
              if (apiCalls + 1 > maxApiCalls) {
                throw invalidParams('Candidate pool build exceeded max_api_calls during citations expansion (fail-fast)', {
                  run_id: runId,
                  max_api_calls: maxApiCalls,
                  api_calls: apiCalls,
                  recid,
                  citations_size: citationsSize,
                });
              }
              apiCalls += 1;
              return api.getCitations(recid, { sort: 'mostcited', size: citationsSize });
            },
          });
          const [requestRef, responseRef] = cached.artifacts;
          externalApiCalls.push({
            version: 1,
            namespace: 'inspire',
            operation: 'getCitations',
            request_hash: cached.request_hash,
            cache_hit: cached.cache_hit,
            cached_response_uri: cached.cached_response_uri,
            request_uri: requestRef.uri,
            response_uri: responseRef.uri,
          });
          const result = cached.response as { papers?: unknown };
          cits.push(...(Array.isArray((result as any)?.papers) ? ((result as any).papers as PaperSummary[]) : []));
        }

        return { recid, sourceId, refs, cits };
      })
    );

    const results = await Promise.all(tasks);
    for (const r of results) {
      const references: string[] = [];
      const citations: string[] = [];

      for (const ref of r.refs) {
        referencesTotal += 1;
        const candidate = candidateFromInspirePaper(ref);
        if (!candidate) continue;
        candidate.provenance = [{ kind: 'reference', source_paper_id: r.sourceId }];
        const existing = candidatesById.get(candidate.paper_id);
        candidatesById.set(candidate.paper_id, existing ? mergeCandidate(existing, candidate) : candidate);
        assertWithinMaxCandidates({ current_level: level });
        references.push(candidate.paper_id);
        if (level < depth && ref.recid && !visited.has(ref.recid)) nextFrontier.push(ref.recid);
      }

      for (const cit of r.cits) {
        citationsTotal += 1;
        const candidate = candidateFromInspirePaper(cit);
        if (!candidate) continue;
        candidate.provenance = [{ kind: 'citation', source_paper_id: r.sourceId }];
        const existing = candidatesById.get(candidate.paper_id);
        candidatesById.set(candidate.paper_id, existing ? mergeCandidate(existing, candidate) : candidate);
        assertWithinMaxCandidates({ current_level: level });
        citations.push(candidate.paper_id);
        if (level < depth && cit.recid && !visited.has(cit.recid)) nextFrontier.push(cit.recid);
      }

      edgeRecords.push({ source_paper_id: r.sourceId, references, citations });
    }

    frontier = Array.from(new Set(nextFrontier));
  }

  if (edgeRecords.length === 0) {
    throw invalidParams('INSPIRE network expansion did not run (missing refs/citations expansion); cannot proceed', { run_id: runId });
  }

  const candidates = Array.from(candidatesById.values());
  if (candidates.length > maxCandidates) {
    throw invalidParams('Candidate pool exceeds max_candidates (fail-fast)', {
      run_id: runId,
      candidates: candidates.length,
      max_candidates: maxCandidates,
      next_actions: ['Reduce references_size/citations_size or depth; or increase max_candidates.'],
    });
  }
  if (candidates.length < minCandidates) {
    throw invalidParams('Candidate pool too small for reliable paperset curation (fail-fast)', {
      run_id: runId,
      candidates: candidates.length,
      min_candidates: minCandidates,
      next_actions: ['Add more seed papers or increase references_size/citations_size/depth.'],
    });
  }

  // Abstract enrichment (quality-first): fetch full paper metadata for top-K recids missing abstracts.
  const needAbstractRecids = candidates
    .filter(c => !c.abstract && c.inspire_recid)
    .sort((a, b) => (b.citation_count ?? 0) - (a.citation_count ?? 0) || a.paper_id.localeCompare(b.paper_id))
    .slice(0, enrichAbstractsTopK)
    .map(c => c.inspire_recid!)
    .filter(Boolean);

  if (needAbstractRecids.length > 0) {
    const enrichTasks = needAbstractRecids.map(recid =>
      limit(async () => {
        const cached = await cachedExternalApiJsonCall({
          run_id: runId,
          namespace: 'inspire',
          operation: 'getPaper',
          request: { recid },
          fetch: async () => {
            if (apiCalls + 1 > maxApiCalls) {
              throw invalidParams('Candidate pool build exceeded max_api_calls during abstract enrichment (fail-fast)', {
                run_id: runId,
                max_api_calls: maxApiCalls,
                api_calls: apiCalls,
                recid,
                next_actions: ['Increase max_api_calls or reduce enrich_abstracts_top_k.'],
              });
            }
            apiCalls += 1;
            return api.getPaper(recid);
          },
        });
        const [requestRef, responseRef] = cached.artifacts;
        externalApiCalls.push({
          version: 1,
          namespace: 'inspire',
          operation: 'getPaper',
          request_hash: cached.request_hash,
          cache_hit: cached.cache_hit,
          cached_response_uri: cached.cached_response_uri,
          request_uri: requestRef.uri,
          response_uri: responseRef.uri,
        });
        return cached.response;
      })
    );
    const enriched = await Promise.all(enrichTasks);

    for (const paper of enriched) {
      if (!paper.recid) continue;
      const candidate = candidateFromInspirePaper(paper);
      if (!candidate) continue;
      const existing = candidatesById.get(candidate.paper_id);
      if (!existing) continue;
      candidatesById.set(candidate.paper_id, mergeCandidate(existing, candidate));
    }
  }

  const finalCandidates = Array.from(candidatesById.values());

  const expandedPayload: CandidatePoolExpandedArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    seed_identifiers: seedIdentifiers,
    resolved_seed_recids: uniqueSeedRecids,
    expansion: {
      depth,
      include_references: includeReferences,
      include_citations: includeCitations,
      references_size: includeReferences ? referencesSize : undefined,
      citations_size: includeCitations ? citationsSize : undefined,
      concurrency,
      max_api_calls: maxApiCalls,
      max_candidates: maxCandidates,
      min_candidates: minCandidates,
      enrich_abstracts_top_k: enrichAbstractsTopK,
    },
    edges: edgeRecords,
    unresolved_identifiers: unresolved,
    stats: {
      seeds_total: seedIdentifiers.length,
      seeds_resolved: uniqueSeedRecids.length,
      api_calls: apiCalls,
      candidates_total: finalCandidates.length,
      references_total: referencesTotal,
      citations_total: citationsTotal,
      abstracts_enriched: needAbstractRecids.length,
    },
    meta: {
      note: 'INSPIRE-first candidate pool expansion (refs/citations). External API calls are cached via external_api_v1 (content-addressed) and written as per-call request/response artifacts.',
      external_api_calls_index: 'external_api_calls_inspire_candidate_pool_v1.json',
    },
  };

  const expandedRef = writeRunJsonArtifact(runId, expandedArtifactName, expandedPayload);
  const cacheIndexRef = writeRunJsonArtifact(runId, 'external_api_calls_inspire_candidate_pool_v1.json', {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    calls: externalApiCalls,
    stats: {
      calls_total: externalApiCalls.length,
      cache_hits: externalApiCalls.filter(c => c.cache_hit).length,
      cache_misses: externalApiCalls.filter(c => !c.cache_hit).length,
    },
  } satisfies ExternalApiCallIndexArtifactV1);

  const poolPayload: CandidatePoolArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    seed_identifiers: seedIdentifiers,
    candidates: finalCandidates,
    meta: {
      expanded_from_uri: expandedRef.uri,
      seeds_resolved: uniqueSeedRecids.length,
      api_calls: apiCalls,
    },
  };

  const poolRef = writeRunJsonArtifact(runId, candidatePoolArtifactName, poolPayload);

  // Sanity parse (SSOT): fail-fast if our artifact drifted.
  CandidatePoolArtifactV1Schema.parse(poolPayload);
  CandidatePoolExpandedArtifactV1Schema.parse(expandedPayload);

  return {
    run_id: runId,
    project_id: run.project_id,
    artifacts: [expandedRef, poolRef, cacheIndexRef],
    summary: {
      candidate_pool_uri: poolRef.uri,
      expanded_uri: expandedRef.uri,
      external_api_calls_uri: cacheIndexRef.uri,
      seeds_total: seedIdentifiers.length,
      seeds_resolved: uniqueSeedRecids.length,
      candidates_total: finalCandidates.length,
      api_calls: apiCalls,
      depth,
      include_references: includeReferences,
      include_citations: includeCitations,
    },
  };
}
