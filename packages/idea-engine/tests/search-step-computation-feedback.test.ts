import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeaEngineRpcService, RpcError } from '../src/index.js';

const NOW = '2026-03-25T00:00:00Z';
const LATER = '2026-03-25T00:05:00Z';
const FAILURE_OUTPUT_PATH = 'artifacts/failure_library/failure_library_hits_v1.json';

function createService(rootDir: string, now = NOW): IdeaEngineRpcService {
  return new IdeaEngineRpcService({ now: () => now, rootDir });
}

function campaignInitParams(options?: {
  distributor?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    charter: {
      campaign_name: 'computation-feedback-test',
      domain: 'hep-ph',
      scope: 'Validate post-compute feedback ingestion into failure-library and distributor substrates.',
      approval_gate_ref: 'gate://a0.1',
      ...(options?.distributor ? { distributor: options.distributor } : {}),
      ...(options?.extensions ? { extensions: options.extensions } : {}),
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

function searchStepParams(campaignId: string, idempotencyKey: string): Record<string, unknown> {
  return { campaign_id: campaignId, idempotency_key: idempotencyKey, n_steps: 1 };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function readJsonLines<T>(filePath: string): T[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

function writeFailureIndex(rootDir: string, entries: unknown[] = []): void {
  const indexPath = resolve(rootDir, 'global', 'failure_library_index_v1.json');
  mkdirSync(resolve(indexPath, '..'), { recursive: true });
  writeFileSync(indexPath, `${JSON.stringify({
    version: 1,
    generated_at_utc: NOW,
    entries,
    stats: { projects_scanned: 0, entries_total: entries.length },
  }, null, 2)}\n`, 'utf8');
}

function writePendingFeedback(rootDir: string, campaignId: string, payload: Record<string, unknown>): void {
  const pendingDir = resolve(rootDir, 'campaigns', campaignId, 'artifacts', 'computation_feedback_pending');
  mkdirSync(pendingDir, { recursive: true });
  const filePath = resolve(pendingDir, `${String(payload.run_id)}.json`);
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

describe('search.step computation-feedback ingestion', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('ingests failed computation feedback into the failure-library index before the next search step', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-compute-feedback-failure-'));
    tempDirs.push(rootDir);
    writeFailureIndex(rootDir);
    const service = createService(rootDir, NOW);
    const init = service.handle('campaign.init', campaignInitParams({
      extensions: {
        failure_library: {
          query: {
            version: 1,
            generated_at_utc: NOW,
            query: {
              tags: ['feedback:failure', 'operator_family:AnomalyAbduction'],
              failure_modes: ['execution_failure'],
            },
            output_artifact_path: FAILURE_OUTPUT_PATH,
          },
        },
      },
    }));
    const campaignId = String(init.campaign_id);
    const firstStep = service.handle('search.step', searchStepParams(campaignId, 'search-step-1'));
    const nodeId = String((firstStep.new_node_ids as string[])[0]);
    const node = service.search.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;

    writePendingFeedback(rootDir, campaignId, {
      schema_version: 1,
      generated_at: LATER,
      run_id: 'run-downstream-failure',
      campaign_id: campaignId,
      node_id: nodeId,
      idea_id: String(node.idea_id),
      source_handoff_uri: 'file:///tmp/handoff.json',
      computation_result_uri: 'rep://runs/run-downstream-failure/artifact/artifacts%2Fcomputation_result_v1.json',
      manifest_ref_uri: 'rep://runs/run-downstream-failure/artifact/computation%2Fmanifest.json',
      produced_artifact_uris: ['rep://runs/run-downstream-failure/artifact/computation%2Fexecution_status.json'],
      execution_status: 'failed',
      feedback_signal: 'failure',
      decision_kind: 'downgrade_idea',
      priority_change: 'lower',
      prune_candidate: true,
      objective_title: 'Failure feedback should lower into the shared failure library.',
      summary: 'The downstream compute failed deterministically.',
      failure_reason: 'solver diverged',
      finished_at: LATER,
      executor_step_ids: ['task_001'],
    });

    const secondService = createService(rootDir, LATER);
    const secondStep = secondService.handle('search.step', searchStepParams(campaignId, 'search-step-2'));
    const newNodeId = String((secondStep.new_node_ids as string[])[0]);
    const newNode = secondService.search.store.loadNodes<Record<string, unknown>>(campaignId)[newNodeId]!;
    const traceInputs = (newNode.operator_trace as Record<string, unknown>).inputs as Record<string, unknown>;
    const hitsArtifact = secondService.search.store.loadArtifactFromRef<Record<string, unknown>>(String(traceInputs.failure_library_hits_ref));
    const hits = hitsArtifact.hits as Array<Record<string, unknown>>;
    const index = readJson<Record<string, unknown>>(resolve(rootDir, 'global/failure_library_index_v1.json'));

    expect(traceInputs.failure_avoidance_hit_count).toBe(1);
    expect(hits).toHaveLength(1);
    expect(((hits[0]!.failed_approach as Record<string, unknown>).failure_mode)).toBe('execution_failure');
    expect((index.entries as unknown[])).toHaveLength(1);
    expect(existsSync(resolve(rootDir, 'campaigns', campaignId, 'artifacts', 'computation_feedback_pending', 'run-downstream-failure.json'))).toBe(false);
    expect(existsSync(resolve(rootDir, 'campaigns', campaignId, 'artifacts', 'computation_feedback_ingested', 'run-downstream-failure.json'))).toBe(true);
  });

  it('applies downstream reward feedback to the original distributor arm exactly once', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-compute-feedback-reward-'));
    tempDirs.push(rootDir);
    const service = createService(rootDir, NOW);
    const init = service.handle('campaign.init', campaignInitParams({
      distributor: { factorization: 'factorized', policy_id: 'ts.discounted_ucb_v1' },
    }));
    const campaignId = String(init.campaign_id);
    const firstStep = service.handle('search.step', searchStepParams(campaignId, 'search-step-1'));
    const nodeId = String((firstStep.new_node_ids as string[])[0]);
    const node = service.search.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
    const selectedActionId = String(((node.operator_trace as Record<string, unknown>).inputs as Record<string, unknown>).selected_action_id);

    writePendingFeedback(rootDir, campaignId, {
      schema_version: 1,
      generated_at: LATER,
      run_id: 'run-downstream-success',
      campaign_id: campaignId,
      node_id: nodeId,
      idea_id: String(node.idea_id),
      source_handoff_uri: 'file:///tmp/handoff.json',
      computation_result_uri: 'rep://runs/run-downstream-success/artifact/artifacts%2Fcomputation_result_v1.json',
      manifest_ref_uri: 'rep://runs/run-downstream-success/artifact/computation%2Fmanifest.json',
      produced_artifact_uris: ['rep://runs/run-downstream-success/artifact/results%2Ffinding.json'],
      execution_status: 'completed',
      feedback_signal: 'success',
      decision_kind: 'capture_finding',
      priority_change: 'raise',
      prune_candidate: false,
      objective_title: 'Successful downstream compute should reward the selected distributor arm.',
      summary: 'The downstream compute produced a finding.',
      failure_reason: null,
      finished_at: LATER,
      executor_step_ids: ['task_001'],
    });

    const secondService = createService(rootDir, LATER);
    secondService.handle('search.step', searchStepParams(campaignId, 'search-step-2'));

    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const events = readJsonLines<Record<string, unknown>>(resolve(campaignDir, 'artifacts', 'distributor', 'distributor_events_v1.jsonl'));
    const snapshot = readJson<Record<string, Record<string, Record<string, unknown>>>>(
      resolve(campaignDir, 'artifacts', 'distributor', 'distributor_state_snapshot_v1.json'),
    );
    const feedbackEvent = events.find(event => {
      const diagnostics = event.diagnostics as Record<string, unknown> | undefined;
      return diagnostics?.source === 'computation_feedback';
    });

    expect(events).toHaveLength(3);
    expect(feedbackEvent).toBeTruthy();
    expect(feedbackEvent?.observed_reward).toBe(1.25);
    expect(((feedbackEvent?.diagnostics as Record<string, unknown>).decision_kind)).toBe('capture_finding');
    expect(Number((snapshot.action_stats[selectedActionId] as Record<string, unknown>).n)).toBe(2);
    expect(existsSync(resolve(rootDir, 'campaigns', campaignId, 'artifacts', 'computation_feedback_pending', 'run-downstream-success.json'))).toBe(false);
    expect(existsSync(resolve(rootDir, 'campaigns', campaignId, 'artifacts', 'computation_feedback_ingested', 'run-downstream-success.json'))).toBe(true);
  }, 20000);

  it('does not reward the original distributor arm for failed downstream compute feedback', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-compute-feedback-no-reward-on-failure-'));
    tempDirs.push(rootDir);
    const service = createService(rootDir, NOW);
    const init = service.handle('campaign.init', campaignInitParams({
      distributor: { factorization: 'factorized', policy_id: 'ts.discounted_ucb_v1' },
    }));
    const campaignId = String(init.campaign_id);
    const firstStep = service.handle('search.step', searchStepParams(campaignId, 'search-step-1'));
    const nodeId = String((firstStep.new_node_ids as string[])[0]);
    const node = service.search.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
    const selectedActionId = String(((node.operator_trace as Record<string, unknown>).inputs as Record<string, unknown>).selected_action_id);

    writePendingFeedback(rootDir, campaignId, {
      schema_version: 1,
      generated_at: LATER,
      run_id: 'run-downstream-failure-no-reward',
      campaign_id: campaignId,
      node_id: nodeId,
      idea_id: String(node.idea_id),
      source_handoff_uri: 'file:///tmp/handoff.json',
      computation_result_uri: 'rep://runs/run-downstream-failure-no-reward/artifact/artifacts%2Fcomputation_result_v1.json',
      manifest_ref_uri: 'rep://runs/run-downstream-failure-no-reward/artifact/computation%2Fmanifest.json',
      produced_artifact_uris: ['rep://runs/run-downstream-failure-no-reward/artifact/computation%2Fexecution_status.json'],
      execution_status: 'failed',
      feedback_signal: 'failure',
      decision_kind: 'downgrade_idea',
      priority_change: 'lower',
      prune_candidate: true,
      objective_title: 'Failed downstream compute should not reward the selected distributor arm.',
      summary: 'The downstream compute failed.',
      failure_reason: 'solver diverged',
      finished_at: LATER,
      executor_step_ids: ['task_001'],
    });

    const secondService = createService(rootDir, LATER);
    secondService.handle('search.step', searchStepParams(campaignId, 'search-step-2'));

    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const events = readJsonLines<Record<string, unknown>>(resolve(campaignDir, 'artifacts', 'distributor', 'distributor_events_v1.jsonl'));
    const snapshot = readJson<Record<string, Record<string, Record<string, unknown>>>>(
      resolve(campaignDir, 'artifacts', 'distributor', 'distributor_state_snapshot_v1.json'),
    );
    const feedbackEvent = events.find(event => {
      const diagnostics = event.diagnostics as Record<string, unknown> | undefined;
      return diagnostics?.source === 'computation_feedback';
    });

    expect(feedbackEvent).toBeUndefined();
    expect(Number((snapshot.action_stats[selectedActionId] as Record<string, unknown>).n)).toBe(1);
    expect(existsSync(resolve(rootDir, 'campaigns', campaignId, 'artifacts', 'computation_feedback_ingested', 'run-downstream-failure-no-reward.json'))).toBe(true);
  });

  it('fails closed when queued computation feedback is malformed', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-compute-feedback-invalid-'));
    tempDirs.push(rootDir);
    const service = createService(rootDir, NOW);
    const init = service.handle('campaign.init', campaignInitParams());
    const campaignId = String(init.campaign_id);

    writePendingFeedback(rootDir, campaignId, {
      schema_version: 1,
      generated_at: NOW,
      run_id: 'run-invalid-feedback',
      campaign_id: campaignId,
      source_handoff_uri: 'file:///tmp/handoff.json',
    });

    try {
      service.handle('search.step', searchStepParams(campaignId, 'search-step-invalid'));
      throw new Error('expected search.step to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      const rpcError = error as RpcError;
      expect(rpcError.code).toBe(-32002);
      expect(rpcError.data.reason).toBe('schema_invalid');
    }
  });
});
