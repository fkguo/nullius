import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeaEngineRpcService } from '../src/service/rpc-service.js';
import { RpcError } from '../src/service/errors.js';

const PROMPT_SNAPSHOT_CONTENT = 'rendered generation prompt for the provenance rewrite fixture';
const PROMPT_SNAPSHOT_HASH = `sha256:${createHash('sha256').update(PROMPT_SNAPSHOT_CONTENT, 'utf8').digest('hex')}`;
const URI_A = 'https://example.com/paper-a';
const URI_B = 'https://example.com/paper-b';
const REPORT_REF = `project://artifacts/grounding/claim_grounding_report_v1.json#sha256:${'e'.repeat(64)}`;

function makeIdSequence(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `t${String(counter).padStart(7, '0')}`;
  };
}

function initCampaign(
  service: IdeaEngineRpcService,
  seeds: Array<Record<string, unknown>> = [
    { content: 'seed-one', seed_type: 'text', source_uris: ['https://example.org/seed-1'] },
  ],
): string {
  const result = service.handle('campaign.init', {
    budget: {
      max_cost_usd: 100.0,
      max_nodes: 100,
      max_steps: 100,
      max_tokens: 100_000,
      max_wall_clock_s: 100_000,
    },
    charter: {
      approval_gate_ref: 'gate://a0.1',
      campaign_name: 'grounding-and-rewrite',
      domain: 'test-domain',
      scope: 'grounding-audit write path and provenance rewrite regression fixture',
    },
    idempotency_key: 'init-key',
    seed_pack: { seeds },
  });
  return String(result.campaign_id);
}

function allNodeIds(service: IdeaEngineRpcService, campaignId: string): string[] {
  return Object.keys(service.read.store.loadNodes<Record<string, unknown>>(campaignId));
}

function loadNode(service: IdeaEngineRpcService, campaignId: string, nodeId: string): Record<string, unknown> {
  return service.read.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
}

function enterAdmissionReview(
  service: IdeaEngineRpcService,
  campaignId: string,
  nodeId: string,
  key: string,
): Record<string, unknown> {
  return service.handle('node.set_lifecycle', {
    campaign_id: campaignId,
    idempotency_key: key,
    lifecycle_state: 'admission_review',
    node_id: nodeId,
  });
}

function setPosterior(
  service: IdeaEngineRpcService,
  campaignId: string,
  nodeId: string,
  key: string,
  value: number,
  evidenceCount: number,
): Record<string, unknown> {
  const node = loadNode(service, campaignId, nodeId);
  if (node.lifecycle_state === 'candidate') {
    enterAdmissionReview(service, campaignId, nodeId, `${key}-review`);
  }
  return service.handle('node.set_posterior', {
    campaign_id: campaignId,
    idempotency_key: key,
    literature_coverage: {
      status: 'saturated',
      survey_ref: `project://artifacts/literature/${nodeId}-literature_survey_v1.json#sha256:${'c'.repeat(64)}`,
      close_prior_matrix_ref: `project://artifacts/literature/${nodeId}-close-prior-matrix.json#sha256:${'d'.repeat(64)}`,
    },
    node_id: nodeId,
    posterior: { evidence_count: evidenceCount, value },
  });
}

function setGroundingAudit(
  service: IdeaEngineRpcService,
  campaignId: string,
  nodeId: string,
  key: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return service.handle('node.set_grounding_audit', {
    campaign_id: campaignId,
    grounding_audit: {
      failures: [],
      folklore_risk_score: 0.1,
      report_ref: REPORT_REF,
      status: 'pass',
      ...overrides,
    },
    idempotency_key: key,
    node_id: nodeId,
  });
}

/** A generated candidate whose closest_prior deliberately carries `closestPrior`. */
function generatedCandidate(closestPrior: string): Record<string, unknown> {
  return {
    card_fields: {
      claims: [
        {
          claim_text: 'source A and source B disagree on the magnitude of effect X',
          evidence_uris: [URI_A, URI_B],
          support_type: 'literature',
        },
      ],
      minimal_compute_plan: [
        { estimated_difficulty: 'moderate', method: 'toy estimate', step: 'bounded first check separating the two accounts' },
      ],
      required_observables: ['discriminating-observable-1'],
      testable_hypotheses: ['under condition Z the two accounts predict opposite signs'],
    },
    dedup: {
      decision: 'unique',
      method: 'charngram-cosine-v1',
      nearest_similarity: 0.31,
    },
    novelty_delta: {
      closest_prior: closestPrior,
      delta_type: 'new_mechanism',
      falsifiable_delta_statement: 'unlike the closest prior, predicts a sign flip under condition Z; absence of the flip kills the idea',
      overlap_summary: 'both study effect X in the same regime',
    },
    provenance: {
      evidence_uris_used: [URI_A, URI_B],
      operator_family: 'LiteratureMining',
      operator_id: 'litmine.tension_resolution.v1',
      origin: {
        model: 'test-generator-model',
        prompt_hash: PROMPT_SNAPSHOT_HASH,
        role: 'Generator',
        temperature: 0.7,
        timestamp: '2026-07-06T00:00:00Z',
      },
      parent_node_ids: [],
      prompt_snapshot_hash: PROMPT_SNAPSHOT_HASH,
      trace_inputs: {
        anchor: {
          kind: 'tension',
          ref_keys: ['refA', 'refB'],
          statement: 'A and B disagree on the magnitude of effect X',
        },
        retrieval_receipts: [
          { source: 'literature_survey_v1#papers/refA', uri: URI_A },
          { source: 'literature_survey_v1#papers/refB', uri: URI_B },
        ],
      },
      trace_params: { operator_contract: 'litmine.v1' },
    },
    rationale_draft: {
      kill_criteria: ['the discriminating observable shows no difference between accounts'],
      rationale: 'The two accounts of effect X disagree; a mechanism with a bounded discriminating check would resolve the tension.',
      risks: ['the bounded check may not separate the two accounts'],
      title: 'Resolve the anchored X tension',
    },
    target_admission_route: 'open_problem',
  };
}

/** Import one generated node whose closest_prior is `closestPrior`; returns its node_id. */
function importGeneratedNode(
  service: IdeaEngineRpcService,
  campaignId: string,
  closestPrior: string,
  key = 'import-key-1',
): string {
  const result = service.handle('node.import_generated', {
    campaign_id: campaignId,
    idempotency_key: key,
    pack: {
      campaign_id: campaignId,
      candidates: [generatedCandidate(closestPrior)],
      created_at: '2026-07-06T00:00:00Z',
      evidence_snapshot: {
        survey_artifact_ref: 'file:///tmp/survey-artifact.json',
        survey_content_hash: `sha256:${'c'.repeat(64)}`,
      },
      prompt_snapshots: [
        { content: PROMPT_SNAPSHOT_CONTENT, hash: PROMPT_SNAPSHOT_HASH },
      ],
      rejected_candidates: [],
      trigger: { artifact_ref: 'file:///tmp/survey-artifact.json', kind: 'survey_updated' },
    },
  });
  const imported = result.imported as Array<Record<string, unknown>>;
  return String(imported[0]!.node_id);
}

function rewriteProvenance(
  service: IdeaEngineRpcService,
  campaignId: string,
  nodeId: string,
  key: string,
  newValue: string,
  reason = 'closest_prior recorded a campaign node id; corrected to the durable reference of the prior work',
): Record<string, unknown> {
  return service.handle('node.rewrite_provenance', {
    campaign_id: campaignId,
    field: 'novelty_delta.closest_prior',
    idempotency_key: key,
    new_value: newValue,
    node_id: nodeId,
    reason,
  });
}

function nodeCloseestPrior(node: Record<string, unknown>): unknown {
  const trace = node.operator_trace as Record<string, unknown>;
  const inputs = trace.inputs as Record<string, unknown>;
  return (inputs.novelty_delta as Record<string, unknown>).closest_prior;
}

function nodeRewriteHistory(node: Record<string, unknown>): Array<Record<string, unknown>> {
  const trace = node.operator_trace as Record<string, unknown>;
  const inputs = trace.inputs as Record<string, unknown>;
  return (inputs.provenance_rewrites as Array<Record<string, unknown>> | undefined) ?? [];
}

function deltaClaims(node: Record<string, unknown>): Array<Record<string, unknown>> {
  const card = node.idea_card as Record<string, unknown>;
  return (card.claims as Array<Record<string, unknown>>)
    .filter(claim => String(claim.claim_text).startsWith('Novelty delta vs closest prior ('));
}

function lastLogEntry(service: IdeaEngineRpcService, campaignId: string): Record<string, unknown> {
  const lines = readFileSync(service.read.store.nodesLogPath(campaignId), 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

interface IdemRecord {
  created_at: string;
  payload_hash: string;
  response: { kind: string; payload: Record<string, unknown> };
  state: string;
}

/** Reopen a committed idempotency record as `prepared`, simulating a crash between saveNodes and the committed write. */
function reopenPrepared(service: IdeaEngineRpcService, campaignId: string, method: string, key: string): void {
  const path = service.read.store.campaignIdempotencyPath(campaignId);
  const records = JSON.parse(readFileSync(path, 'utf8')) as Record<string, IdemRecord>;
  records[`${method}:${key}`]!.state = 'prepared';
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

function countLogEntries(service: IdeaEngineRpcService, campaignId: string, nodeId: string, mutation: string): number {
  return readFileSync(service.read.store.nodesLogPath(campaignId), 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(entry => entry.mutation === mutation && entry.node_id === nodeId)
    .length;
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

describe('node.set_grounding_audit', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function freshService(): IdeaEngineRpcService {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-grounding-rpc-'));
    tempDirs.push(rootDir);
    return new IdeaEngineRpcService({ createId: makeIdSequence(), rootDir });
  }

  it('records a passing audit on an admitted node and node.promote consumes it end to end', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, nodeId!, 'sp-1', 0.42, 3);
    const beforeRevision = Number(loadNode(service, campaignId, nodeId!).revision);

    const result = setGroundingAudit(service, campaignId, nodeId!, 'ga-1');
    const summary = result.node as Record<string, unknown>;
    const recorded = summary.grounding_audit as Record<string, unknown>;
    expect(recorded.status).toBe('pass');
    expect(recorded.folklore_risk_score).toBe(0.1);
    expect(recorded.failures).toEqual([]);
    expect(recorded.report_ref).toBe(REPORT_REF);
    expect(typeof recorded.timestamp).toBe('string');
    expect(summary.revision).toBe(beforeRevision + 1);

    const stored = loadNode(service, campaignId, nodeId!);
    expect(stored.grounding_audit).toEqual(recorded);
    expect(Number(stored.revision)).toBe(beforeRevision + 1);

    const logEntry = lastLogEntry(service, campaignId);
    expect(logEntry.mutation).toBe('set_grounding_audit');
    expect(logEntry.report_ref).toBe(REPORT_REF);

    const promoted = service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-1',
      node_id: nodeId,
    });
    const handoff = service.read.store.loadArtifactFromRef<Record<string, unknown>>(
      String(promoted.handoff_artifact_ref),
    );
    expect((handoff.grounding_audit as Record<string, unknown>).report_ref).toBe(REPORT_REF);
  });

  it('records honest fail results as data and promote stays blocked', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, nodeId!, 'sp-1', 0.42, 3);

    setGroundingAudit(service, campaignId, nodeId!, 'ga-fail', {
      failures: ['claim 2 cites a source that does not contain the statement'],
      folklore_risk_score: 0.6,
      status: 'fail',
    });
    const stored = loadNode(service, campaignId, nodeId!);
    expect((stored.grounding_audit as Record<string, unknown>).status).toBe('fail');
    // Recording a failing audit does not move the lifecycle: that decision
    // stays an explicit node.set_lifecycle call.
    expect(stored.lifecycle_state).toBe('admitted');

    expectRpcError(() => service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-blocked',
      node_id: nodeId,
    }), -32011, 'grounding_audit_not_pass');
  });

  it('is legal in admission_review before any posterior exists', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    enterAdmissionReview(service, campaignId, nodeId!, 'review-1');

    const result = setGroundingAudit(service, campaignId, nodeId!, 'ga-review');
    expect(((result.node as Record<string, unknown>).grounding_audit as Record<string, unknown>).status).toBe('pass');
    expect((result.node as Record<string, unknown>).posterior).toBeNull();
  });

  it('rejects writes outside the review window with the allowed states', () => {
    const service = freshService();
    const campaignId = initCampaign(service, [
      { content: 'seed-one', seed_type: 'text', source_uris: ['https://example.org/seed-1'] },
      { content: 'seed-two', seed_type: 'text', source_uris: ['https://example.org/seed-2'] },
    ]);
    const [candidate, toBlock] = allNodeIds(service, campaignId);

    const candidateError = expectRpcError(
      () => setGroundingAudit(service, campaignId, candidate!, 'ga-candidate'),
      -32018,
      'grounding_audit_write_lifecycle_invalid',
    );
    const details = candidateError.data.details as Record<string, unknown>;
    expect(details.current_state).toBe('candidate');
    expect(details.allowed_states).toEqual(['admission_review', 'admitted', 'needs_refresh']);

    service.handle('node.set_lifecycle', {
      activation_condition: {
        description: 'independent grounding record for the idea card claims',
        kind: 'required_evidence',
        satisfied: false,
      },
      campaign_id: campaignId,
      idempotency_key: 'block-1',
      lifecycle_state: 'admission_blocked',
      node_id: toBlock,
    });
    expectRpcError(
      () => setGroundingAudit(service, campaignId, toBlock!, 'ga-blocked'),
      -32018,
      'grounding_audit_write_lifecycle_invalid',
    );
  });

  it('replays the identical request and rejects a conflicting payload under the same key', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, nodeId!, 'sp-1', 0.42, 3);

    const first = setGroundingAudit(service, campaignId, nodeId!, 'ga-1');
    const revisionAfterFirst = Number(loadNode(service, campaignId, nodeId!).revision);
    const replay = setGroundingAudit(service, campaignId, nodeId!, 'ga-1');
    expect((replay.idempotency as Record<string, unknown>).is_replay).toBe(true);
    expect(replay.node).toEqual(first.node);
    expect(Number(loadNode(service, campaignId, nodeId!).revision)).toBe(revisionAfterFirst);

    expectRpcError(
      () => setGroundingAudit(service, campaignId, nodeId!, 'ga-1', { folklore_risk_score: 0.2 }),
      -32002,
      'idempotency_key_conflict',
    );
  });

  it('rejects a record without report_ref: every audit names the record it summarizes', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, nodeId!, 'sp-1', 0.42, 3);

    expectRpcError(() => service.handle('node.set_grounding_audit', {
      campaign_id: campaignId,
      grounding_audit: {
        failures: [],
        folklore_risk_score: 0.1,
        status: 'pass',
      },
      idempotency_key: 'ga-no-ref',
      node_id: nodeId,
    }), -32002, 'schema_invalid');
  });

  it('recovers a prepared record without re-writing: the crash-recovery probe recognizes the committed audit', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, nodeId!, 'sp-1', 0.42, 3);
    const first = setGroundingAudit(service, campaignId, nodeId!, 'ga-1');
    const revisionAfterFirst = Number(loadNode(service, campaignId, nodeId!).revision);

    // Simulate a crash between saveNodes and the committed idempotency write.
    reopenPrepared(service, campaignId, 'node.set_grounding_audit', 'ga-1');
    const recovered = setGroundingAudit(service, campaignId, nodeId!, 'ga-1');
    expect((recovered.idempotency as Record<string, unknown>).is_replay).toBe(true);
    expect(recovered.node).toEqual(first.node);
    // The probe recognized the landed audit — no re-write, no second log entry.
    expect(Number(loadNode(service, campaignId, nodeId!).revision)).toBe(revisionAfterFirst);
    expect(countLogEntries(service, campaignId, nodeId!, 'set_grounding_audit')).toBe(1);
  });
});

describe('node.rewrite_provenance', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function freshService(): IdeaEngineRpcService {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-rewrite-rpc-'));
    tempDirs.push(rootDir);
    return new IdeaEngineRpcService({ createId: makeIdSequence(), rootDir });
  }

  it('rewrites a node-id closest_prior to a receipted URI, syncing trace, card claim, and history', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [seedNodeId] = allNodeIds(service, campaignId);
    // The defect under correction: a generated node recorded another campaign
    // node's id as its closest prior instead of a durable reference.
    const generatedId = importGeneratedNode(service, campaignId, seedNodeId!);
    const before = loadNode(service, campaignId, generatedId);
    expect(nodeCloseestPrior(before)).toBe(seedNodeId);
    expect(deltaClaims(before)[0]!.evidence_uris).toEqual([]);
    const beforeRevision = Number(before.revision);

    const result = rewriteProvenance(service, campaignId, generatedId, 'rw-1', URI_A);
    expect(result.field).toBe('novelty_delta.closest_prior');
    expect(result.previous_value).toBe(seedNodeId);
    expect(result.new_value).toBe(URI_A);
    expect(result.delta_claim_updated).toBe(true);
    expect(result.revision).toBe(beforeRevision + 1);

    const after = loadNode(service, campaignId, generatedId);
    expect(nodeCloseestPrior(after)).toBe(URI_A);
    const history = nodeRewriteHistory(after);
    expect(history).toHaveLength(1);
    expect(history[0]!.field).toBe('novelty_delta.closest_prior');
    expect(history[0]!.previous_value).toBe(seedNodeId);
    expect(history[0]!.new_value).toBe(URI_A);
    expect(typeof history[0]!.rewritten_at).toBe('string');
    expect(String(history[0]!.reason).length).toBeGreaterThan(0);

    const claims = deltaClaims(after);
    expect(claims).toHaveLength(1);
    expect(String(claims[0]!.claim_text).startsWith(`Novelty delta vs closest prior (${URI_A}): `)).toBe(true);
    expect(String(claims[0]!.claim_text)).not.toContain(seedNodeId!);
    expect(claims[0]!.evidence_uris).toEqual([URI_A]);

    const logEntry = lastLogEntry(service, campaignId);
    expect(logEntry.mutation).toBe('rewrite_provenance');
    expect(logEntry.previous_value).toBe(seedNodeId);
    expect(logEntry.new_value).toBe(URI_A);
  });

  it('accepts a non-URI survey ref key and clears the delta claim evidence URIs', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [seedNodeId] = allNodeIds(service, campaignId);
    const generatedId = importGeneratedNode(service, campaignId, seedNodeId!);

    const result = rewriteProvenance(service, campaignId, generatedId, 'rw-refkey', 'refA');
    expect(result.delta_claim_updated).toBe(true);

    const after = loadNode(service, campaignId, generatedId);
    expect(nodeCloseestPrior(after)).toBe('refA');
    const claims = deltaClaims(after);
    expect(String(claims[0]!.claim_text).startsWith('Novelty delta vs closest prior (refA): ')).toBe(true);
    expect(claims[0]!.evidence_uris).toEqual([]);
  });

  it('supports successive corrections: the history preserves every rewrite in order', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [seedNodeId] = allNodeIds(service, campaignId);
    const generatedId = importGeneratedNode(service, campaignId, seedNodeId!);

    rewriteProvenance(service, campaignId, generatedId, 'rw-1', URI_A);
    rewriteProvenance(service, campaignId, generatedId, 'rw-2', URI_B, 'the first correction picked the wrong receipted source');

    const after = loadNode(service, campaignId, generatedId);
    expect(nodeCloseestPrior(after)).toBe(URI_B);
    const history = nodeRewriteHistory(after);
    expect(history.map(entry => entry.new_value)).toEqual([URI_A, URI_B]);
    expect(history.map(entry => entry.previous_value)).toEqual([seedNodeId, URI_A]);
    const claims = deltaClaims(after);
    expect(String(claims[0]!.claim_text).startsWith(`Novelty delta vs closest prior (${URI_B}): `)).toBe(true);
    expect(claims[0]!.evidence_uris).toEqual([URI_B]);
  });

  it('rejects a rewrite to the value already stored', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [seedNodeId] = allNodeIds(service, campaignId);
    const generatedId = importGeneratedNode(service, campaignId, seedNodeId!);
    expectRpcError(
      () => rewriteProvenance(service, campaignId, generatedId, 'rw-same', seedNodeId!),
      -32002,
      'rewrite_value_unchanged',
    );
  });

  it('rejects any campaign node or idea id as the corrected value', () => {
    const service = freshService();
    const campaignId = initCampaign(service, [
      { content: 'seed-one', seed_type: 'text', source_uris: ['https://example.org/seed-1'] },
      { content: 'seed-two', seed_type: 'text', source_uris: ['https://example.org/seed-2'] },
    ]);
    const [seedOne, seedTwo] = allNodeIds(service, campaignId);
    const generatedId = importGeneratedNode(service, campaignId, seedOne!);
    const seedTwoIdeaId = String(loadNode(service, campaignId, seedTwo!).idea_id);

    expectRpcError(
      () => rewriteProvenance(service, campaignId, generatedId, 'rw-nodeid', seedTwo!),
      -32002,
      'closest_prior_node_reference',
    );
    expectRpcError(
      () => rewriteProvenance(service, campaignId, generatedId, 'rw-ideaid', seedTwoIdeaId),
      -32002,
      'closest_prior_node_reference',
    );
    // The generated node's own ids are equally not durable references.
    expectRpcError(
      () => rewriteProvenance(service, campaignId, generatedId, 'rw-self', generatedId),
      -32002,
      'closest_prior_node_reference',
    );
  });

  it('rejects a URI-shaped value without a retrieval receipt in the stored trace', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [seedNodeId] = allNodeIds(service, campaignId);
    const generatedId = importGeneratedNode(service, campaignId, seedNodeId!);
    const error = expectRpcError(
      () => rewriteProvenance(service, campaignId, generatedId, 'rw-unreceipted', 'https://example.com/paper-c'),
      -32002,
      'evidence_receipt_missing',
    );
    expect((error.data.details as Record<string, unknown>).uri).toBe('https://example.com/paper-c');
  });

  it('rejects nodes without a recorded novelty delta (seeds have no closest_prior)', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [seedNodeId] = allNodeIds(service, campaignId);
    expectRpcError(
      () => rewriteProvenance(service, campaignId, seedNodeId!, 'rw-seed', URI_A),
      -32002,
      'provenance_field_missing',
    );
  });

  it('replays the identical request and rejects a conflicting payload under the same key', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [seedNodeId] = allNodeIds(service, campaignId);
    const generatedId = importGeneratedNode(service, campaignId, seedNodeId!);

    const first = rewriteProvenance(service, campaignId, generatedId, 'rw-1', URI_A);
    const revisionAfterFirst = Number(loadNode(service, campaignId, generatedId).revision);
    const replay = rewriteProvenance(service, campaignId, generatedId, 'rw-1', URI_A);
    expect((replay.idempotency as Record<string, unknown>).is_replay).toBe(true);
    expect(replay.new_value).toBe(first.new_value);
    expect(Number(loadNode(service, campaignId, generatedId).revision)).toBe(revisionAfterFirst);
    expect(nodeRewriteHistory(loadNode(service, campaignId, generatedId))).toHaveLength(1);

    expectRpcError(
      () => rewriteProvenance(service, campaignId, generatedId, 'rw-1', URI_B),
      -32002,
      'idempotency_key_conflict',
    );
  });

  it('recovers a prepared record across an intervening mutation without re-executing into rewrite_value_unchanged', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [seedNodeId] = allNodeIds(service, campaignId);
    const generatedId = importGeneratedNode(service, campaignId, seedNodeId!);

    const first = rewriteProvenance(service, campaignId, generatedId, 'rw-1', URI_A);
    const revisionAfterRewrite = Number(loadNode(service, campaignId, generatedId).revision);

    // Simulate a crash between saveNodes and the committed idempotency write,
    // then an UNRELATED mutation that moves the node's top-level updated_at
    // before the client retries. A probe keyed on updated_at would delete the
    // prepared record and re-execute — and re-execution would now read
    // closest_prior === URI_A and throw rewrite_value_unchanged. The
    // history-entry probe must recognize the landed correction instead.
    reopenPrepared(service, campaignId, 'node.rewrite_provenance', 'rw-1');
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'intervening-review',
      lifecycle_state: 'admission_review',
      node_id: generatedId,
    });

    const recovered = rewriteProvenance(service, campaignId, generatedId, 'rw-1', URI_A);
    expect((recovered.idempotency as Record<string, unknown>).is_replay).toBe(true);
    expect(recovered.new_value).toBe(first.new_value);
    expect(nodeCloseestPrior(loadNode(service, campaignId, generatedId))).toBe(URI_A);
    // No re-execution: the rewrite revision is unchanged (only the intervening
    // set_lifecycle advanced it), and the history was not double-appended.
    expect(Number(loadNode(service, campaignId, generatedId).revision)).toBe(revisionAfterRewrite + 1);
    expect(nodeRewriteHistory(loadNode(service, campaignId, generatedId))).toHaveLength(1);
    expect(countLogEntries(service, campaignId, generatedId, 'rewrite_provenance')).toBe(1);
  });

  it('rejects a blank (whitespace-only) new_value that slips past the params minLength', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [seedNodeId] = allNodeIds(service, campaignId);
    const generatedId = importGeneratedNode(service, campaignId, seedNodeId!);
    expectRpcError(
      () => rewriteProvenance(service, campaignId, generatedId, 'rw-blank', '   '),
      -32002,
      'schema_invalid',
    );
  });

  it('rejects a URI in evidence_uris_used but lacking a retrieval receipt (single-condition guard branch)', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [seedNodeId] = allNodeIds(service, campaignId);
    const generatedId = importGeneratedNode(service, campaignId, seedNodeId!);
    // Add a URI to evidence_uris_used WITHOUT a matching retrieval receipt.
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const trace = (nodes[generatedId] as Record<string, unknown>).operator_trace as Record<string, unknown>;
    (trace.evidence_uris_used as string[]).push('https://example.com/no-receipt');
    service.read.store.saveNodes(campaignId, nodes);
    expectRpcError(
      () => rewriteProvenance(service, campaignId, generatedId, 'rw-noreceipt', 'https://example.com/no-receipt'),
      -32002,
      'evidence_receipt_missing',
    );
  });

  it('rejects a receipted URI absent from evidence_uris_used (the other single-condition guard branch)', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [seedNodeId] = allNodeIds(service, campaignId);
    const generatedId = importGeneratedNode(service, campaignId, seedNodeId!);
    // Add a retrieval receipt WITHOUT listing the URI in evidence_uris_used.
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const trace = (nodes[generatedId] as Record<string, unknown>).operator_trace as Record<string, unknown>;
    const inputs = trace.inputs as Record<string, unknown>;
    (inputs.retrieval_receipts as Array<Record<string, unknown>>).push({
      source: 'manual fixture receipt',
      uri: 'https://example.com/receipt-only',
    });
    service.read.store.saveNodes(campaignId, nodes);
    expectRpcError(
      () => rewriteProvenance(service, campaignId, generatedId, 'rw-notused', 'https://example.com/receipt-only'),
      -32002,
      'evidence_receipt_missing',
    );
  });

  it('reports delta_claim_updated=false and still rewrites the trace when no card claim carries the prefix', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const [seedNodeId] = allNodeIds(service, campaignId);
    const generatedId = importGeneratedNode(service, campaignId, seedNodeId!);
    // Drop the engine-assembled novelty-delta claim, leaving the base claim so
    // the idea_card stays schema-valid; the rewrite must still correct the
    // trace and report that no card claim was synced.
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const card = (nodes[generatedId] as Record<string, unknown>).idea_card as Record<string, unknown>;
    card.claims = (card.claims as Array<Record<string, unknown>>).filter(
      claim => !String(claim.claim_text).startsWith('Novelty delta vs closest prior ('),
    );
    service.read.store.saveNodes(campaignId, nodes);

    const result = rewriteProvenance(service, campaignId, generatedId, 'rw-noclaim', URI_A);
    expect(result.delta_claim_updated).toBe(false);
    expect(nodeCloseestPrior(loadNode(service, campaignId, generatedId))).toBe(URI_A);
    expect(nodeRewriteHistory(loadNode(service, campaignId, generatedId))).toHaveLength(1);
  });
});
