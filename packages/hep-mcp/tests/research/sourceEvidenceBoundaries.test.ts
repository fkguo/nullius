import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaperSummary } from '@nullius/shared';
import { readFileSync } from 'node:fs';
import { TraceOriginalSourceToolSchema } from '../../src/tools/research/schemas.js';

vi.mock('../../src/api/client.js', () => ({ getPaper: vi.fn(), getReferences: vi.fn() }));

const api = await import('../../src/api/client.js');
const { traceOriginalSource } = await import('../../src/tools/research/traceSource.js');

function paper(recid: string, year?: number): PaperSummary {
  return { recid, title: `Paper ${recid}`, authors: ['Same, Author'], year } as PaperSummary;
}

beforeEach(() => vi.resetAllMocks());

describe('citation tracing observations', () => {
  it('returns one-hop reading candidates with the checked-in landscape parameters', async () => {
    const recipe = JSON.parse(readFileSync(new URL('../../../literature-workflows/recipes/literature_landscape.json', import.meta.url), 'utf8'));
    const step = recipe.steps.find((item: { id: string }) => item.id === 'source_trace');
    const params = TraceOriginalSourceToolSchema.parse({ ...step.params, recid: '1' });
    expect(params).toMatchObject({ max_depth: 2, cross_validate: false });
    vi.mocked(api.getPaper).mockResolvedValue(paper('1', 2026) as never);
    vi.mocked(api.getReferences).mockResolvedValue([paper('2', 2020), paper('3')]);
    const result = await traceOriginalSource(params);
    expect(api.getReferences).toHaveBeenCalledExactlyOnceWith('1');
    expect(result.source_candidates.map(item => item.recid)).toEqual(['2', '3']);
    expect(result.analysis_scope.scientific_priority).toBe('not_assessed');
    expect(step.purpose).not.toMatch(/original|priority/);
    expect(recipe.steps.find((item: { id: string }) => item.id === 'topic_scan').purpose).not.toContain('emerging');
  });

  it('distinguishes a depth stop from an empty reference lookup result and retains unknown-year sources', async () => {
    vi.mocked(api.getPaper).mockResolvedValue(paper('1', 2026) as never);
    vi.mocked(api.getReferences).mockResolvedValue([paper('2')]);
    const result = await traceOriginalSource({ recid: '1', max_depth: 2, cross_validate: false });
    expect(api.getReferences).toHaveBeenCalledExactlyOnceWith('1');
    expect(result.source_candidates.map(item => item.recid)).toEqual(['2']);
    expect(result.trace_chain[0]?.reference_lookup).toMatchObject({ status: 'returned', returned_count: 1 });
    expect(result.trace_chain[1]?.reference_lookup).toEqual({ status: 'not_requested', reason: 'depth_limit' });
    expect(result).not.toHaveProperty('original_sources');
    expect(result.trace_chain.every(item => !('confidence' in item) && !('confidence_score' in item))).toBe(true);
  });

  it('reports upstream failures separately from empty reference results', async () => {
    vi.mocked(api.getPaper).mockResolvedValue(paper('1') as never);
    vi.mocked(api.getReferences).mockRejectedValueOnce(new Error('upstream offline'));
    const failed = await traceOriginalSource({ recid: '1', max_depth: 2 });
    expect(failed.trace_chain[0]?.reference_lookup).toEqual({ status: 'unavailable', error: 'upstream offline' });
    expect(failed.stats.reference_queries_failed).toBe(1);

    vi.mocked(api.getReferences).mockResolvedValueOnce([]);
    const empty = await traceOriginalSource({ recid: '1', max_depth: 2 });
    expect(empty.trace_chain[0]?.reference_lookup).toMatchObject({ status: 'returned', returned_count: 0, selected_count: 0 });
    expect(empty.analysis_scope.scientific_priority).toBe('not_assessed');
  });

  it('counts distinct citing records without claiming author or scientific independence', async () => {
    vi.mocked(api.getPaper).mockResolvedValue(paper('1', 2026) as never);
    const refs = new Map([
      ['1', [paper('2', 2020), paper('2', 2020), paper('3', 2021)]],
      ['2', [paper('4', 2010)]],
      ['3', [paper('4', 2010)]],
    ]);
    vi.mocked(api.getReferences).mockImplementation(async recid => refs.get(recid) ?? []);
    const result = await traceOriginalSource({ recid: '1', max_depth: 3 });
    expect(result.source_candidates).toHaveLength(1);
    expect(result.source_candidates[0]).toMatchObject({ recid: '4', citing_recids: ['2', '3'], incoming_reference_count: 2 });
    expect(result.source_candidates[0]).not.toHaveProperty('independent_chains');
    expect(result.analysis_scope).toMatchObject({ candidate_filter: 'multiple_citing_records', scientific_priority: 'not_assessed' });
    expect(api.getReferences).toHaveBeenCalledTimes(3);
  });

  it('exposes bounded selection and unresolved references without inventing complete coverage', async () => {
    vi.mocked(api.getPaper).mockResolvedValue(paper('1') as never);
    vi.mocked(api.getReferences).mockResolvedValue([paper('3', 2020), paper('2', 2000), paper('4'), paper('')]);
    const result = await traceOriginalSource({ recid: '1', max_depth: 2, max_refs_per_level: 1, cross_validate: false });
    expect(result.source_candidates.map(item => item.recid)).toEqual(['2']);
    expect(result.trace_chain[0]?.reference_lookup).toEqual({ status: 'returned', returned_count: 4, unresolved_count: 1, selected_count: 1, truncated_by_limit: true });
  });
});
