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
