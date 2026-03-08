import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CanonicalCandidate, DiscoveryQueryIntent } from '@autoresearch/shared';

import { runFederatedDiscovery, type DiscoveryProviderExecutors } from '../../src/tools/research/federatedDiscovery.js';

function buildExecutors(cases: Record<string, Partial<Record<'inspire' | 'openalex' | 'arxiv', CanonicalCandidate[]>>>): DiscoveryProviderExecutors {
  return {
    inspire: async request => ({
      provider: 'inspire',
      query: request.query,
      candidates: cases[request.query]?.inspire ?? [],
      result_count: cases[request.query]?.inspire?.length ?? 0,
    }),
    openalex: async request => ({
      provider: 'openalex',
      query: request.query,
      candidates: cases[request.query]?.openalex ?? [],
      result_count: cases[request.query]?.openalex?.length ?? 0,
    }),
    arxiv: async request => ({
      provider: 'arxiv',
      query: request.query,
      candidates: cases[request.query]?.arxiv ?? [],
      result_count: cases[request.query]?.arxiv?.length ?? 0,
    }),
  };
}

function makeCandidate(provider: 'inspire' | 'openalex' | 'arxiv', title: string, identifiers: CanonicalCandidate['identifiers']): CanonicalCandidate {
  return {
    provider,
    identifiers,
    title,
    authors: ['A. Author', 'B. Author'],
    year: 2025,
    matched_by: ['fixture'],
    provenance: { source: `${provider}_fixture`, query: title },
  };
}

describe('runFederatedDiscovery', () => {
  const prevDataDir = process.env.HEP_DATA_DIR;

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.HEP_DATA_DIR;
    else process.env.HEP_DATA_DIR = prevDataDir;
  });

  it('writes canonical/query-plan/dedup artifacts and appends search-log entries', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'disc01-broker-'));
    process.env.HEP_DATA_DIR = tmp;

    const exactTitle = 'Cross-provider canonical identity for HEP papers';
    const ambiguousTitle = 'Heavy flavor spectroscopy with near threshold states';

    const executors = buildExecutors({
      '10.1000/example': {
        inspire: [makeCandidate('inspire', exactTitle, { recid: '12345', doi: '10.1000/example', arxiv_id: '2501.00001' })],
        openalex: [makeCandidate('openalex', exactTitle, { openalex_id: 'W2741809807', doi: '10.1000/example' })],
        arxiv: [makeCandidate('arxiv', exactTitle, { arxiv_id: '2501.00001' })],
      },
      'near-threshold heavy flavor': {
        inspire: [makeCandidate('inspire', ambiguousTitle, { recid: '1001' })],
        openalex: [makeCandidate('openalex', ambiguousTitle, { openalex_id: 'W1001' })],
      },
    });

    const first = await runFederatedDiscovery({
      query: '10.1000/example',
      intent: 'known_item',
      limit: 10,
      executors,
    });

    expect(first.papers).toHaveLength(1);
    expect(first.dedup.confident_merges).toHaveLength(1);
    expect(path.basename(first.artifacts.query_plan.file_path)).toBe('discovery_query_plan_001_v1.json');
    expect(path.basename(first.artifacts.canonical_papers.file_path)).toBe('discovery_canonical_papers_001_v1.json');
    expect(path.basename(first.artifacts.dedup.file_path)).toBe('discovery_dedup_001_v1.json');
    expect(path.basename(first.artifacts.search_log.file_path)).toBe('discovery_search_log_v1.jsonl');
    expect(fs.existsSync(first.artifacts.query_plan.file_path)).toBe(true);
    expect(fs.existsSync(first.artifacts.canonical_papers.file_path)).toBe(true);
    expect(fs.existsSync(first.artifacts.dedup.file_path)).toBe(true);

    const second = await runFederatedDiscovery({
      query: 'near-threshold heavy flavor',
      intent: 'keyword_search',
      limit: 10,
      executors,
    });

    expect(second.papers).toHaveLength(2);
    expect(second.dedup.uncertain_groups).toHaveLength(1);

    const logLines = fs.readFileSync(first.artifacts.search_log.file_path, 'utf-8').trim().split('\n');
    expect(logLines).toHaveLength(2);
    expect(JSON.parse(logLines[0]).request_index).toBe(1);
    expect(JSON.parse(logLines[1]).request_index).toBe(2);
  });
});
