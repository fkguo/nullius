import { CanonicalCandidateSchema, type CanonicalCandidate } from './canonical-candidate.js';
import { DiscoveryCanonicalPapersArtifactSchema, CanonicalPaperSchema, type CanonicalPaper } from './canonical-paper.js';
import { DiscoveryDedupArtifactSchema, type DiscoveryDedupArtifact } from './dedup-artifact.js';
import { normalizeDiscoveryName, normalizeDiscoveryTitle } from './normalization.js';

type CanonicalizeInput = { query: string; candidates: CanonicalCandidate[] };
type CanonicalizeOutput = { papers: CanonicalPaper[]; dedup: DiscoveryDedupArtifact };

const IDENTIFIER_KEYS = ['doi', 'arxiv_id', 'recid', 'openalex_id'] as const;
const PROVIDER_PRIORITY = ['inspire', 'openalex', 'arxiv'] as const;

function normalizeId(key: (typeof IDENTIFIER_KEYS)[number], value: string): string {
  return key === 'recid' ? value.trim() : value.trim().toLowerCase();
}

function candidateKey(candidate: CanonicalCandidate): string {
  for (const key of IDENTIFIER_KEYS) {
    const value = candidate.identifiers[key];
    if (value) return `${candidate.provider}:${key}:${normalizeId(key, value)}`;
  }
  return `${candidate.provider}:title:${normalizeDiscoveryTitle(candidate.title)}:${candidate.year ?? 'na'}`;
}

function groupReasons(candidates: CanonicalCandidate[]): string[] {
  const reasons = new Set<string>();
  for (const key of IDENTIFIER_KEYS) {
    const values = candidates
      .map(candidate => candidate.identifiers[key])
      .filter((value): value is string => !!value)
      .map(value => normalizeId(key, value));
    if (values.length > 1 && new Set(values).size < values.length) reasons.add(`exact_${key}`);
  }
  return [...reasons].sort();
}

function sharedAuthors(left: CanonicalCandidate, right: CanonicalCandidate): boolean {
  const names = new Set(left.authors.map(normalizeDiscoveryName));
  return right.authors.map(normalizeDiscoveryName).some(name => names.has(name));
}

function uncertainMatch(left: CanonicalCandidate, right: CanonicalCandidate): boolean {
  const titleMatch = normalizeDiscoveryTitle(left.title) === normalizeDiscoveryTitle(right.title);
  const yearMatch = left.year === undefined || right.year === undefined || left.year === right.year;
  return titleMatch && yearMatch && sharedAuthors(left, right);
}

function mergeIdentifiers(candidates: CanonicalCandidate[]): CanonicalCandidate['identifiers'] {
  return candidates.reduce<CanonicalCandidate['identifiers']>((merged, candidate) => ({
    recid: merged.recid ?? candidate.identifiers.recid,
    arxiv_id: merged.arxiv_id ?? candidate.identifiers.arxiv_id,
    doi: merged.doi ?? candidate.identifiers.doi,
    openalex_id: merged.openalex_id ?? candidate.identifiers.openalex_id,
    zotero_key: merged.zotero_key ?? candidate.identifiers.zotero_key,
    texkey: merged.texkey ?? candidate.identifiers.texkey,
  }), {});
}

function choosePrimaryCandidate(candidates: CanonicalCandidate[]): CanonicalCandidate {
  return [...candidates].sort((left, right) => {
    const idDelta = Object.values(right.identifiers).filter(Boolean).length - Object.values(left.identifiers).filter(Boolean).length;
    if (idDelta !== 0) return idDelta;
    const citationDelta = (right.citation_count ?? -1) - (left.citation_count ?? -1);
    if (citationDelta !== 0) return citationDelta;
    return PROVIDER_PRIORITY.indexOf(left.provider) - PROVIDER_PRIORITY.indexOf(right.provider);
  })[0]!;
}

function makeCanonicalKey(candidates: CanonicalCandidate[]): string {
  const merged = mergeIdentifiers(candidates);
  if (merged.doi) return `paper:doi:${merged.doi.toLowerCase()}`;
  if (merged.arxiv_id) return `paper:arxiv:${merged.arxiv_id.toLowerCase()}`;
  if (merged.recid) return `paper:recid:${merged.recid}`;
  if (merged.openalex_id) return `paper:openalex:${merged.openalex_id.toLowerCase()}`;
  const primary = choosePrimaryCandidate(candidates);
  return `paper:title:${normalizeDiscoveryTitle(primary.title).replace(/ /g, '-')}:${primary.year ?? 'na'}`;
}

function toCanonicalPaper(
  candidates: CanonicalCandidate[],
  merge_state: CanonicalPaper['merge_state'],
  match_reasons: string[],
  uncertain_group_key?: string,
): CanonicalPaper {
  const primary = choosePrimaryCandidate(candidates);
  return CanonicalPaperSchema.parse({
    canonical_key: makeCanonicalKey(candidates),
    identifiers: mergeIdentifiers(candidates),
    title: primary.title,
    authors: primary.authors,
    year: primary.year,
    citation_count: candidates.reduce<number | undefined>((max, candidate) => {
      if (candidate.citation_count === undefined) return max;
      return max === undefined ? candidate.citation_count : Math.max(max, candidate.citation_count);
    }, undefined),
    provider_sources: [...new Set(candidates.map(candidate => candidate.provider))].sort(),
    merge_state,
    merge_confidence: merge_state === 'confident_match' ? 'high' : merge_state === 'uncertain_match' ? 'low' : 'medium',
    match_reasons,
    uncertain_group_key,
    source_candidates: [...candidates].sort((left, right) => left.provider.localeCompare(right.provider)),
  });
}

function exactGroups(candidates: CanonicalCandidate[]): CanonicalCandidate[][] {
  const adjacency = new Map<number, Set<number>>();
  const buckets = new Map<string, number[]>();
  for (const [index, candidate] of candidates.entries()) {
    adjacency.set(index, new Set());
    for (const key of IDENTIFIER_KEYS) {
      const value = candidate.identifiers[key];
      if (!value) continue;
      const bucketKey = `${key}:${normalizeId(key, value)}`;
      const bucket = buckets.get(bucketKey) ?? [];
      bucket.push(index);
      buckets.set(bucketKey, bucket);
    }
  }
  for (const indices of buckets.values()) {
    if (indices.length < 2) continue;
    for (const index of indices) {
      const neighbors = adjacency.get(index)!;
      for (const other of indices) {
        if (other !== index) neighbors.add(other);
      }
    }
  }
  const visited = new Set<number>();
  const groups: CanonicalCandidate[][] = [];
  for (const [index] of candidates.entries()) {
    if (visited.has(index) || (adjacency.get(index)?.size ?? 0) === 0) continue;
    const stack = [index];
    const group: CanonicalCandidate[] = [];
    visited.add(index);
    while (stack.length > 0) {
      const current = stack.pop()!;
      group.push(candidates[current]!);
      for (const next of adjacency.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    if (groupReasons(group).length > 0) groups.push(group);
  }
  return groups;
}

export function canonicalizeDiscoveryCandidates(input: CanonicalizeInput): CanonicalizeOutput {
  const candidates = input.candidates.map(candidate => CanonicalCandidateSchema.parse(candidate));
  const confidentGroups = exactGroups(candidates);
  const confidentKeys = new Set(confidentGroups.flat().map(candidateKey));
  const leftovers = candidates.filter(candidate => !confidentKeys.has(candidateKey(candidate)));
  const uncertainGroups: CanonicalCandidate[][] = [];
  const uncertainKeys = new Set<string>();

  for (let index = 0; index < leftovers.length; index += 1) {
    const seed = leftovers[index]!;
    if (uncertainKeys.has(candidateKey(seed))) continue;
    const group = leftovers.filter(candidate => !uncertainKeys.has(candidateKey(candidate)) && uncertainMatch(seed, candidate));
    if (group.length > 1) {
      uncertainGroups.push(group);
      group.forEach(candidate => uncertainKeys.add(candidateKey(candidate)));
    }
  }

  const confidentPapers = confidentGroups.map(group => toCanonicalPaper(group, 'confident_match', groupReasons(group)));
  const uncertainPapers = uncertainGroups.flatMap((group, index) =>
    group.map(candidate => toCanonicalPaper([candidate], 'uncertain_match', ['normalized_title_match', 'author_overlap', 'year_match'], `uncertain:${index + 1}`)),
  );
  const singlePapers = leftovers
    .filter(candidate => !uncertainKeys.has(candidateKey(candidate)))
    .map(candidate => toCanonicalPaper([candidate], 'single_source', ['single_provider_result']));

  const dedup = DiscoveryDedupArtifactSchema.parse({
    version: 1,
    query: input.query,
    confident_merges: confidentGroups.map(group => ({
      canonical_key: makeCanonicalKey(group),
      provider_sources: [...new Set(group.map(candidate => candidate.provider))].sort(),
      merged_candidate_count: group.length,
      match_reasons: groupReasons(group),
      source_candidates: [...group].sort((left, right) => left.provider.localeCompare(right.provider)),
    })),
    uncertain_groups: uncertainGroups.map((group, index) => ({
      group_key: `uncertain:${index + 1}`,
      match_reasons: ['normalized_title_match', 'author_overlap', 'year_match'],
      source_candidates: [...group].sort((left, right) => left.provider.localeCompare(right.provider)),
    })),
    non_merges: [],
  });

  const papers = [...confidentPapers, ...uncertainPapers, ...singlePapers];
  DiscoveryCanonicalPapersArtifactSchema.parse({ version: 1, query: input.query, papers });
  return { papers, dedup };
}
