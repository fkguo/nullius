import { createHash } from 'crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { IdeaEngineRpcService } from '../src/service/rpc-service.js';
import { expectRpcError } from './helpers/revise-card-test-fixture.js';

/**
 * Field-evidence-driven idea-layer behaviors:
 * - lifecycle demotion marks a current posterior stale in the same write
 *   (and the needs_refresh -> admitted shortcut edge is gone);
 * - rank.compute is store-state aware: unchanged store + filter reuses the
 *   existing ranking artifact instead of minting a byte-identical copy;
 * - complete-sort-key ties are marked as groups whose internal order carries
 *   no information; ranked rows carry the node title;
 * - undeclared budget dimensions are absent from snapshots instead of being
 *   rendered as constant-zero counters under untouchable ceilings.
 */

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
});

/** Service with an advancing clock: every now() call is one second later. */
function freshAdvancing(prefix: string): { rootDir: string; service: IdeaEngineRpcService } {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(rootDir);
  let tick = 0;
  return {
    rootDir,
    service: new IdeaEngineRpcService({
      rootDir,
      now: () => new Date(Date.UTC(2026, 6, 21, 7, 30, tick++)).toISOString(),
    }),
  };
}

function initCampaign(
  service: IdeaEngineRpcService,
  options: { budget?: Record<string, unknown>; seedCount?: number } = {},
): { campaignId: string; nodeIds: string[] } {
  const seedCount = options.seedCount ?? 1;
  const result = service.handle('campaign.init', {
    budget: options.budget ?? {
      max_cost_usd: 100,
      max_nodes: 20,
      max_steps: 20,
      max_tokens: 100_000,
      max_wall_clock_s: 10_000,
    },
    charter: {
      approval_gate_ref: 'gate://a0.1',
      campaign_name: 'idea layer optimization test',
      domain: 'test-domain',
      scope: 'store-state-aware ranking and lifecycle demotion fixture',
    },
    idempotency_key: `init-${seedCount}`,
    seed_pack: {
      seeds: Array.from({ length: seedCount }, (_, index) => ({
        content: `Seed proposition number ${index + 1} for the optimization fixture.`,
        seed_type: 'text',
        source_uris: ['https://example.org/source'],
      })),
    },
  });
  const campaignId = String(result.campaign_id);
  const nodeIds = Object.keys(service.read.store.loadNodes(campaignId));
  return { campaignId, nodeIds };
}

function admitNode(
  service: IdeaEngineRpcService,
  campaignId: string,
  nodeId: string,
  options: { evidenceCount?: number; value?: number } = {},
): void {
  service.handle('node.set_lifecycle', {
    campaign_id: campaignId,
    node_id: nodeId,
    lifecycle_state: 'admission_review',
    idempotency_key: `review-${nodeId}`,
  });
  service.handle('node.set_posterior', {
    campaign_id: campaignId,
    node_id: nodeId,
    posterior: {
      value: options.value ?? 0.71,
      evidence_count: options.evidenceCount ?? 6,
      status: 'current',
      gaia_package_ref: 'project://gaia/idea-package',
    },
    literature_coverage: {
      status: 'saturated',
      survey_ref: 'project://literature/survey.json',
      close_prior_matrix_ref: 'project://literature/close-prior.json',
    },
    idempotency_key: `posterior-${nodeId}`,
  });
}

function storedNode(service: IdeaEngineRpcService, campaignId: string, nodeId: string): Record<string, unknown> {
  return service.read.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
}

function storedPosterior(service: IdeaEngineRpcService, campaignId: string, nodeId: string): Record<string, unknown> {
  return storedNode(service, campaignId, nodeId).posterior as Record<string, unknown>;
}

function rankingsDir(rootDir: string, campaignId: string): string[] {
  const dir = resolve(rootDir, 'campaigns', campaignId, 'artifacts', 'rankings');
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

describe('lifecycle demotion marks the posterior stale', () => {
  it('admitted -> needs_refresh stales a current posterior in the same write, values preserved', () => {
    const { service } = freshAdvancing('idea-demote-');
    const { campaignId, nodeIds } = initCampaign(service);
    const nodeId = nodeIds[0]!;
    admitNode(service, campaignId, nodeId);
    const before = storedPosterior(service, campaignId, nodeId);
    expect(before.status).toBe('current');

    const result = service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      node_id: nodeId,
      lifecycle_state: 'needs_refresh',
      reason: 'superseding evidence landed',
      idempotency_key: 'demote-1',
    }) as { node: { lifecycle_state: string; posterior: Record<string, unknown> } };

    expect(result.node.lifecycle_state).toBe('needs_refresh');
    expect(result.node.posterior.status).toBe('stale');
    const after = storedPosterior(service, campaignId, nodeId);
    expect(after.status).toBe('stale');
    expect(after.value).toBe(before.value);
    expect(after.evidence_count).toBe(before.evidence_count);
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.gaia_package_ref).toBe(before.gaia_package_ref);

    const logEntries = service.read.store.loadNodeLogEntriesStrict(campaignId);
    const demotion = logEntries.at(-1)!;
    expect(demotion.mutation).toBe('set_lifecycle');
    expect(demotion.posterior_marked_stale).toBe(true);
  });

  it('admitted -> archived stales; suspension into waiting_activation does not', () => {
    const { service } = freshAdvancing('idea-demote-arch-');
    const { campaignId, nodeIds } = initCampaign(service, { seedCount: 2 });
    const [archivedNode, suspendedNode] = nodeIds as [string, string];
    admitNode(service, campaignId, archivedNode);
    admitNode(service, campaignId, suspendedNode);

    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      node_id: archivedNode,
      lifecycle_state: 'archived',
      reason: 'idea leaves the pool',
      idempotency_key: 'archive-1',
    });
    expect(storedPosterior(service, campaignId, archivedNode).status).toBe('stale');

    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      node_id: suspendedNode,
      lifecycle_state: 'waiting_activation',
      activation_condition: { kind: 'data_release', description: 'awaiting the release', satisfied: false },
      idempotency_key: 'suspend-1',
    });
    expect(storedPosterior(service, campaignId, suspendedNode).status).toBe('current');
    const suspensionEntry = service.read.store.loadNodeLogEntriesStrict(campaignId).at(-1)!;
    expect(suspensionEntry.posterior_marked_stale).toBeUndefined();
  });

  it('a provisional posterior stays provisional through demotion', () => {
    const { service } = freshAdvancing('idea-demote-prov-');
    const { campaignId, nodeIds } = initCampaign(service);
    const nodeId = nodeIds[0]!;
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      node_id: nodeId,
      lifecycle_state: 'admission_review',
      idempotency_key: 'review-prov',
    });
    service.handle('node.set_posterior', {
      campaign_id: campaignId,
      node_id: nodeId,
      posterior: { value: 0.4, evidence_count: 2, status: 'provisional' },
      literature_coverage: {
        status: 'coverage_incomplete',
        survey_ref: 'project://literature/survey.json',
        close_prior_matrix_ref: 'project://literature/close-prior.json',
      },
      idempotency_key: 'posterior-prov',
    });
    // provisional write derives needs_refresh; demote further into blocked.
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      node_id: nodeId,
      lifecycle_state: 'admission_blocked',
      activation_condition: { kind: 'required_evidence', description: 'missing close-prior pass', satisfied: false },
      idempotency_key: 'block-prov',
    });
    expect(storedPosterior(service, campaignId, nodeId).status).toBe('provisional');
  });

  it('needs_refresh -> admitted is no longer a legal lifecycle flip; re-admission is a fresh posterior write', () => {
    const { service } = freshAdvancing('idea-readmit-');
    const { campaignId, nodeIds } = initCampaign(service);
    const nodeId = nodeIds[0]!;
    admitNode(service, campaignId, nodeId);
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      node_id: nodeId,
      lifecycle_state: 'needs_refresh',
      reason: 'refresh owed',
      idempotency_key: 'demote-2',
    });

    const error = expectRpcError(
      () => service.handle('node.set_lifecycle', {
        campaign_id: campaignId,
        node_id: nodeId,
        lifecycle_state: 'admitted',
        idempotency_key: 'flip-back',
      }),
      -32018,
      'illegal_transition',
    );
    expect((error.data.details as { allowed_next: string[] }).allowed_next).not.toContain('admitted');

    // The designed path back: a fresh set_posterior derivation.
    service.handle('node.set_posterior', {
      campaign_id: campaignId,
      node_id: nodeId,
      posterior: { value: 0.8, evidence_count: 7, status: 'current' },
      literature_coverage: {
        status: 'saturated',
        survey_ref: 'project://literature/survey.json',
        close_prior_matrix_ref: 'project://literature/close-prior.json',
      },
      idempotency_key: 'readmit-posterior',
    });
    expect(storedNode(service, campaignId, nodeId).lifecycle_state).toBe('admitted');
    expect(storedPosterior(service, campaignId, nodeId).status).toBe('current');
  });
});

describe('rank.compute store-state awareness', () => {
  function rank(service: IdeaEngineRpcService, campaignId: string, key: string): Record<string, unknown> {
    return service.handle('rank.compute', { campaign_id: campaignId, method: 'posterior', idempotency_key: key });
  }

  it('reuses the existing ranking when the store is unchanged: same artifact, no step, unchanged_since set', () => {
    const { rootDir, service } = freshAdvancing('idea-rank-reuse-');
    const { campaignId, nodeIds } = initCampaign(service, { seedCount: 2 });
    admitNode(service, campaignId, nodeIds[0]!, { value: 0.9 });
    admitNode(service, campaignId, nodeIds[1]!, { value: 0.6 });

    const first = rank(service, campaignId, 'rank-1');
    expect(typeof first.store_digest).toBe('string');
    expect(first.unchanged_since).toBeUndefined();
    expect((first.budget_snapshot as Record<string, unknown>).steps_used).toBe(1);
    expect(rankingsDir(rootDir, campaignId)).toHaveLength(1);

    const second = rank(service, campaignId, 'rank-2');
    expect(second.store_digest).toBe(first.store_digest);
    expect(second.ranking_artifact_ref).toBe(first.ranking_artifact_ref);
    expect(second.unchanged_since).toBe(first.generated_at);
    expect((second.budget_snapshot as Record<string, unknown>).steps_used).toBe(1);
    expect(second.ranked_nodes).toEqual(first.ranked_nodes);
    expect(rankingsDir(rootDir, campaignId)).toHaveLength(1);
    expect((second.idempotency as Record<string, unknown>).is_replay).toBe(false);
  });

  it('mints a new ranking when the store changed, and records the digest in the artifact', () => {
    const { rootDir, service } = freshAdvancing('idea-rank-change-');
    const { campaignId, nodeIds } = initCampaign(service, { seedCount: 2 });
    admitNode(service, campaignId, nodeIds[0]!, { value: 0.9 });
    const first = rank(service, campaignId, 'rank-1');

    admitNode(service, campaignId, nodeIds[1]!, { value: 0.7 });
    const second = rank(service, campaignId, 'rank-2');
    expect(second.store_digest).not.toBe(first.store_digest);
    expect(second.ranking_artifact_ref).not.toBe(first.ranking_artifact_ref);
    expect(second.unchanged_since).toBeUndefined();
    expect((second.budget_snapshot as Record<string, unknown>).steps_used).toBe(2);
    expect(rankingsDir(rootDir, campaignId)).toHaveLength(2);

    const artifact = service.read.store.loadArtifactFromRef<Record<string, unknown>>(String(second.ranking_artifact_ref));
    expect(artifact.store_digest).toBe(second.store_digest);
  });

  it('never rolls campaign state back to a superseded mint record', () => {
    const { rootDir, service } = freshAdvancing('idea-rank-supersede-');
    const { campaignId, nodeIds } = initCampaign(service, { seedCount: 2 });
    admitNode(service, campaignId, nodeIds[0]!, { value: 0.8 });
    const first = rank(service, campaignId, 'rank-k1');

    // K1's record stays prepared (crash between campaign save and commit);
    // the store then changes and K2 mints on top.
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['rank.compute:rank-k1']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));
    admitNode(service, campaignId, nodeIds[1]!, { value: 0.6 });
    const second = rank(service, campaignId, 'rank-k2');
    expect((second.budget_snapshot as Record<string, unknown>).steps_used).toBe(2);

    // Duplicate delivery of K1 replays WITHOUT touching the newer state.
    const replayed = rank(service, campaignId, 'rank-k1');
    expect((replayed.idempotency as Record<string, unknown>).is_replay).toBe(true);
    const campaign = JSON.parse(readFileSync(resolve(campaignDir, 'campaign.json'), 'utf8')) as Record<string, unknown>;
    expect((campaign.usage as Record<string, unknown>).steps_used).toBe(2);
    expect((campaign.last_ranking as Record<string, unknown>).ranking_artifact_ref).toBe(second.ranking_artifact_ref);

    // And the restored world still reuses K2's ranking, not K1's.
    const after = rank(service, campaignId, 'rank-k3');
    expect(after.ranking_artifact_ref).toBe(second.ranking_artifact_ref);
    expect(after.unchanged_since).toBe(second.generated_at);
    expect(first.ranking_artifact_ref).not.toBe(second.ranking_artifact_ref);
  });

  it('completes a LOST newer mint over an older landed pointer, exactly one step over current', () => {
    // The reverse of the superseded case: K1's save landed (pointer K1),
    // K2 minted its artifact but K2's campaign save was lost. K2's record
    // is strictly newer than the pointer, so its retry completes: pointer
    // becomes K2 and steps advance by exactly one over the CURRENT counter.
    const { rootDir, service } = freshAdvancing('idea-rank-k2lost-');
    const { campaignId, nodeIds } = initCampaign(service, { seedCount: 2 });
    admitNode(service, campaignId, nodeIds[0]!, { value: 0.8 });
    const first = rank(service, campaignId, 'rank-k1');
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const campaignPath = resolve(campaignDir, 'campaign.json');
    const afterK1 = readFileSync(campaignPath, 'utf8');

    admitNode(service, campaignId, nodeIds[1]!, { value: 0.6 });
    const second = rank(service, campaignId, 'rank-k2');
    // Crash: K2's campaign save lost (roll back to the post-K1 campaign),
    // K2's record left prepared. Node changes persist (separate file).
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['rank.compute:rank-k2']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));
    writeFileSync(campaignPath, afterK1);

    const retry = rank(service, campaignId, 'rank-k2');
    expect((retry.idempotency as Record<string, unknown>).is_replay).toBe(true);
    const recovered = JSON.parse(readFileSync(campaignPath, 'utf8')) as Record<string, unknown>;
    expect((recovered.usage as Record<string, unknown>).steps_used).toBe(2);
    expect((recovered.last_ranking as Record<string, unknown>).ranking_artifact_ref).toBe(second.ranking_artifact_ref);
    expect(first.ranking_artifact_ref).not.toBe(second.ranking_artifact_ref);

    // The restored pointer serves reuse on the unchanged store.
    const after = rank(service, campaignId, 'rank-k3');
    expect(after.ranking_artifact_ref).toBe(second.ranking_artifact_ref);
    expect(after.unchanged_since).toBe(second.generated_at);
  });

  it('never resurrects a paused or completed campaign while completing a lost write', () => {
    for (const [prefix, mutation, expectedStatus] of [
      ['idea-rank-paused-', 'campaign.pause', 'paused'],
      ['idea-rank-completed-', 'campaign.complete', 'completed'],
    ] as const) {
      const { rootDir, service } = freshAdvancing(prefix);
      const { campaignId, nodeIds } = initCampaign(service);
      admitNode(service, campaignId, nodeIds[0]!, { value: 0.8 });
      rank(service, campaignId, 'rank-first');

      // Crash loses the campaign save entirely; the operator then pauses or
      // completes the campaign before the duplicate arrives.
      const campaignDir = resolve(rootDir, 'campaigns', campaignId);
      const idemPath = resolve(campaignDir, 'idempotency_store.json');
      const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
      idem['rank.compute:rank-first']!.state = 'prepared';
      writeFileSync(idemPath, JSON.stringify(idem));
      const campaignPath = resolve(campaignDir, 'campaign.json');
      const campaign = JSON.parse(readFileSync(campaignPath, 'utf8')) as Record<string, unknown>;
      delete campaign.last_ranking;
      (campaign.usage as Record<string, unknown>).steps_used = 0;
      writeFileSync(campaignPath, JSON.stringify(campaign));
      service.handle(mutation, { campaign_id: campaignId, idempotency_key: `${prefix}mut` });

      const retry = rank(service, campaignId, 'rank-first');
      expect((retry.idempotency as Record<string, unknown>).is_replay).toBe(true);
      const recovered = JSON.parse(readFileSync(campaignPath, 'utf8')) as Record<string, unknown>;
      expect(recovered.status).toBe(expectedStatus);
      expect((recovered.usage as Record<string, unknown>).steps_used).toBe(1);
      expect((recovered.last_ranking as Record<string, unknown>)).toBeTruthy();
    }
  });

  it('takes the conservative no-write side when the pointer exists but cannot be ordered', () => {
    // A hand-edited pointer without generated_at is unordered: completion
    // must not treat it as absent and roll newer state back.
    const { rootDir, service } = freshAdvancing('idea-rank-unstamped-');
    const { campaignId, nodeIds } = initCampaign(service, { seedCount: 2 });
    admitNode(service, campaignId, nodeIds[0]!, { value: 0.8 });
    rank(service, campaignId, 'rank-u1');
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['rank.compute:rank-u1']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));
    admitNode(service, campaignId, nodeIds[1]!, { value: 0.6 });
    const second = rank(service, campaignId, 'rank-u2');
    // Hand-strip the stamp from the newer pointer.
    const campaignPath = resolve(campaignDir, 'campaign.json');
    const campaign = JSON.parse(readFileSync(campaignPath, 'utf8')) as Record<string, unknown>;
    delete (campaign.last_ranking as Record<string, unknown>).generated_at;
    writeFileSync(campaignPath, JSON.stringify(campaign));

    const replayed = rank(service, campaignId, 'rank-u1');
    expect((replayed.idempotency as Record<string, unknown>).is_replay).toBe(true);
    const recovered = JSON.parse(readFileSync(campaignPath, 'utf8')) as Record<string, unknown>;
    expect((recovered.usage as Record<string, unknown>).steps_used).toBe(2);
    expect((recovered.last_ranking as Record<string, unknown>).ranking_artifact_ref).toBe(second.ranking_artifact_ref);
  });

  it('re-derives exhaustion when completing a lost campaign write', () => {
    const { rootDir, service } = freshAdvancing('idea-rank-exhaust-');
    const { campaignId, nodeIds } = initCampaign(service, {
      budget: { max_nodes: 20, max_steps: 1 },
    });
    admitNode(service, campaignId, nodeIds[0]!, { value: 0.8 });
    rank(service, campaignId, 'rank-only');

    // Crash window: artifact written, campaign save lost entirely.
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['rank.compute:rank-only']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));
    const campaignPath = resolve(campaignDir, 'campaign.json');
    const campaign = JSON.parse(readFileSync(campaignPath, 'utf8')) as Record<string, unknown>;
    delete campaign.last_ranking;
    (campaign.usage as Record<string, unknown>).steps_used = 0;
    campaign.status = 'running';
    writeFileSync(campaignPath, JSON.stringify(campaign));

    const retry = rank(service, campaignId, 'rank-only');
    expect((retry.idempotency as Record<string, unknown>).is_replay).toBe(true);
    const recovered = JSON.parse(readFileSync(campaignPath, 'utf8')) as Record<string, unknown>;
    expect((recovered.usage as Record<string, unknown>).steps_used).toBe(1);
    expect(recovered.status).toBe('exhausted');
  });

  it('mints distinct artifact names for distinct store states within one second', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-rank-samesec-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({
      rootDir,
      now: () => '2026-07-21T07:30:00Z',
    });
    const { campaignId, nodeIds } = initCampaign(service, { seedCount: 2 });
    admitNode(service, campaignId, nodeIds[0]!, { value: 0.8 });
    const first = rank(service, campaignId, 'rank-s1');
    admitNode(service, campaignId, nodeIds[1]!, { value: 0.6 });
    const second = rank(service, campaignId, 'rank-s2');
    expect(second.ranking_artifact_ref).not.toBe(first.ranking_artifact_ref);
    expect(rankingsDir(rootDir, campaignId)).toHaveLength(2);
  });

  it('completes the campaign pointer when a crash lost it after the artifact write', () => {
    const { rootDir, service } = freshAdvancing('idea-rank-recover-');
    const { campaignId, nodeIds } = initCampaign(service);
    admitNode(service, campaignId, nodeIds[0]!, { value: 0.8 });
    const first = rank(service, campaignId, 'rank-crash');

    // Simulate the crash window between the artifact write and the campaign
    // save: record prepared, pointer and step accounting lost.
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['rank.compute:rank-crash']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));
    const campaignPath = resolve(campaignDir, 'campaign.json');
    const campaign = JSON.parse(readFileSync(campaignPath, 'utf8')) as Record<string, unknown>;
    delete campaign.last_ranking;
    (campaign.usage as Record<string, unknown>).steps_used = 0;
    writeFileSync(campaignPath, JSON.stringify(campaign));

    const retry = rank(service, campaignId, 'rank-crash');
    expect((retry.idempotency as Record<string, unknown>).is_replay).toBe(true);
    expect((retry.budget_snapshot as Record<string, unknown>).steps_used).toBe(1);
    const recovered = JSON.parse(readFileSync(campaignPath, 'utf8')) as Record<string, unknown>;
    expect((recovered.usage as Record<string, unknown>).steps_used).toBe(1);
    expect((recovered.last_ranking as Record<string, unknown>).ranking_artifact_ref).toBe(first.ranking_artifact_ref);

    // The restored pointer serves reuse for the next fresh-key call.
    const after = rank(service, campaignId, 'rank-after-recovery');
    expect(after.unchanged_since).toBe(first.generated_at);
    expect(after.ranking_artifact_ref).toBe(first.ranking_artifact_ref);
  });

  it('a different filter recomputes even on an unchanged store', () => {
    const { service } = freshAdvancing('idea-rank-filter-');
    const { campaignId, nodeIds } = initCampaign(service, { seedCount: 2 });
    admitNode(service, campaignId, nodeIds[0]!, { value: 0.9 });
    admitNode(service, campaignId, nodeIds[1]!, { value: 0.6 });
    const unfiltered = rank(service, campaignId, 'rank-1');
    const filtered = service.handle('rank.compute', {
      campaign_id: campaignId,
      method: 'posterior',
      filter: { node_id: nodeIds[0]! },
      idempotency_key: 'rank-3',
    });
    expect(filtered.store_digest).not.toBe(unfiltered.store_digest);
  });
});

describe('tie groups and row titles', () => {
  it('marks complete-sort-key ties as an uninformative-order group pointing at pairwise comparison', () => {
    const { service } = freshAdvancing('idea-rank-tie-');
    const { campaignId, nodeIds } = initCampaign(service, { seedCount: 3 });
    const [a, b, c] = nodeIds as [string, string, string];
    admitNode(service, campaignId, a, { evidenceCount: 6, value: 0.7041322397527323 });
    admitNode(service, campaignId, b, { evidenceCount: 6, value: 0.7041322397527323 });
    admitNode(service, campaignId, c, { evidenceCount: 6, value: 0.9 });

    const result = service.handle('rank.compute', { campaign_id: campaignId, method: 'posterior', idempotency_key: 'rank-tie' }) as {
      ranked_nodes: Array<Record<string, unknown>>;
      tie_groups?: Array<Record<string, unknown>>;
    };
    const tieGroups = result.tie_groups ?? [];
    expect(tieGroups).toHaveLength(1);
    const group = tieGroups[0]!;
    expect(group.within_group_order_informative).toBe(false);
    expect(group.suggested_discriminator).toBe('pairwise_match');
    expect(new Set(group.node_ids as string[])).toEqual(new Set([a, b]));

    const tiedRows = result.ranked_nodes.filter(row => row.tie_group_id === group.tie_group_id);
    expect(tiedRows).toHaveLength(2);
    expect(result.ranked_nodes[0]!.tie_group_id).toBeUndefined();
    for (const row of result.ranked_nodes) {
      expect(typeof row.title).toBe('string');
      expect(String(row.title).length).toBeGreaterThan(0);
    }
  });

  it('rows equal only on posterior value are not grouped: the evidence tiebreak is informative', () => {
    const { service } = freshAdvancing('idea-rank-notie-');
    const { campaignId, nodeIds } = initCampaign(service, { seedCount: 2 });
    admitNode(service, campaignId, nodeIds[0]!, { evidenceCount: 8, value: 0.7 });
    admitNode(service, campaignId, nodeIds[1]!, { evidenceCount: 3, value: 0.7 });
    const result = service.handle('rank.compute', { campaign_id: campaignId, method: 'posterior', idempotency_key: 'rank-notie' }) as {
      ranked_nodes: Array<Record<string, unknown>>;
      tie_groups?: Array<Record<string, unknown>>;
    };
    expect(result.tie_groups).toBeUndefined();
    for (const row of result.ranked_nodes) expect(row.tie_group_id).toBeUndefined();
  });
});

describe('node.apply_evidence_event', () => {
  const EVIDENCE_REF = `project://artifacts/runs/lane-report.json#sha256:${'a'.repeat(64)}`;

  it('applies one evidence event to several nodes atomically with an engine-recorded group binding', () => {
    const { service } = freshAdvancing('idea-evt-');
    const { campaignId, nodeIds } = initCampaign(service, { seedCount: 3 });
    const [demoted, blocked, archived] = nodeIds as [string, string, string];
    admitNode(service, campaignId, demoted, { value: 0.9 });
    admitNode(service, campaignId, blocked, { value: 0.8 });
    admitNode(service, campaignId, archived, { value: 0.7 });

    const result = service.handle('node.apply_evidence_event', {
      campaign_id: campaignId,
      evidence_ref: EVIDENCE_REF,
      event_reason: 'one lane result supersedes the shared assumption behind these nodes',
      dispositions: [
        { node_id: demoted, lifecycle_state: 'needs_refresh' },
        {
          node_id: blocked,
          lifecycle_state: 'admission_blocked',
          reason: 'missing the follow-up computation',
          activation_condition: { kind: 'required_evidence', description: 'the follow-up computation', satisfied: false },
        },
        { node_id: archived, lifecycle_state: 'archived', reason: 'superseded outright' },
      ],
      idempotency_key: 'evt-1',
    }) as { event_group: string; nodes: Array<Record<string, unknown>> };

    expect(result.event_group).toMatch(/^evt-[0-9a-f]{12}$/);
    expect(result.nodes).toHaveLength(3);
    for (const row of result.nodes) {
      expect(row.posterior_marked_stale).toBe(true);
    }
    expect(storedNode(service, campaignId, demoted).lifecycle_state).toBe('needs_refresh');
    expect(storedNode(service, campaignId, demoted).lifecycle_reason).toBe(
      'one lane result supersedes the shared assumption behind these nodes',
    );
    expect(storedNode(service, campaignId, blocked).lifecycle_reason).toBe('missing the follow-up computation');
    expect(storedPosterior(service, campaignId, demoted).status).toBe('stale');
    expect(storedPosterior(service, campaignId, archived).status).toBe('stale');

    const entries = service.read.store.loadNodeLogEntriesStrict(campaignId).slice(-3);
    for (const entry of entries) {
      expect(entry.mutation).toBe('apply_evidence_event');
      expect(entry.event_group).toBe(result.event_group);
      expect(entry.evidence_ref).toBe(EVIDENCE_REF);
    }

    const replay = service.handle('node.apply_evidence_event', {
      campaign_id: campaignId,
      evidence_ref: EVIDENCE_REF,
      event_reason: 'one lane result supersedes the shared assumption behind these nodes',
      dispositions: [
        { node_id: demoted, lifecycle_state: 'needs_refresh' },
        {
          node_id: blocked,
          lifecycle_state: 'admission_blocked',
          reason: 'missing the follow-up computation',
          activation_condition: { kind: 'required_evidence', description: 'the follow-up computation', satisfied: false },
        },
        { node_id: archived, lifecycle_state: 'archived', reason: 'superseded outright' },
      ],
      idempotency_key: 'evt-1',
    }) as { event_group: string; idempotency: Record<string, unknown> };
    expect(replay.idempotency.is_replay).toBe(true);
    expect(replay.event_group).toBe(result.event_group);
  });

  it('reports every failing disposition at once and applies nothing', () => {
    const { service } = freshAdvancing('idea-evt-fail-');
    const { campaignId, nodeIds } = initCampaign(service, { seedCount: 3 });
    const [good, badTransition, badReason] = nodeIds as [string, string, string];
    admitNode(service, campaignId, good, { value: 0.9 });
    admitNode(service, campaignId, badReason, { value: 0.6 });
    // badTransition stays candidate: candidate -> needs_refresh is illegal.

    const error = expectRpcError(
      () => service.handle('node.apply_evidence_event', {
        campaign_id: campaignId,
        evidence_ref: EVIDENCE_REF,
        event_reason: 'shared cause',
        dispositions: [
          { node_id: good, lifecycle_state: 'needs_refresh' },
          { node_id: badTransition, lifecycle_state: 'needs_refresh' },
          { node_id: badReason, lifecycle_state: 'archived' },
        ],
        idempotency_key: 'evt-bad',
      }),
      -32018,
      'batch_dispositions_invalid',
    );
    const failures = (error.data.details as { failures: Array<Record<string, unknown>> }).failures;
    expect(failures).toHaveLength(2);
    expect(failures.map(f => f.check).sort()).toEqual(['archived_reason_required', 'illegal_transition']);
    // Nothing applied — including the valid disposition.
    expect(storedNode(service, campaignId, good).lifecycle_state).toBe('admitted');
    expect(storedPosterior(service, campaignId, good).status).toBe('current');
  });

  it('rejects machine-absolute and traversal-shaped evidence references', () => {
    const { service } = freshAdvancing('idea-evt-refshape-');
    const { campaignId, nodeIds } = initCampaign(service);
    const nodeId = nodeIds[0]!;
    admitNode(service, campaignId, nodeId);
    for (const [key, badRef] of [
      ['evt-abs', `project:///etc/passwd#sha256:${'a'.repeat(64)}`],
      ['evt-dotdot', `project://artifacts/../../secrets.json#sha256:${'a'.repeat(64)}`],
      ['evt-empty-seg', `project://artifacts//report.json#sha256:${'a'.repeat(64)}`],
      ['evt-enc-dotdot', `project://artifacts/%2e%2e/secrets.json#sha256:${'a'.repeat(64)}`],
      ['evt-enc-slash', `project://artifacts/bad%2Fslash.json#sha256:${'a'.repeat(64)}`],
      ['evt-backslash', `project://artifacts/back%5Cslash.json#sha256:${'a'.repeat(64)}`],
      ['evt-drive', `project://C:/windows-form.json#sha256:${'a'.repeat(64)}`],
      ['evt-enc-colon', `project://artifacts/drive%3Aform.json#sha256:${'a'.repeat(64)}`],
      ['evt-bad-pct', `project://artifacts/broken%zz.json#sha256:${'a'.repeat(64)}`],
      ['evt-raw-backslash', `project://artifacts/raw\\slash.json#sha256:${'a'.repeat(64)}`],
      ['evt-dot-seg', `project://artifacts/./report.json#sha256:${'a'.repeat(64)}`],
      ['evt-empty-path', `project://#sha256:${'a'.repeat(64)}`],
    ] as const) {
      expectRpcError(
        () => service.handle('node.apply_evidence_event', {
          campaign_id: campaignId,
          evidence_ref: badRef,
          event_reason: 'shared cause',
          dispositions: [{ node_id: nodeId, lifecycle_state: 'needs_refresh' }],
          idempotency_key: key,
        }),
        -32002,
        'schema_invalid',
      );
    }
    expect(storedNode(service, campaignId, nodeId).lifecycle_state).toBe('admitted');
    // A legitimate percent-encoded space stays accepted.
    const ok = service.handle('node.apply_evidence_event', {
      campaign_id: campaignId,
      evidence_ref: `project://artifacts/with%20space.json#sha256:${'a'.repeat(64)}`,
      event_reason: 'shared cause',
      dispositions: [{ node_id: nodeId, lifecycle_state: 'needs_refresh' }],
      idempotency_key: 'evt-space-ok',
    }) as { nodes: Array<Record<string, unknown>> };
    expect(ok.nodes[0]!.lifecycle_state).toBe('needs_refresh');
  });

  it('recovers a crash that lost ledger lines: completes the event-group binding and replays', () => {
    const { rootDir, service } = freshAdvancing('idea-evt-recover-');
    const { campaignId, nodeIds } = initCampaign(service, { seedCount: 2 });
    const [a, b] = nodeIds as [string, string];
    admitNode(service, campaignId, a);
    admitNode(service, campaignId, b);
    const params = {
      campaign_id: campaignId,
      evidence_ref: EVIDENCE_REF,
      event_reason: 'one result supersedes the shared assumption',
      dispositions: [
        { node_id: a, lifecycle_state: 'needs_refresh' },
        { node_id: b, lifecycle_state: 'needs_refresh' },
      ],
      idempotency_key: 'evt-crash',
    };
    const first = service.handle('node.apply_evidence_event', params) as { event_group: string };

    // Simulate the crash window after saveNodes with every event ledger line
    // lost and the idempotency record still prepared.
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['node.apply_evidence_event:evt-crash']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));
    const logPath = resolve(campaignDir, 'nodes_log.jsonl');
    const keptLines = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0 && !line.includes('apply_evidence_event'));
    writeFileSync(logPath, `${keptLines.join('\n')}\n`);

    const retry = service.handle('node.apply_evidence_event', params) as {
      event_group: string;
      idempotency: Record<string, unknown>;
      nodes: Array<Record<string, unknown>>;
    };
    expect(retry.idempotency.is_replay).toBe(true);
    expect(retry.event_group).toBe(first.event_group);
    const eventLines = service.read.store.loadNodeLogEntriesStrict(campaignId)
      .filter(entry => entry.mutation === 'apply_evidence_event' && entry.event_group === first.event_group);
    expect(eventLines).toHaveLength(2);
    for (const entry of eventLines) {
      expect(entry.evidence_ref).toBe(EVIDENCE_REF);
      expect(entry.reason).toBe('one result supersedes the shared assumption');
    }
    // Node states untouched by recovery: still exactly one transition.
    expect(storedNode(service, campaignId, a).lifecycle_state).toBe('needs_refresh');
    expect(Number(storedNode(service, campaignId, a).revision)).toBe(Number(retry.nodes[0]!.revision));
  });

  it('derives the event group from the idempotency key and payload hash', () => {
    const { service } = freshAdvancing('idea-evt-group-');
    const { campaignId, nodeIds } = initCampaign(service);
    admitNode(service, campaignId, nodeIds[0]!);
    const result = service.handle('node.apply_evidence_event', {
      campaign_id: campaignId,
      evidence_ref: EVIDENCE_REF,
      event_reason: 'the shared assumption fails',
      dispositions: [{ node_id: nodeIds[0]!, lifecycle_state: 'needs_refresh' }],
      idempotency_key: 'evt-key-derivation',
    }) as { event_group: string; idempotency: { payload_hash: string } };
    const expected = `evt-${createHash('sha256')
      .update(`evt-key-derivation:${result.idempotency.payload_hash}`, 'utf8')
      .digest('hex')
      .slice(0, 12)}`;
    expect(result.event_group).toBe(expected);
  });

  it('refuses to certify a prepared event when a same-timestamp twin wrote the same nodes', () => {
    // Production clocks have one-second resolution: two DISTINCT events can
    // stamp the same updated_at. A row match alone must not certify ours
    // when another event's ledger line covers the node at that timestamp.
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-evt-twin-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({
      rootDir,
      now: () => '2026-07-21T07:30:00Z',
    });
    const { campaignId, nodeIds } = initCampaign(service);
    const nodeId = nodeIds[0]!;
    admitNode(service, campaignId, nodeId);
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const nodesPath = resolve(campaignDir, 'nodes_latest.json');
    const preBatchNodes = readFileSync(nodesPath, 'utf8');
    const logPath = resolve(campaignDir, 'nodes_log.jsonl');
    const preBatchLog = readFileSync(logPath, 'utf8');

    const eventA = {
      campaign_id: campaignId,
      evidence_ref: EVIDENCE_REF,
      event_reason: 'shared supersession cause',
      dispositions: [{ node_id: nodeId, lifecycle_state: 'needs_refresh' }],
      idempotency_key: 'evt-twin-a',
    };
    service.handle('node.apply_evidence_event', eventA);

    // Rewind to the pre-A state with A's record left prepared (crash before
    // saveNodes), then land twin event B fully at the same frozen second.
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['node.apply_evidence_event:evt-twin-a']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));
    writeFileSync(nodesPath, preBatchNodes);
    writeFileSync(logPath, preBatchLog);
    service.handle('node.apply_evidence_event', {
      ...eventA,
      evidence_ref: `project://artifacts/runs/other-report.json#sha256:${'b'.repeat(64)}`,
      idempotency_key: 'evt-twin-b',
    });

    expectRpcError(
      () => service.handle('node.apply_evidence_event', eventA),
      -32603,
      'evidence_event_recovery_conflict',
    );
  });

  it('detects the twin through its idempotency record even when the twin\'s ledger lines are lost', () => {
    // The twin's prepared record exists BEFORE its node write, so the twin
    // case stays decidable when the crash also lost the twin's ledger
    // lines: rows matching + a foreign record covering the node at the same
    // timestamp = ambiguity, fail loud.
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-evt-twinrec-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({
      rootDir,
      now: () => '2026-07-21T07:30:00Z',
    });
    const { campaignId, nodeIds } = initCampaign(service);
    const nodeId = nodeIds[0]!;
    admitNode(service, campaignId, nodeId);
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const nodesPath = resolve(campaignDir, 'nodes_latest.json');
    const preBatchNodes = readFileSync(nodesPath, 'utf8');
    const logPath = resolve(campaignDir, 'nodes_log.jsonl');
    const preBatchLog = readFileSync(logPath, 'utf8');

    const eventA = {
      campaign_id: campaignId,
      evidence_ref: EVIDENCE_REF,
      event_reason: 'shared supersession cause',
      dispositions: [{ node_id: nodeId, lifecycle_state: 'needs_refresh' }],
      idempotency_key: 'evt-twinrec-a',
    };
    service.handle('node.apply_evidence_event', eventA);

    // A prepared with nothing landed; twin B lands its NODE write but loses
    // every ledger line (crash right after saveNodes).
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    let idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['node.apply_evidence_event:evt-twinrec-a']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));
    writeFileSync(nodesPath, preBatchNodes);
    writeFileSync(logPath, preBatchLog);
    service.handle('node.apply_evidence_event', {
      ...eventA,
      evidence_ref: `project://artifacts/runs/other-report.json#sha256:${'b'.repeat(64)}`,
      idempotency_key: 'evt-twinrec-b',
    });
    // Strip B's ledger lines (B's node write and idempotency record remain).
    const withB = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0 && !line.includes('apply_evidence_event'));
    writeFileSync(logPath, `${withB.join('\n')}\n`);
    idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['node.apply_evidence_event:evt-twinrec-b']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));

    expectRpcError(
      () => service.handle('node.apply_evidence_event', eventA),
      -32603,
      'evidence_event_recovery_conflict',
    );
  });

  it('repairs a torn final ledger line during recovery', () => {
    const { rootDir, service } = freshAdvancing('idea-evt-torn-');
    const { campaignId, nodeIds } = initCampaign(service, { seedCount: 2 });
    const [a, b] = nodeIds as [string, string];
    admitNode(service, campaignId, a);
    admitNode(service, campaignId, b);
    const params = {
      campaign_id: campaignId,
      evidence_ref: EVIDENCE_REF,
      event_reason: 'one result supersedes the shared assumption',
      dispositions: [
        { node_id: a, lifecycle_state: 'needs_refresh' },
        { node_id: b, lifecycle_state: 'needs_refresh' },
      ],
      idempotency_key: 'evt-torn',
    };
    const first = service.handle('node.apply_evidence_event', params) as { event_group: string };

    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['node.apply_evidence_event:evt-torn']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));
    // Tear the final ledger line (the SECOND node's entry) past its
    // event_group value: the fragment is attributable beyond doubt, and it
    // already diverges from the first row at node_id — the repair loop must
    // move past row one's non-prefix candidate to row two's.
    const logPath = resolve(campaignDir, 'nodes_log.jsonl');
    const raw = readFileSync(logPath, 'utf8');
    const lines = raw.split('\n').filter(line => line.trim().length > 0);
    const lastLine = lines.at(-1)!;
    // Cut exactly at the end of the fixed-length group id (before the
    // closing quote): attribution is already beyond doubt there.
    const cut = lastLine.indexOf(first.event_group) + first.event_group.length;
    const torn = [...lines.slice(0, -1), lastLine.slice(0, cut)].join('\n');
    writeFileSync(logPath, torn);

    const retry = service.handle('node.apply_evidence_event', params) as {
      idempotency: Record<string, unknown>;
    };
    expect(retry.idempotency.is_replay).toBe(true);
    const eventLines = service.read.store.loadNodeLogEntriesStrict(campaignId)
      .filter(entry => entry.mutation === 'apply_evidence_event' && entry.event_group === first.event_group);
    expect(eventLines).toHaveLength(2);
  });

  it('refuses to repair a torn fragment that does not carry this event\'s group id', () => {
    // A short fragment is a byte prefix of MANY events' entries: repairing
    // it with our entry could replace another event's torn line with our
    // provenance. Attribution requires the group id; without it the log
    // stays fail-closed.
    const { rootDir, service } = freshAdvancing('idea-evt-torn-short-');
    const { campaignId, nodeIds } = initCampaign(service);
    const nodeId = nodeIds[0]!;
    admitNode(service, campaignId, nodeId);
    const params = {
      campaign_id: campaignId,
      evidence_ref: EVIDENCE_REF,
      event_reason: 'the shared assumption fails',
      dispositions: [{ node_id: nodeId, lifecycle_state: 'needs_refresh' }],
      idempotency_key: 'evt-torn-short',
    };
    service.handle('node.apply_evidence_event', params);
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['node.apply_evidence_event:evt-torn-short']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));
    const logPath = resolve(campaignDir, 'nodes_log.jsonl');
    const raw = readFileSync(logPath, 'utf8');
    const lines = raw.split('\n').filter(line => line.trim().length > 0);
    const torn = [...lines.slice(0, -1), lines.at(-1)!.slice(0, 40)].join('\n');
    writeFileSync(logPath, torn);

    expectRpcError(
      () => service.handle('node.apply_evidence_event', params),
      -32002,
      'schema_invalid',
    );
  });

  it('reports every bad parameter in one round', () => {
    const { service } = freshAdvancing('idea-evt-params-');
    const { campaignId, nodeIds } = initCampaign(service);
    admitNode(service, campaignId, nodeIds[0]!);
    const error = expectRpcError(
      () => service.handle('node.apply_evidence_event', {
        campaign_id: campaignId,
        evidence_ref: 'not-a-portable-ref',
        event_reason: '',
        dispositions: [{ node_id: nodeIds[0]!, lifecycle_state: 'needs_refresh' }],
        idempotency_key: 'evt-badparams',
      }),
      -32002,
      'schema_invalid',
    );
    const message = String((error.data.details as Record<string, unknown>).message);
    expect(message).toContain("param 'evidence_ref'");
    expect(message).toContain("param 'event_reason'");
  });

  it('reports missing, unknown, and invalid parameters together in one round', () => {
    const { service } = freshAdvancing('idea-evt-allparams-');
    const { campaignId, nodeIds } = initCampaign(service);
    admitNode(service, campaignId, nodeIds[0]!);
    const error = expectRpcError(
      () => service.handle('node.apply_evidence_event', {
        // campaign_id omitted (missing), stray parameter (unknown), plus two
        // invalid present parameters: the complete list arrives in ONE error.
        stray_parameter: true,
        evidence_ref: 'not-a-portable-ref',
        event_reason: '',
        dispositions: [{ node_id: nodeIds[0]!, lifecycle_state: 'needs_refresh' }],
        idempotency_key: 'evt-allparams',
      }),
      -32002,
      'schema_invalid',
    );
    const message = String((error.data.details as Record<string, unknown>).message);
    expect(message).toContain('missing required params: campaign_id');
    expect(message).toContain('unknown params: stray_parameter');
    expect(message).toContain("param 'evidence_ref'");
    expect(message).toContain("param 'event_reason'");
    expect(storedNode(service, campaignId, nodeIds[0]!).lifecycle_state).toBe('admitted');
  });

  it('fails loud when a same-tuple set_lifecycle twin could explain the stored state', () => {
    // The natural operator move after a failed batch call is a hand
    // set_lifecycle retry with the same reason — a foreign writer OUTSIDE
    // the apply method. When its written state is indistinguishable from
    // our rows, certification must fail loud, not fabricate our line over
    // the hand-applied transition.
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-evt-lifecycle-twin-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({
      rootDir,
      now: () => '2026-07-21T07:30:00Z',
    });
    const { campaignId, nodeIds } = initCampaign(service);
    const nodeId = nodeIds[0]!;
    admitNode(service, campaignId, nodeId);
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const nodesPath = resolve(campaignDir, 'nodes_latest.json');
    const preBatchNodes = readFileSync(nodesPath, 'utf8');
    const logPath = resolve(campaignDir, 'nodes_log.jsonl');
    const preBatchLog = readFileSync(logPath, 'utf8');

    const eventA = {
      campaign_id: campaignId,
      evidence_ref: EVIDENCE_REF,
      event_reason: 'shared supersession cause',
      dispositions: [{ node_id: nodeId, lifecycle_state: 'needs_refresh' }],
      idempotency_key: 'evt-lc-twin-a',
    };
    service.handle('node.apply_evidence_event', eventA);
    // Rewind to pre-A with A prepared (crash before saveNodes); the
    // operator hand-applies the identical demotion via set_lifecycle.
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['node.apply_evidence_event:evt-lc-twin-a']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));
    writeFileSync(nodesPath, preBatchNodes);
    writeFileSync(logPath, preBatchLog);
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      node_id: nodeId,
      lifecycle_state: 'needs_refresh',
      reason: 'shared supersession cause',
      idempotency_key: 'hand-retry',
    });

    expectRpcError(
      () => service.handle('node.apply_evidence_event', eventA),
      -32603,
      'evidence_event_recovery_conflict',
    );
  });

  function syntheticRewriteRecord(campaignId: string, nodeId: string, row: Record<string, unknown>): Record<string, unknown> {
    // Schema-faithful provenance_rewrite_result_v1 payload (field enum value
    // and full budget snapshot included).
    return {
      payload_hash: `sha256:${'d'.repeat(64)}`,
      created_at: String(row.updated_at),
      state: 'committed',
      response: {
        kind: 'result',
        payload: {
          campaign_id: campaignId,
          node_id: nodeId,
          idea_id: 'aaaaaaaa',
          field: 'novelty_delta.closest_prior',
          previous_value: 'prior-a',
          new_value: 'prior-b',
          delta_claim_updated: false,
          grounding_audit_reset: false,
          revision: row.revision,
          updated_at: row.updated_at,
          budget_snapshot: { steps_used: 0, steps_remaining: 20, nodes_used: 1, nodes_remaining: 19 },
          idempotency: { idempotency_key: 'synthetic-rewrite', is_replay: false, payload_hash: `sha256:${'d'.repeat(64)}` },
        },
      },
    };
  }

  it('fails loud when a flat rewrite record could explain a SELF-TRANSITION row', () => {
    // node.rewrite_provenance preserves the lifecycle state while advancing
    // revision and timestamp, so it can only explain a row whose transition
    // left the state unchanged. For such a row, an exact
    // (node, timestamp, revision) record hit is a plausible alternative
    // explanation and must raise the conflict.
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-evt-rewrite-twin-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({
      rootDir,
      now: () => '2026-07-21T07:30:00Z',
    });
    const { campaignId, nodeIds } = initCampaign(service);
    const nodeId = nodeIds[0]!;
    admitNode(service, campaignId, nodeId);
    const condition = { kind: 'required_evidence', description: 'the follow-up computation', satisfied: false } as const;
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      node_id: nodeId,
      lifecycle_state: 'admission_blocked',
      reason: 'missing evidence',
      activation_condition: condition,
      idempotency_key: 'block-first',
    });
    // Self-transition: blocked -> blocked, re-asserting the same condition.
    const params = {
      campaign_id: campaignId,
      evidence_ref: EVIDENCE_REF,
      event_reason: 'condition re-confirmed by the evidence artifact',
      dispositions: [{ node_id: nodeId, lifecycle_state: 'admission_blocked', activation_condition: condition }],
      idempotency_key: 'evt-rw-twin',
    };
    const first = service.handle('node.apply_evidence_event', params) as {
      nodes: Array<Record<string, unknown>>;
    };
    const row = first.nodes[0]!;

    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, Record<string, unknown>>;
    idem['node.apply_evidence_event:evt-rw-twin']!.state = 'prepared';
    idem['node.rewrite_provenance:synthetic-rewrite'] = syntheticRewriteRecord(campaignId, nodeId, row);
    writeFileSync(idemPath, JSON.stringify(idem));
    const logPath = resolve(campaignDir, 'nodes_log.jsonl');
    const kept = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0 && !line.includes('apply_evidence_event'));
    writeFileSync(logPath, `${kept.join('\n')}\n`);

    expectRpcError(
      () => service.handle('node.apply_evidence_event', params),
      -32603,
      'evidence_event_recovery_conflict',
    );
  });

  it('does not conflict on a flat rewrite record when the row is a real transition', () => {
    // A demoting row (admitted -> needs_refresh) is causally beyond a
    // rewrite, which preserves the lifecycle state: the flat record must
    // not block the legitimate recovery.
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-evt-rewrite-fp-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({
      rootDir,
      now: () => '2026-07-21T07:30:00Z',
    });
    const { campaignId, nodeIds } = initCampaign(service);
    const nodeId = nodeIds[0]!;
    admitNode(service, campaignId, nodeId);
    const params = {
      campaign_id: campaignId,
      evidence_ref: EVIDENCE_REF,
      event_reason: 'shared supersession cause',
      dispositions: [{ node_id: nodeId, lifecycle_state: 'needs_refresh' }],
      idempotency_key: 'evt-rw-fp',
    };
    const first = service.handle('node.apply_evidence_event', params) as {
      event_group: string;
      nodes: Array<Record<string, unknown>>;
    };
    const row = first.nodes[0]!;
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, Record<string, unknown>>;
    idem['node.apply_evidence_event:evt-rw-fp']!.state = 'prepared';
    idem['node.rewrite_provenance:synthetic-rewrite'] = syntheticRewriteRecord(campaignId, nodeId, row);
    writeFileSync(idemPath, JSON.stringify(idem));
    const logPath = resolve(campaignDir, 'nodes_log.jsonl');
    const kept = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0 && !line.includes('apply_evidence_event'));
    writeFileSync(logPath, `${kept.join('\n')}\n`);

    const retry = service.handle('node.apply_evidence_event', params) as {
      idempotency: Record<string, unknown>;
    };
    expect(retry.idempotency.is_replay).toBe(true);
    const restored = service.read.store.loadNodeLogEntriesStrict(campaignId)
      .filter(entry => entry.mutation === 'apply_evidence_event' && entry.event_group === first.event_group);
    expect(restored).toHaveLength(1);
  });

  it('recovers honestly when a set_lifecycle twin wrote a DIFFERENT activation condition', () => {
    // Same second, same state/reason/revision, but the hand-applied write
    // recorded a different condition: the complete-state witness sees the
    // difference, reads "nothing of ours landed", and re-executes cleanly —
    // the final store carries OUR condition via the legal self-transition,
    // with both mutations honestly on the ledger.
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-evt-cond-twin-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({
      rootDir,
      now: () => '2026-07-21T07:30:00Z',
    });
    const { campaignId, nodeIds } = initCampaign(service);
    const nodeId = nodeIds[0]!;
    admitNode(service, campaignId, nodeId);
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const nodesPath = resolve(campaignDir, 'nodes_latest.json');
    const preBatchNodes = readFileSync(nodesPath, 'utf8');
    const logPath = resolve(campaignDir, 'nodes_log.jsonl');
    const preBatchLog = readFileSync(logPath, 'utf8');

    const eventA = {
      campaign_id: campaignId,
      evidence_ref: EVIDENCE_REF,
      event_reason: 'missing follow-up computation',
      dispositions: [{
        node_id: nodeId,
        lifecycle_state: 'admission_blocked',
        activation_condition: { kind: 'required_evidence', description: 'the follow-up computation from event A', satisfied: false },
      }],
      idempotency_key: 'evt-cond-a',
    };
    service.handle('node.apply_evidence_event', eventA);
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['node.apply_evidence_event:evt-cond-a']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));
    writeFileSync(nodesPath, preBatchNodes);
    writeFileSync(logPath, preBatchLog);
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      node_id: nodeId,
      lifecycle_state: 'admission_blocked',
      reason: 'missing follow-up computation',
      activation_condition: { kind: 'required_evidence', description: 'a DIFFERENT condition from the hand retry', satisfied: false },
      idempotency_key: 'hand-retry-cond',
    });

    const retry = service.handle('node.apply_evidence_event', eventA) as {
      idempotency: Record<string, unknown>;
    };
    expect(retry.idempotency.is_replay).toBe(false);
    const node = storedNode(service, campaignId, nodeId);
    expect((node.activation_condition as Record<string, unknown>).description)
      .toBe('the follow-up computation from event A');
  });

  it('does not conflict on a foreign same-second record whose write cannot explain the stored state', () => {
    // A foreign event that touched the same node in the same second but
    // with a DIFFERENT resulting tuple (state/revision/reason) cannot be
    // what the store shows — it must not block a legitimate recovery.
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-evt-difftuple-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({
      rootDir,
      now: () => '2026-07-21T07:30:00Z',
    });
    const { campaignId, nodeIds } = initCampaign(service);
    const nodeId = nodeIds[0]!;
    // Foreign event B: candidate -> admission_review (legal disposition),
    // commits fully at the frozen second.
    service.handle('node.apply_evidence_event', {
      campaign_id: campaignId,
      evidence_ref: `project://artifacts/runs/intake-report.json#sha256:${'b'.repeat(64)}`,
      event_reason: 'intake review opens',
      dispositions: [{ node_id: nodeId, lifecycle_state: 'admission_review' }],
      idempotency_key: 'evt-intake-b',
    });
    // The node then gains a current posterior (admitted) at the same second.
    service.handle('node.set_posterior', {
      campaign_id: campaignId,
      node_id: nodeId,
      posterior: { value: 0.7, evidence_count: 6, status: 'current' },
      literature_coverage: {
        status: 'saturated',
        survey_ref: 'project://literature/survey.json',
        close_prior_matrix_ref: 'project://literature/close-prior.json',
      },
      idempotency_key: 'posterior-difftuple',
    });
    // Our event A demotes it; simulate A's crash losing its ledger lines.
    const paramsA = {
      campaign_id: campaignId,
      evidence_ref: EVIDENCE_REF,
      event_reason: 'the shared assumption fails',
      dispositions: [{ node_id: nodeId, lifecycle_state: 'needs_refresh' }],
      idempotency_key: 'evt-demote-a',
    };
    const first = service.handle('node.apply_evidence_event', paramsA) as { event_group: string };
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['node.apply_evidence_event:evt-demote-a']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));
    const logPath = resolve(campaignDir, 'nodes_log.jsonl');
    const kept = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0 && !line.includes(first.event_group));
    writeFileSync(logPath, `${kept.join('\n')}\n`);

    // B's record covers the same node at the same second, but its tuple
    // (admission_review, earlier revision) cannot explain the stored
    // needs_refresh state: recovery completes and replays instead of
    // conflicting.
    const retry = service.handle('node.apply_evidence_event', paramsA) as {
      idempotency: Record<string, unknown>;
    };
    expect(retry.idempotency.is_replay).toBe(true);
    const restored = service.read.store.loadNodeLogEntriesStrict(campaignId)
      .filter(entry => entry.mutation === 'apply_evidence_event' && entry.event_group === first.event_group);
    expect(restored).toHaveLength(1);
  });

  it('re-executes safely when nothing landed before the crash', () => {
    const { rootDir, service } = freshAdvancing('idea-evt-nothing-');
    const { campaignId, nodeIds } = initCampaign(service);
    const nodeId = nodeIds[0]!;
    admitNode(service, campaignId, nodeId);
    const campaignDir = resolve(rootDir, 'campaigns', campaignId);
    const nodesPath = resolve(campaignDir, 'nodes_latest.json');
    const preBatchNodes = readFileSync(nodesPath, 'utf8');
    const params = {
      campaign_id: campaignId,
      evidence_ref: EVIDENCE_REF,
      event_reason: 'the shared assumption fails',
      dispositions: [{ node_id: nodeId, lifecycle_state: 'needs_refresh' }],
      idempotency_key: 'evt-none',
    };
    service.handle('node.apply_evidence_event', params);

    // Roll the store back to the pre-batch state, keep the record prepared,
    // and strip the event ledger lines: the probe must read "nothing landed"
    // and re-execute cleanly.
    const idemPath = resolve(campaignDir, 'idempotency_store.json');
    const idem = JSON.parse(readFileSync(idemPath, 'utf8')) as Record<string, { state: string }>;
    idem['node.apply_evidence_event:evt-none']!.state = 'prepared';
    writeFileSync(idemPath, JSON.stringify(idem));
    writeFileSync(nodesPath, preBatchNodes);
    const logPath = resolve(campaignDir, 'nodes_log.jsonl');
    const keptLines = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0 && !line.includes('apply_evidence_event'));
    writeFileSync(logPath, `${keptLines.join('\n')}\n`);

    const retry = service.handle('node.apply_evidence_event', params) as {
      idempotency: Record<string, unknown>;
    };
    expect(retry.idempotency.is_replay).toBe(false);
    expect(storedNode(service, campaignId, nodeId).lifecycle_state).toBe('needs_refresh');
    expect(storedPosterior(service, campaignId, nodeId).status).toBe('stale');
  });

  it('rejects duplicate nodes and non-portable evidence references', () => {
    const { service } = freshAdvancing('idea-evt-shape-');
    const { campaignId, nodeIds } = initCampaign(service);
    const nodeId = nodeIds[0]!;
    admitNode(service, campaignId, nodeId);

    const duplicateError = expectRpcError(
      () => service.handle('node.apply_evidence_event', {
        campaign_id: campaignId,
        evidence_ref: EVIDENCE_REF,
        event_reason: 'shared cause',
        dispositions: [
          { node_id: nodeId, lifecycle_state: 'needs_refresh' },
          { node_id: nodeId, lifecycle_state: 'archived', reason: 'twice' },
        ],
        idempotency_key: 'evt-dup',
      }),
      -32018,
      'batch_dispositions_invalid',
    );
    const failures = (duplicateError.data.details as { failures: Array<Record<string, unknown>> }).failures;
    expect(failures.some(f => f.check === 'duplicate_disposition_node')).toBe(true);

    expectRpcError(
      () => service.handle('node.apply_evidence_event', {
        campaign_id: campaignId,
        evidence_ref: `file:///Users/nobody/report.json#sha256:${'a'.repeat(64)}`,
        event_reason: 'shared cause',
        dispositions: [{ node_id: nodeId, lifecycle_state: 'needs_refresh' }],
        idempotency_key: 'evt-fileref',
      }),
      -32002,
      'schema_invalid',
    );
  });
});

describe('undeclared budget dimensions', () => {
  it('are absent from snapshots and reject topups; declared dimensions still render', () => {
    const { service } = freshAdvancing('idea-budget-');
    const { campaignId } = initCampaign(service, {
      budget: { max_nodes: 20, max_steps: 20 },
    });

    const status = service.handle('campaign.status', { campaign_id: campaignId }) as {
      budget_snapshot: Record<string, unknown>;
    };
    for (const absent of [
      'tokens_used', 'tokens_remaining',
      'cost_usd_used', 'cost_usd_remaining',
      'wall_clock_s_elapsed', 'wall_clock_s_remaining',
    ]) {
      expect(status.budget_snapshot).not.toHaveProperty(absent);
    }
    expect(status.budget_snapshot.steps_used).toBe(0);
    expect(status.budget_snapshot.nodes_used).toBe(1);

    expectRpcError(
      () => service.handle('campaign.topup', {
        campaign_id: campaignId,
        topup: { add_tokens: 1000 },
        idempotency_key: 'topup-undeclared',
      }),
      -32002,
      'schema_invalid',
    );

    const declared = freshAdvancing('idea-budget-decl-');
    const declaredCampaign = initCampaign(declared.service);
    const declaredStatus = declared.service.handle('campaign.status', {
      campaign_id: declaredCampaign.campaignId,
    }) as { budget_snapshot: Record<string, unknown> };
    expect(declaredStatus.budget_snapshot.tokens_used).toBe(0);
    expect(declaredStatus.budget_snapshot.tokens_remaining).toBe(100_000);
  });
});
