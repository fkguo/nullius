import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeaEngineRpcService, RpcError } from '../src/index.js';

const NOW = '2026-03-25T00:00:00Z';
const LATER = '2026-03-25T00:05:00Z';
const OUTPUT_PATH = 'artifacts/failure_library/failure_library_hits_v1.json';

function createService(rootDir: string, now = NOW): IdeaEngineRpcService {
  return new IdeaEngineRpcService({ now: () => now, rootDir });
}

function campaignInitParams(extensions?: Record<string, unknown>): Record<string, unknown> {
  return {
    charter: {
      campaign_name: 'failure-library-test',
      domain: 'hep-ph',
      scope: 'Validate bounded EVO-09 failure-library behavior.',
      approval_gate_ref: 'gate://a0.1',
      ...(extensions ? { extensions } : {}),
    },
    seed_pack: {
      seeds: [
        { seed_type: 'text', content: 'seed-a' },
        { seed_type: 'text', content: 'seed-b' },
      ],
    },
    budget: {
      max_tokens: 100000,
      max_cost_usd: 100,
      max_wall_clock_s: 100000,
      max_steps: 20,
    },
    idempotency_key: 'campaign-init',
  };
}

function searchStepParams(campaignId: string, idempotencyKey = 'search-step'): Record<string, unknown> {
  return { campaign_id: campaignId, n_steps: 1, idempotency_key: idempotencyKey };
}

function writeFailureIndex(rootDir: string, entries: unknown[]): void {
  const indexPath = resolve(rootDir, 'global/failure_library_index_v1.json');
  mkdirSync(resolve(indexPath, '..'), { recursive: true });
  writeFileSync(indexPath, `${JSON.stringify({
    version: 1,
    generated_at_utc: NOW,
    entries,
    stats: { projects_scanned: 1, entries_total: entries.length },
  }, null, 2)}\n`, 'utf8');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function writePendingFeedback(rootDir: string, campaignId: string, payload: Record<string, unknown>): void {
  const pendingDir = resolve(rootDir, 'campaigns', campaignId, 'artifacts', 'computation_feedback_pending');
  mkdirSync(pendingDir, { recursive: true });
  writeFileSync(resolve(pendingDir, `${String(payload.run_id)}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function matchingEntry(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    project_slug: 'example-project',
    artifact_relpath: 'projects/example-project/artifacts/ideas/failed_approach_v1.jsonl',
    line_number: 1,
    failed_approach: {
      approach_id: '123e4567-e89b-42d3-a456-426614174000',
      approach_summary: 'Search branch drifted from the constraint-guided method family.',
      failure_mode: 'method_drift',
      failure_modes: ['method_drift'],
      failure_evidence_uris: ['file:///tmp/method_fidelity_contract_v1.json'],
      lessons: ['Enforce method_fidelity_contract.'],
      reuse_potential: 'high',
      tags: ['method:constraint-guided-search', 'topic:method-fidelity', 'failure:method_drift'],
      created_at: NOW,
    },
    ...overrides,
  };
}

describe('search.step failure-library seam', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('writes hits artifacts and enriches operator trace when configured', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-failure-library-'));
    tempDirs.push(rootDir);
    writeFailureIndex(rootDir, [
      matchingEntry(),
      matchingEntry(),
      matchingEntry({
        artifact_relpath: 'projects/example-project/artifacts/ideas/failed_approach_v2.jsonl',
        line_number: 8,
        failed_approach: {
          ...matchingEntry().failed_approach as Record<string, unknown>,
          approach_id: '223e4567-e89b-42d3-a456-426614174000',
          approach_summary: 'Alternative branch drifted after unchecked assumptions.',
        },
      }),
    ]);

    const service = createService(rootDir);
    const init = service.handle('campaign.init', campaignInitParams({
      failure_library: {
        query: {
          version: 1,
          generated_at_utc: NOW,
          query: {
            tags: ['method:constraint-guided-search', 'topic:method-fidelity'],
            failure_modes: ['method_drift'],
          },
          max_hits: 2,
          output_artifact_path: OUTPUT_PATH,
        },
      },
    }));
    const campaignId = String(init.campaign_id);
    const result = service.handle('search.step', searchStepParams(campaignId));
    const nodeId = String((result.new_node_ids as string[])[0]);
    const node = service.search.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
    const traceInputs = (node.operator_trace as Record<string, unknown>).inputs as Record<string, unknown>;
    const hitsRef = String(traceInputs.failure_library_hits_ref);

    expect(traceInputs.failure_avoidance_hit_count).toBe(2);
    expect(hitsRef).toContain(`/campaigns/${campaignId}/artifacts/failure_library/failure_library_hits_v1.json`);
    expect(String((node.rationale_draft as Record<string, unknown>).rationale)).toContain('Avoid 2 prior failure hit(s)');

    const artifact = service.search.store.loadArtifactFromRef<Record<string, unknown>>(hitsRef);
    expect((artifact.hits as unknown[])).toHaveLength(2);
    expect((artifact.index_ref as Record<string, unknown>).path).toBe('global/failure_library_index_v1.json');
  });

  it('derives a bounded failure-library query from the current node when failed feedback has entered the index', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-derived-failure-library-'));
    tempDirs.push(rootDir);
    writeFailureIndex(rootDir, []);

    const service = createService(rootDir);
    const init = service.handle('campaign.init', campaignInitParams());
    const campaignId = String(init.campaign_id);
    const seedNode = Object.values(service.search.store.loadNodes<Record<string, unknown>>(campaignId))
      .find(node => node.operator_id === 'seed.import')!;

    writePendingFeedback(rootDir, campaignId, {
      schema_version: 1,
      generated_at: LATER,
      run_id: 'run-seed-failure',
      campaign_id: campaignId,
      node_id: String(seedNode.node_id),
      idea_id: String(seedNode.idea_id),
      source_handoff_uri: 'file:///tmp/handoff.json',
      computation_result_uri: 'rep://runs/run-seed-failure/artifact/artifacts%2Fcomputation_result_v1.json',
      manifest_ref_uri: 'rep://runs/run-seed-failure/artifact/computation%2Fmanifest.json',
      produced_artifact_uris: ['rep://runs/run-seed-failure/artifact/computation%2Fexecution_status.json'],
      execution_status: 'failed',
      feedback_signal: 'failure',
      decision_kind: 'downgrade_idea',
      priority_change: 'lower',
      prune_candidate: true,
      objective_title: 'Seed failure should become a bounded reflection hit.',
      summary: 'The seed-level downstream compute failed.',
      failure_reason: 'seed computation diverged',
      finished_at: LATER,
      executor_step_ids: ['task_001'],
    });

    const secondService = createService(rootDir, LATER);
    const result = secondService.handle('search.step', searchStepParams(campaignId, 'search-step-derived'));
    const nodeId = String((result.new_node_ids as string[])[0]);
    const node = secondService.search.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
    const traceInputs = (node.operator_trace as Record<string, unknown>).inputs as Record<string, unknown>;
    const hitsArtifact = secondService.search.store.loadArtifactFromRef<Record<string, unknown>>(String(traceInputs.failure_library_hits_ref));
    const hits = hitsArtifact.hits as Array<Record<string, unknown>>;
    const query = (hitsArtifact.query as Record<string, unknown>).query as Record<string, unknown>;
    const index = readJson<Record<string, unknown>>(resolve(rootDir, 'global/failure_library_index_v1.json'));

    expect(traceInputs.failure_avoidance_hit_count).toBe(1);
    expect(hits).toHaveLength(1);
    expect(((hits[0]!.failed_approach as Record<string, unknown>).failure_mode)).toBe('execution_failure');
    expect(query.tags).toEqual(expect.arrayContaining([
      'action:seed_pack::seed.import::island-0',
      'operator_family:Seed',
    ]));
    expect(String((node.rationale_draft as Record<string, unknown>).rationale)).toContain('Avoid 1 prior failure hit(s)');
    expect((index.entries as unknown[])).toHaveLength(1);
  });

  it('keeps derived failure-library hit artifacts auditable per generated node in multi-tick steps', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-derived-failure-library-multitick-'));
    tempDirs.push(rootDir);
    writeFailureIndex(rootDir, [
      matchingEntry({
        failed_approach: {
          ...matchingEntry().failed_approach as Record<string, unknown>,
          approach_id: '523e4567-e89b-42d3-a456-426614174000',
          approach_summary: 'Island 0 seed failure.',
          failure_mode: 'execution_failure',
          failure_modes: ['execution_failure', 'Seed'],
          tags: ['action:seed_pack::seed.import::island-0', 'operator_family:Seed', 'observable:observable-1'],
        },
      }),
      matchingEntry({
        artifact_relpath: 'projects/example-project/artifacts/ideas/island-1-failed_approach_v1.jsonl',
        line_number: 2,
        failed_approach: {
          ...matchingEntry().failed_approach as Record<string, unknown>,
          approach_id: '623e4567-e89b-42d3-a456-426614174000',
          approach_summary: 'Island 1 seed failure.',
          failure_mode: 'execution_failure',
          failure_modes: ['execution_failure', 'Seed'],
          tags: ['action:seed_pack::seed.import::island-1', 'operator_family:Seed', 'observable:observable-1'],
        },
      }),
    ]);

    const service = createService(rootDir);
    const init = service.handle('campaign.init', campaignInitParams({ initial_island_count: 2 }));
    const campaignId = String(init.campaign_id);
    const result = service.handle('search.step', { campaign_id: campaignId, n_steps: 2, idempotency_key: 'search-step-derived-multitick' });
    const nodeIds = result.new_node_ids as string[];
    const nodes = service.search.store.loadNodes<Record<string, unknown>>(campaignId);
    const hitRefs = nodeIds.map(nodeId => String(((nodes[nodeId]!.operator_trace as Record<string, unknown>).inputs as Record<string, unknown>).failure_library_hits_ref));
    const artifacts = hitRefs.map(ref => service.search.store.loadArtifactFromRef<Record<string, unknown>>(ref));
    const queries = artifacts.map(artifact => (artifact.query as Record<string, unknown>).query as Record<string, unknown>);
    const summaries = artifacts.map(artifact => ((artifact.hits as Array<Record<string, unknown>>)[0]!.failed_approach as Record<string, unknown>).approach_summary);

    expect(new Set(hitRefs).size).toBe(2);
    expect(queries[0]!.tags).toEqual(expect.arrayContaining(['action:seed_pack::seed.import::island-0']));
    expect(queries[1]!.tags).toEqual(expect.arrayContaining(['action:seed_pack::seed.import::island-1']));
    expect(summaries).toEqual(['Island 0 seed failure.', 'Island 1 seed failure.']);
  });

  it('keeps explicit failure-library query config ahead of derived node signals', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-explicit-failure-library-'));
    tempDirs.push(rootDir);
    writeFailureIndex(rootDir, [
      matchingEntry({
        failed_approach: {
          ...matchingEntry().failed_approach as Record<string, unknown>,
          approach_id: '323e4567-e89b-42d3-a456-426614174000',
          approach_summary: 'Derived seed tags should not be used when explicit query is configured.',
          failure_mode: 'execution_failure',
          failure_modes: ['execution_failure', 'Seed'],
          tags: ['action:seed_pack::seed.import::island-0', 'operator_family:Seed', 'observable:observable-1'],
        },
      }),
      matchingEntry({
        failed_approach: {
          ...matchingEntry().failed_approach as Record<string, unknown>,
          approach_id: '423e4567-e89b-42d3-a456-426614174000',
          approach_summary: 'Explicit method fidelity query should win.',
        },
      }),
    ]);

    const service = createService(rootDir);
    const init = service.handle('campaign.init', campaignInitParams({
      failure_library: {
        query: {
          version: 1,
          generated_at_utc: NOW,
          query: {
            tags: ['method:constraint-guided-search', 'topic:method-fidelity'],
            failure_modes: ['method_drift'],
          },
          output_artifact_path: OUTPUT_PATH,
        },
      },
    }));
    const campaignId = String(init.campaign_id);
    const result = service.handle('search.step', searchStepParams(campaignId, 'search-step-explicit'));
    const nodeId = String((result.new_node_ids as string[])[0]);
    const node = service.search.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
    const traceInputs = (node.operator_trace as Record<string, unknown>).inputs as Record<string, unknown>;
    const artifact = service.search.store.loadArtifactFromRef<Record<string, unknown>>(String(traceInputs.failure_library_hits_ref));
    const hits = artifact.hits as Array<Record<string, unknown>>;
    const query = (artifact.query as Record<string, unknown>).query as Record<string, unknown>;

    expect(query.tags).toEqual(['method:constraint-guided-search', 'topic:method-fidelity']);
    expect(hits).toHaveLength(1);
    expect(((hits[0]!.failed_approach as Record<string, unknown>).approach_summary)).toBe('Explicit method fidelity query should win.');
  });

  it('does not generate a broad default query when the parent node has no bounded failure-library signals', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-no-derived-signals-'));
    tempDirs.push(rootDir);
    writeFailureIndex(rootDir, [matchingEntry()]);

    const service = createService(rootDir);
    const init = service.handle('campaign.init', campaignInitParams());
    const campaignId = String(init.campaign_id);
    const nodes = service.search.store.loadNodes<Record<string, unknown>>(campaignId);
    for (const node of Object.values(nodes)) {
      node.operator_id = '';
      delete node.operator_family;
      node.origin = {
        model: '',
        temperature: 0,
        prompt_hash: (node.origin as Record<string, unknown>).prompt_hash,
        timestamp: NOW,
        role: 'SignalStrippedFixture',
      };
      node.operator_trace = { inputs: {}, params: {}, evidence_uris_used: [] };
      node.idea_card = null;
      node.eval_info = null;
    }
    service.search.store.saveNodes(campaignId, nodes);

    const result = service.handle('search.step', searchStepParams(campaignId, 'search-step-no-derived-signals'));
    const nodeId = String((result.new_node_ids as string[])[0]);
    const node = service.search.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
    const traceInputs = (node.operator_trace as Record<string, unknown>).inputs as Record<string, unknown>;

    expect('failure_library_hits_ref' in traceInputs).toBe(false);
    expect(existsSync(resolve(rootDir, `campaigns/${campaignId}/artifacts/failure_library`))).toBe(false);
  });

  it('dedupes exact duplicate failure-library hits before applying the cap', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-dedup-failure-library-'));
    tempDirs.push(rootDir);
    writeFailureIndex(rootDir, [
      matchingEntry(),
      matchingEntry(),
      matchingEntry({
        artifact_relpath: 'projects/example-project/artifacts/ideas/failed_approach_v2.jsonl',
        line_number: 8,
      }),
    ]);

    const service = createService(rootDir);
    const init = service.handle('campaign.init', campaignInitParams({
      failure_library: {
        query: {
          version: 1,
          generated_at_utc: NOW,
          query: {
            tags: ['method:constraint-guided-search', 'topic:method-fidelity'],
            failure_modes: ['method_drift'],
          },
          output_artifact_path: OUTPUT_PATH,
        },
      },
    }));
    const campaignId = String(init.campaign_id);
    const result = service.handle('search.step', searchStepParams(campaignId, 'search-step-dedup'));
    const nodeId = String((result.new_node_ids as string[])[0]);
    const node = service.search.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
    const traceInputs = (node.operator_trace as Record<string, unknown>).inputs as Record<string, unknown>;
    const artifact = service.search.store.loadArtifactFromRef<Record<string, unknown>>(String(traceInputs.failure_library_hits_ref));
    const hits = artifact.hits as Array<Record<string, unknown>>;

    expect(traceInputs.failure_avoidance_hit_count).toBe(2);
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map(hit => `${hit.project_slug}|${hit.artifact_relpath}|${hit.line_number}`)).size).toBe(2);
  });

  it('leaves default behavior unchanged when failure-library is not configured', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-no-failure-library-'));
    tempDirs.push(rootDir);
    const service = createService(rootDir);
    const init = service.handle('campaign.init', campaignInitParams());
    const campaignId = String(init.campaign_id);
    const result = service.handle('search.step', searchStepParams(campaignId));
    const nodeId = String((result.new_node_ids as string[])[0]);
    const node = service.search.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
    const traceInputs = (node.operator_trace as Record<string, unknown>).inputs as Record<string, unknown>;

    expect('failure_library_hits_ref' in traceInputs).toBe(false);
    expect(existsSync(resolve(rootDir, `campaigns/${campaignId}/artifacts/failure_library`))).toBe(false);
  });

  it('fails closed when failure-library is configured but the index is missing', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-missing-failure-index-'));
    tempDirs.push(rootDir);
    const service = createService(rootDir);
    const init = service.handle('campaign.init', campaignInitParams({
      failure_library: {
        query: {
          version: 1,
          generated_at_utc: NOW,
          query: { tags: ['method:constraint-guided-search'] },
          output_artifact_path: OUTPUT_PATH,
        },
      },
    }));

    try {
      service.handle('search.step', searchStepParams(String(init.campaign_id)));
      throw new Error('expected search.step to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      const rpcError = error as RpcError;
      expect(rpcError.code).toBe(-32002);
      expect(rpcError.data.reason).toBe('schema_invalid');
    }
  });

  it('fails closed when output_artifact_path escapes the campaign directory', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-escaped-failure-output-'));
    tempDirs.push(rootDir);
    writeFailureIndex(rootDir, [matchingEntry()]);
    const service = createService(rootDir);
    const init = service.handle('campaign.init', campaignInitParams({
      failure_library: {
        query: {
          version: 1,
          generated_at_utc: NOW,
          query: { tags: ['method:constraint-guided-search'] },
          output_artifact_path: '../escape.json',
        },
      },
    }));

    try {
      service.handle('search.step', searchStepParams(String(init.campaign_id), 'search-step-escaped-output'));
      throw new Error('expected search.step to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      const rpcError = error as RpcError;
      expect(rpcError.code).toBe(-32002);
      expect(rpcError.data.reason).toBe('schema_invalid');
    }
  });
});
