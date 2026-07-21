import { spawnSync } from 'child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { payloadHash } from '../src/hash/payload-hash.js';
import { RpcError } from '../src/service/errors.js';
import { IdeaEngineRpcService } from '../src/service/rpc-service.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = resolve(packageRoot, 'bin/idea-rpc.mjs');
const crashDriver = resolve(packageRoot, 'tests/helpers/revise-card-crash-driver.mjs');
const distEntry = resolve(packageRoot, 'dist/index.js');

function initCampaign(service: IdeaEngineRpcService, key = 'init-key'): { campaignId: string; nodeId: string } {
  const result = service.handle('campaign.init', {
    budget: {
      max_cost_usd: 100,
      max_nodes: 20,
      max_steps: 20,
      max_tokens: 100_000,
      max_wall_clock_s: 10_000,
    },
    charter: {
      approval_gate_ref: 'gate://a0.1',
      campaign_name: 'card revision test',
      domain: 'test-domain',
      scope: 'optimistic card revision fixture',
    },
    idempotency_key: key,
    seed_pack: {
      seeds: [
        {
          content: 'A source-grounded scientific proposition for revision testing.',
          seed_type: 'text',
          source_uris: ['https://example.org/source'],
        },
      ],
    },
  });
  const campaignId = String(result.campaign_id);
  const nodeId = Object.keys(service.read.store.loadNodes(campaignId))[0]!;
  return { campaignId, nodeId };
}

function currentNode(service: IdeaEngineRpcService, campaignId: string, nodeId: string): Record<string, unknown> {
  return service.read.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
}

function replacementCard(node: Record<string, unknown>, thesis: string): Record<string, unknown> {
  const card = structuredClone(node.idea_card) as Record<string, unknown>;
  card.thesis_statement = thesis;
  return card;
}

function reviseParams(
  campaignId: string,
  nodeId: string,
  node: Record<string, unknown>,
  key: string,
  thesis = 'A revised scientific proposition with Unicode Ω and  two preserved spaces.',
): Record<string, unknown> {
  return {
    campaign_id: campaignId,
    node_id: nodeId,
    expected_revision: node.revision,
    replacement_idea_card: replacementCard(node, thesis),
    reason: 'new evidence changes the scientific proposition',
    idempotency_key: key,
  };
}

function expectRpcError(fn: () => unknown, code: number, reason: string): RpcError {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    expect(error.code).toBe(code);
    expect(error.data.reason).toBe(reason);
    return error;
  }
  throw new Error(`expected RpcError ${code}/${reason}`);
}

function enterReview(service: IdeaEngineRpcService, campaignId: string, nodeId: string, key: string): void {
  service.handle('node.set_lifecycle', {
    campaign_id: campaignId,
    node_id: nodeId,
    lifecycle_state: 'admission_review',
    idempotency_key: key,
  });
}

function setPosterior(service: IdeaEngineRpcService, campaignId: string, nodeId: string, key: string, status: 'current' | 'provisional' = 'current'): void {
  service.handle('node.set_posterior', {
    campaign_id: campaignId,
    node_id: nodeId,
    posterior: {
      value: 0.71,
      evidence_count: 6,
      status,
      gaia_package_ref: 'project://gaia/idea-package',
    },
    literature_coverage: {
      status: 'saturated',
      survey_ref: 'project://literature/survey.json',
      close_prior_matrix_ref: 'project://literature/close-prior.json',
    },
    idempotency_key: key,
  });
}

function reductionReport(): Record<string, unknown> {
  return {
    abstract_problem: 'generic inverse problem',
    reduction_map: Array.from({ length: 8 }, (_, index) => ({
      source: `source-${index}`,
      target: `target-${index}`,
      mapping: `mapping-${index}`,
    })),
    assumptions_and_limits: [
      {
        assumption_id: 'a1',
        statement: 'bounded inputs',
        verification_status: 'satisfied',
      },
    ],
    known_solutions: [0, 1].map((index) => ({
      name: `solution-${index}`,
      prerequisites: ['bounded inputs'],
      failure_modes: ['unbounded input'],
      reference_uris: [`https://example.org/solution-${index}`],
    })),
    transfer_plan: [
      {
        step: 'construct map',
        expected_output: 'mapped instance',
        acceptance: 'invariants hold',
      },
    ],
    compatibility_checks: ['dimensional consistency', 'limiting behavior'],
    minimal_toy_check: {
      setup: 'small instance',
      expected_result: 'known solution',
      pass_fail_criteria: 'exact match',
    },
    kill_criteria: ['mapping violates an invariant'],
  };
}

function reductionAudit(): Record<string, unknown> {
  return {
    status: 'pass',
    abstract_problem: 'generic inverse problem',
    assumptions: [{ assumption_id: 'a1', status: 'satisfied' }],
    toy_check_result: 'pass',
    reduction_type_valid: true,
    failures: [],
    timestamp: '2026-07-21T07:00:00.000Z',
  };
}

function logEntries(service: IdeaEngineRpcService, campaignId: string): Array<Record<string, unknown>> {
  return readFileSync(service.read.store.nodesLogPath(campaignId), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function runCli(rootDir: string, params: Record<string, unknown>): { response: Record<string, unknown>; status: number | null } {
  expect(existsSync(distEntry), 'build idea-engine before running process-restart tests').toBe(true);
  const child = spawnSync(process.execPath, [cliPath], {
    encoding: 'utf8',
    input: JSON.stringify({
      method: 'node.revise_card',
      params,
      store_root: rootDir,
    }),
  });
  return {
    response: JSON.parse(child.stdout) as Record<string, unknown>,
    status: child.status,
  };
}

function crash(rootDir: string, params: Record<string, unknown>, crashPoint: string): number | null {
  expect(existsSync(distEntry), 'build idea-engine before running process-restart tests').toBe(true);
  return spawnSync(process.execPath, [crashDriver], {
    encoding: 'utf8',
    input: JSON.stringify({
      crash_point: crashPoint,
      params,
      root_dir: rootDir,
    }),
  }).status;
}

describe('node.revise_card', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fresh(prefix: string): {
    rootDir: string;
    service: IdeaEngineRpcService;
  } {
    const rootDir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(rootDir);
    return {
      rootDir,
      service: new IdeaEngineRpcService({
        rootDir,
        now: () => '2026-07-21T07:30:00.000Z',
      }),
    };
  }

  it('replaces the card, preserves the full prior scientific state, invalidates derived guidance, and replays exactly once', () => {
    const { service } = fresh('idea-revise-full-');
    const { campaignId, nodeId } = initCampaign(service);
    enterReview(service, campaignId, nodeId, 'review');
    setPosterior(service, campaignId, nodeId, 'posterior');
    service.handle('node.set_grounding_audit', {
      campaign_id: campaignId,
      node_id: nodeId,
      grounding_audit: {
        status: 'pass',
        folklore_risk_score: 0.08,
        failures: [],
        report_ref: 'project://grounding/report.json',
      },
      idempotency_key: 'grounding',
    });
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    nodes[nodeId]!.reduction_report = reductionReport();
    nodes[nodeId]!.reduction_audit = reductionAudit();
    service.read.store.saveNodes(campaignId, nodes);
    const before = structuredClone(nodes[nodeId]!);
    const params = reviseParams(campaignId, nodeId, before, 'revise-1');

    const first = service.handle('node.revise_card', params);
    const updated = first.node as Record<string, unknown>;
    const event = first.mutation_event as Record<string, unknown>;
    const eventBefore = event.before as Record<string, unknown>;
    expect(updated.idea_card).toEqual(params.replacement_idea_card);
    expect((updated.idea_card as Record<string, unknown>).thesis_statement).toContain('Ω and  two');
    expect(updated.revision).toBe(Number(before.revision) + 1);
    expect(updated).toMatchObject({
      lifecycle_state: 'candidate',
      lifecycle_reason: 'idea_card_revised',
      activation_condition: null,
      grounding_audit: null,
      posterior: null,
      literature_coverage: null,
      reduction_report: null,
      reduction_audit: null,
    });
    expect(event.before_idea_card_hash).toBe(payloadHash(before.idea_card));
    expect(event.after_idea_card_hash).toBe(payloadHash(params.replacement_idea_card));
    expect(event.before_node).toEqual(before);
    expect(eventBefore).toMatchObject({
      revision: before.revision,
      idea_card: before.idea_card,
      grounding_audit: before.grounding_audit,
      posterior: before.posterior,
      literature_coverage: before.literature_coverage,
      reduction_report: before.reduction_report,
      reduction_audit: before.reduction_audit,
      lifecycle_state: 'admitted',
    });
    expect((eventBefore.posterior as Record<string, unknown>).gaia_package_ref).toBe('project://gaia/idea-package');
    expect(event.invalidations as Record<string, unknown>).toMatchObject({
      grounding_audit: true,
      posterior: true,
      literature_coverage: true,
      reduction_report: true,
      reduction_audit: true,
      allocation_eligibility: true,
    });
    const rank = service.handle('rank.compute', {
      campaign_id: campaignId,
      method: 'posterior',
      idempotency_key: 'rank-after',
    });
    expect(rank.ranked_nodes).toEqual([]);
    expect(rank.skipped_nodes).toEqual([{ node_id: nodeId, reason: 'candidate' }]);

    const replay = service.handle('node.revise_card', params);
    expect((replay.idempotency as Record<string, unknown>).is_replay).toBe(true);
    expect(logEntries(service, campaignId).filter((entry) => entry.mutation === 'revise_card')).toHaveLength(1);
    expectRpcError(
      () =>
        service.handle('node.revise_card', {
          ...params,
          reason: 'different intent under the same key',
        }),
      -32002,
      'idempotency_key_conflict',
    );
    expectRpcError(
      () =>
        service.handle('node.revise_card', {
          ...params,
          replacement_idea_card: replacementCard(before, 'too short'),
        }),
      -32002,
      'idempotency_key_conflict',
    );
    expectRpcError(
      () =>
        service.handle('node.revise_card', {
          ...params,
          idempotency_key: 'stale-key',
        }),
      -32019,
      'stale_revision',
    );
  });

  it('persists the first stale error and never turns the same key into a later mutation', () => {
    const { service } = fresh('idea-revise-error-replay-');
    const { campaignId, nodeId } = initCampaign(service);
    const node = currentNode(service, campaignId, nodeId);
    const params = {
      ...reviseParams(campaignId, nodeId, node, 'stale-error-replay'),
      expected_revision: Number(node.revision) + 1,
    };
    const first = expectRpcError(() => service.handle('node.revise_card', params), -32019, 'stale_revision');

    enterReview(service, campaignId, nodeId, 'intervening-review');
    const second = expectRpcError(() => service.handle('node.revise_card', params), -32019, 'stale_revision');
    expect(second.message).toBe(first.message);
    expect(second.data).toEqual(first.data);
    expect(currentNode(service, campaignId, nodeId).revision).toBe(params.expected_revision);
    expect(logEntries(service, campaignId).filter((entry) => entry.mutation === 'revise_card')).toHaveLength(0);
    const stored = service.read.store.loadIdempotency<Record<string, unknown>>(campaignId)['node.revise_card:stale-error-replay']!;
    expect(stored.state).toBe('committed');
    expect((stored.response as Record<string, unknown>).kind).toBe('error');
  });

  it('uses authoritative card validation, rejects blank and canonically unchanged replacements, and preserves string bytes', () => {
    const { service } = fresh('idea-revise-validation-');
    const { campaignId, nodeId } = initCampaign(service);
    const node = currentNode(service, campaignId, nodeId);
    const card = structuredClone(node.idea_card) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(card).reverse());
    expectRpcError(
      () =>
        service.handle('node.revise_card', {
          ...reviseParams(campaignId, nodeId, node, 'same-card'),
          replacement_idea_card: reordered,
        }),
      -32002,
      'replacement_idea_card_unchanged',
    );
    expectRpcError(
      () =>
        service.handle('node.revise_card', {
          ...reviseParams(campaignId, nodeId, node, 'blank-reason'),
          reason: '   ',
        }),
      -32002,
      'schema_invalid',
    );
    const invalid = replacementCard(node, 'too short');
    expectRpcError(
      () =>
        service.handle('node.revise_card', {
          ...reviseParams(campaignId, nodeId, node, 'invalid-card'),
          replacement_idea_card: invalid,
        }),
      -32002,
      'schema_invalid',
    );
  });

  it('allows only candidate, admission_review, admitted, and needs_refresh as source states', () => {
    const cases: Array<{ allowed: boolean; state: string }> = [
      { state: 'candidate', allowed: true },
      { state: 'admission_review', allowed: true },
      { state: 'admitted', allowed: true },
      { state: 'needs_refresh', allowed: true },
      { state: 'admission_blocked', allowed: false },
      { state: 'waiting_activation', allowed: false },
      { state: 'archived', allowed: false },
    ];
    for (const { allowed, state } of cases) {
      const { service } = fresh(`idea-revise-${state}-`);
      const { campaignId, nodeId } = initCampaign(service, `init-${state}`);
      if (state === 'admission_review' || state === 'admitted' || state === 'needs_refresh') {
        enterReview(service, campaignId, nodeId, `review-${state}`);
      }
      if (state === 'admitted') setPosterior(service, campaignId, nodeId, 'posterior-admitted');
      if (state === 'needs_refresh') setPosterior(service, campaignId, nodeId, 'posterior-refresh', 'provisional');
      if (state === 'admission_blocked' || state === 'waiting_activation') {
        service.handle('node.set_lifecycle', {
          campaign_id: campaignId,
          node_id: nodeId,
          lifecycle_state: state,
          activation_condition: {
            kind: 'required_evidence',
            description: 'produce missing evidence',
            satisfied: false,
          },
          idempotency_key: `state-${state}`,
        });
      }
      if (state === 'archived') {
        service.handle('node.set_lifecycle', {
          campaign_id: campaignId,
          node_id: nodeId,
          lifecycle_state: 'archived',
          reason: 'retained for record',
          idempotency_key: 'state-archived',
        });
      }
      const node = currentNode(service, campaignId, nodeId);
      const params = reviseParams(campaignId, nodeId, node, `revise-${state}`, `A revised proposition originating from lifecycle state ${state}.`);
      if (allowed) {
        expect((service.handle('node.revise_card', params).node as Record<string, unknown>).lifecycle_state).toBe('candidate');
      } else {
        expectRpcError(() => service.handle('node.revise_card', params), -32018, 'idea_card_revision_lifecycle_invalid');
      }
    }
  });

  it('keeps generated-node reserved provenance engine-owned while allowing ordinary card changes', () => {
    const { service } = fresh('idea-revise-provenance-');
    const { campaignId, nodeId } = initCampaign(service);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const node = nodes[nodeId]!;
    const prior = 'https://example.org/closest-prior';
    const card = structuredClone(node.idea_card) as Record<string, unknown>;
    const claims = card.claims as Array<Record<string, unknown>>;
    claims.push({
      claim_text: `Novelty delta vs closest prior (${prior}): engine-owned comparison`,
      support_type: 'literature',
      evidence_uris: [prior],
      verification_status: 'verified',
    });
    const trace = node.operator_trace as Record<string, unknown>;
    const inputs = trace.inputs as Record<string, unknown>;
    inputs.novelty_delta = { closest_prior: prior };
    node.idea_card = card;
    service.read.store.saveNodes(campaignId, nodes);

    const changed = replacementCard(node, 'An ordinary scientific claim changes while reserved provenance remains exact.');
    const altered = structuredClone(changed);
    const alteredClaims = altered.claims as Array<Record<string, unknown>>;
    alteredClaims[alteredClaims.length - 1] = {
      ...alteredClaims[alteredClaims.length - 1],
      confidence: 0.5,
    };
    expectRpcError(
      () =>
        service.handle('node.revise_card', {
          campaign_id: campaignId,
          node_id: nodeId,
          expected_revision: node.revision,
          replacement_idea_card: altered,
          reason: 'attempt reserved claim mutation',
          idempotency_key: 'reserved-fail',
        }),
      -32002,
      'reserved_provenance_claim_changed',
    );
    const success = service.handle('node.revise_card', {
      campaign_id: campaignId,
      node_id: nodeId,
      expected_revision: node.revision,
      replacement_idea_card: changed,
      reason: 'ordinary proposition change',
      idempotency_key: 'reserved-pass',
    });
    expect((success.node as Record<string, unknown>).idea_card).toEqual(changed);
  });

  for (const crashPoint of ['after_prepare', 'after_node', 'during_log', 'after_log']) {
    it(`recovers durably after a real process restart at ${crashPoint}`, () => {
      const { rootDir, service } = fresh(`idea-revise-crash-${crashPoint}-`);
      const { campaignId, nodeId } = initCampaign(service);
      const params = reviseParams(campaignId, nodeId, currentNode(service, campaignId, nodeId), `crash-${crashPoint}`);
      expect(crash(rootDir, params, crashPoint)).toBeGreaterThanOrEqual(91);

      const retry = runCli(rootDir, params);
      expect(retry.status).toBe(0);
      const result = retry.response.result as Record<string, unknown>;
      expect((result.node as Record<string, unknown>).revision).toBe(2);
      expect((result.idempotency as Record<string, unknown>).is_replay).toBe(true);
      expect((result.node as Record<string, unknown>).updated_at).toBe('2026-07-21T08:00:00.000Z');
      const rawLines = readFileSync(service.read.store.nodesLogPath(campaignId), 'utf8').split('\n').filter(Boolean);
      expect(() => rawLines.map((line) => JSON.parse(line))).not.toThrow();
      expect(rawLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.mutation === 'revise_card')).toHaveLength(1);
    });
  }

  it('refuses a late recovery event after a newer same-node mutation', () => {
    const { rootDir, service } = fresh('idea-revise-ordering-');
    const { campaignId, nodeId } = initCampaign(service);
    const params = reviseParams(campaignId, nodeId, currentNode(service, campaignId, nodeId), 'ordering-key');
    expect(crash(rootDir, params, 'after_node')).toBe(92);
    enterReview(service, campaignId, nodeId, 'later-review');

    const retry = runCli(rootDir, params);
    expect(retry.status).toBe(1);
    const error = retry.response.error as Record<string, unknown>;
    expect(error).toMatchObject({ code: -32603, message: 'internal_error' });
    expect((error.data as Record<string, unknown>).reason).toBe('idea_card_revision_recovery_conflict');
    expect(logEntries(service, campaignId).filter((entry) => entry.mutation === 'revise_card')).toHaveLength(0);
  });

  it('fails closed on interior JSONL corruption and an unrelated torn final fragment', () => {
    for (const corruption of ['interior', 'unrelated-final']) {
      const { rootDir, service } = fresh(`idea-revise-corrupt-${corruption}-`);
      const { campaignId, nodeId } = initCampaign(service, `init-${corruption}`);
      const params = reviseParams(campaignId, nodeId, currentNode(service, campaignId, nodeId), `corrupt-${corruption}`);
      expect(crash(rootDir, params, 'after_node')).toBe(92);
      appendFileSync(service.read.store.nodesLogPath(campaignId), corruption === 'interior' ? '{malformed}\n' : '{"mutation":"unrelated"', 'utf8');
      const retry = runCli(rootDir, params);
      expect(retry.status).toBe(1);
      const error = retry.response.error as Record<string, unknown>;
      expect((error.data as Record<string, unknown>).reason).toBe('idea_card_revision_recovery_conflict');
    }
  });

  it('refuses a fresh revision before any write when the existing ledger is corrupt', () => {
    const { service } = fresh('idea-revise-preflight-corrupt-');
    const { campaignId, nodeId } = initCampaign(service);
    const before = currentNode(service, campaignId, nodeId);
    appendFileSync(service.read.store.nodesLogPath(campaignId), '{malformed}\n', 'utf8');

    expectRpcError(() => service.handle('node.revise_card', reviseParams(campaignId, nodeId, before, 'preflight-corrupt')), -32603, 'idea_card_revision_recovery_conflict');
    expect(currentNode(service, campaignId, nodeId)).toEqual(before);
    const stored = service.read.store.loadIdempotency<Record<string, unknown>>(campaignId)['node.revise_card:preflight-corrupt']!;
    expect(stored.state).toBe('committed');
    expect((stored.response as Record<string, unknown>).kind).toBe('error');
  });
});
