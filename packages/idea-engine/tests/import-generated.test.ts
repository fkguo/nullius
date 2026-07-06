import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeaEngineRpcService } from '../src/service/rpc-service.js';
import { RpcError } from '../src/service/errors.js';

const PROMPT_SNAPSHOT_CONTENT = 'rendered generation prompt for the regression tension burst';
const PROMPT_SNAPSHOT_HASH = `sha256:${createHash('sha256').update(PROMPT_SNAPSHOT_CONTENT, 'utf8').digest('hex')}`;

/** Deterministic engine-alphabet id sequence: t0000001, t0000002, ... */
function makeIdSequence(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `t${String(counter).padStart(7, '0')}`;
  };
}

function makeService(rootDir: string): IdeaEngineRpcService {
  return new IdeaEngineRpcService({ createId: makeIdSequence(), rootDir });
}

function initCampaign(
  service: IdeaEngineRpcService,
  budgetOverrides: Record<string, number> = {},
): string {
  const result = service.handle('campaign.init', {
    budget: {
      max_cost_usd: 100.0,
      max_nodes: 100,
      max_steps: 100,
      max_tokens: 100_000,
      max_wall_clock_s: 100_000,
      ...budgetOverrides,
    },
    charter: {
      approval_gate_ref: 'gate://a0.1',
      campaign_name: 'import-generated',
      domain: 'test-domain',
      scope: 'generation import regression fixture',
    },
    idempotency_key: 'init-key',
    seed_pack: {
      seeds: [
        { content: 'seed-one', seed_type: 'text', source_uris: ['https://example.com/seed-1'] },
      ],
    },
  });
  return String(result.campaign_id);
}

const URI_A = 'https://example.com/paper-a';
const URI_B = 'https://example.com/paper-b';

function tensionCandidate(): Record<string, unknown> {
  return {
    card_fields: {
      claims: [
        {
          claim_text: 'source A and source B disagree on the magnitude of effect X',
          evidence_uris: [URI_A, URI_B],
          support_type: 'literature',
        },
        {
          claim_text: 'the proposed mechanism would separate the two accounts',
          support_type: 'llm_inference',
          verification_plan: 'run the bounded first check and compare against both sources',
          evidence_uris: [],
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
      closest_prior: URI_A,
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

function validPack(campaignId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaign_id: campaignId,
    candidates: [tensionCandidate()],
    created_at: '2026-07-06T00:00:00Z',
    evidence_snapshot: {
      survey_artifact_ref: 'file:///tmp/survey-artifact.json',
      survey_content_hash: `sha256:${'c'.repeat(64)}`,
    },
    prompt_snapshots: [
      { content: PROMPT_SNAPSHOT_CONTENT, hash: PROMPT_SNAPSHOT_HASH },
    ],
    rejected_candidates: [
      { reason: 'embedding dedup >= 0.95 against an active node', summary: 'near-duplicate of an existing thesis' },
    ],
    trigger: { artifact_ref: 'file:///tmp/survey-artifact.json', kind: 'survey_updated' },
    ...overrides,
  };
}

/** A second, textually distinct tension candidate (passes the intra-pack backstop). */
function secondTensionCandidate(): Record<string, unknown> {
  const candidate = tensionCandidate();
  const draft = candidate.rationale_draft as Record<string, unknown>;
  draft.title = 'Bound the second anchored discrepancy';
  draft.rationale = 'A separate recorded discrepancy admits a different bounded discriminating check with its own kill criterion.';
  const inputs = (candidate.provenance as Record<string, unknown>).trace_inputs as Record<string, unknown>;
  (inputs.anchor as Record<string, unknown>).statement = 'C and D disagree on the sign of effect Y';
  return candidate;
}

function importPack(
  service: IdeaEngineRpcService,
  campaignId: string,
  pack: Record<string, unknown>,
  key = 'import-key-1',
): Record<string, unknown> {
  return service.handle('node.import_generated', {
    campaign_id: campaignId,
    idempotency_key: key,
    pack,
  });
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

function mutateCandidate(pack: Record<string, unknown>, mutate: (candidate: Record<string, unknown>) => void): Record<string, unknown> {
  const candidate = (pack.candidates as Array<Record<string, unknown>>)[0]!;
  mutate(candidate);
  return pack;
}

interface IdemRecord {
  created_at: string;
  payload_hash: string;
  response: { kind: string; payload: Record<string, unknown> };
  state: string;
}

function idemPath(service: IdeaEngineRpcService, campaignId: string): string {
  return service.node.store.campaignIdempotencyPath(campaignId);
}

function loadIdem(service: IdeaEngineRpcService, campaignId: string): Record<string, IdemRecord> {
  return JSON.parse(readFileSync(idemPath(service, campaignId), 'utf8')) as Record<string, IdemRecord>;
}

function reopenPrepared(service: IdeaEngineRpcService, campaignId: string, key: string): IdemRecord {
  const records = loadIdem(service, campaignId);
  const record = records[`node.import_generated:${key}`]!;
  record.state = 'prepared';
  writeFileSync(idemPath(service, campaignId), `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  return record;
}

function removeNodeFromStore(service: IdeaEngineRpcService, campaignId: string, nodeId: string): void {
  const nodes = service.node.store.loadNodes<Record<string, unknown>>(campaignId);
  delete nodes[nodeId];
  service.node.store.saveNodes(campaignId, nodes);
}

function stripCreateLogLines(service: IdeaEngineRpcService, campaignId: string, nodeId: string): void {
  const logPath = service.node.store.nodesLogPath(campaignId);
  const kept = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .filter(line => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      return !(entry.mutation === 'create' && entry.node_id === nodeId);
    });
  writeFileSync(logPath, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
}

function setNodesUsed(service: IdeaEngineRpcService, campaignId: string, value: number): void {
  const campaign = service.node.store.loadCampaign<Record<string, unknown> & { campaign_id: string }>(campaignId)!;
  (campaign.usage as Record<string, number>).nodes_used = value;
  service.node.store.saveCampaign(campaign);
}

function artifactPathFromRef(ref: string): string {
  return fileURLToPath(ref);
}

function archiveNode(service: IdeaEngineRpcService, campaignId: string, nodeId: string): void {
  const nodes = service.node.store.loadNodes<Record<string, unknown>>(campaignId);
  nodes[nodeId]!.lifecycle_state = 'archived';
  service.node.store.saveNodes(campaignId, nodes);
}

describe('node.import_generated', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function freshService(): IdeaEngineRpcService {
    const dir = mkdtempSync(join(tmpdir(), 'idea-import-'));
    tempDirs.push(dir);
    return makeService(dir);
  }

  it('imports a tension-anchored candidate end to end (provenance, artifact, log, usage)', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const pack = validPack(campaignId);
    const result = importPack(service, campaignId, pack);

    expect(result.imported_count).toBe(1);
    expect(result.rejected_count).toBe(1);
    const entry = (result.imported as Array<Record<string, unknown>>)[0]!;
    const nodeId = String(entry.node_id);
    expect(entry.operator_family).toBe('LiteratureMining');

    const nodes = service.node.store.loadNodes<Record<string, unknown>>(campaignId);
    const node = nodes[nodeId]!;
    expect(node.posterior).toBeNull();
    expect(node.grounding_audit).toBeNull();
    expect(node.lifecycle_state).toBe('active');
    expect(node.parent_node_ids).toEqual([]);
    expect(node.operator_id).toBe('litmine.tension_resolution.v1');
    const trace = node.operator_trace as Record<string, unknown>;
    const inputs = trace.inputs as Record<string, unknown>;
    expect((inputs.trigger as Record<string, unknown>).kind).toBe('survey_updated');
    expect(inputs.pack_artifact).toBe(result.pack_artifact_ref);
    expect((inputs.anchor as Record<string, unknown>).kind).toBe('tension');
    const params = trace.params as Record<string, unknown>;
    const formalization = params.formalization as Record<string, unknown>;
    expect(formalization.mode).toBe('explain_then_formalize_deterministic_v1');
    expect(formalization.source_artifact).toBe('rationale_draft');
    expect(String(formalization.rationale_hash)).toMatch(/^sha256:[a-f0-9]{64}$/);
    // engine-injected audit surface on the NODE, not only the archived pack
    expect(inputs.target_admission_route).toBe('open_problem');
    expect((inputs.dedup as Record<string, unknown>).decision).toBe('unique');
    expect((inputs.novelty_delta as Record<string, unknown>).delta_type).toBe('new_mechanism');
    const card = node.idea_card as Record<string, unknown>;
    expect(String(card.thesis_statement)).toContain('Resolve the anchored X tension');
    // the novelty delta enters the card as an auditable llm_inference claim
    const claims = card.claims as Array<Record<string, unknown>>;
    expect(claims).toHaveLength(3);
    const deltaClaim = claims[2]!;
    expect(deltaClaim.support_type).toBe('llm_inference');
    expect(String(deltaClaim.claim_text)).toContain('Novelty delta vs closest prior');
    expect(deltaClaim.evidence_uris).toEqual([URI_A]);

    // pack artifact archived verbatim, including the operator's own rejects
    const artifactFile = artifactPathFromRef(String(result.pack_artifact_ref));
    expect(existsSync(artifactFile)).toBe(true);
    const archive = JSON.parse(readFileSync(artifactFile, 'utf8')) as Record<string, unknown>;
    expect(archive.pack_hash).toBe(result.pack_hash);
    expect((archive.pack as Record<string, unknown>).rejected_candidates).toEqual(pack.rejected_candidates);
    const assembled = (archive.engine_assembled as Record<string, unknown>).nodes as Record<string, unknown>;
    expect(Object.keys(assembled)).toEqual([nodeId]);

    // node log carries exactly one create entry for the imported node
    const logLines = readFileSync(service.node.store.nodesLogPath(campaignId), 'utf8')
      .split('\n').filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const createEntries = logLines.filter(line => line.mutation === 'create' && line.node_id === nodeId);
    expect(createEntries).toHaveLength(1);
    expect(createEntries[0]!.method).toBe('node.import_generated');

    // usage: nodes consumed, steps NOT consumed
    const status = service.handle('campaign.status', { campaign_id: campaignId });
    expect(status.node_count).toBe(2);
    const snapshot = status.budget_snapshot as Record<string, unknown>;
    expect(snapshot.nodes_used).toBe(2);
    expect(snapshot.steps_used).toBe(0);
  });

  it('generated nodes satisfy the promote formalization gate once evaluation artifacts arrive', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const result = importPack(service, campaignId, validPack(campaignId));
    const nodeId = String((result.imported as Array<Record<string, unknown>>)[0]!.node_id);

    const nodes = service.node.store.loadNodes<Record<string, unknown>>(campaignId);
    nodes[nodeId]!.grounding_audit = {
      failures: [],
      folklore_risk_score: 0.1,
      status: 'pass',
      timestamp: '2026-07-06T00:00:00Z',
    };
    service.node.store.saveNodes(campaignId, nodes);
    service.handle('node.set_posterior', {
      campaign_id: campaignId,
      idempotency_key: 'posterior-1',
      node_id: nodeId,
      posterior: { evidence_count: 2, value: 0.7 },
    });

    const promoted = service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-1',
      node_id: nodeId,
    });
    expect(String(promoted.handoff_artifact_ref)).toContain('handoff');
  });

  it('replays the identical import without re-importing and rejects key reuse with a different pack', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const first = importPack(service, campaignId, validPack(campaignId));
    const again = importPack(service, campaignId, validPack(campaignId));
    expect((again.idempotency as Record<string, unknown>).is_replay).toBe(true);
    expect(again.imported).toEqual(first.imported);
    expect(Object.keys(service.node.store.loadNodes(campaignId))).toHaveLength(2);

    const conflicting = validPack(campaignId);
    (conflicting.trigger as Record<string, unknown>).kind = 'manual';
    delete (conflicting.trigger as Record<string, unknown>).artifact_ref;
    expectRpcError(
      () => importPack(service, campaignId, conflicting),
      -32002,
      'idempotency_key_conflict',
    );
  });

  it('rejects a pack whose campaign_id disagrees with the param', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const pack = validPack(campaignId, { campaign_id: 'zzzzzzzz' });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'pack_campaign_mismatch');
  });

  it('rejects unknown operator families, including Seed', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    for (const family of ['IslandEvolution', 'Seed']) {
      const pack = mutateCandidate(validPack(campaignId), candidate => {
        (candidate.provenance as Record<string, unknown>).operator_family = family;
      });
      expectRpcError(() => importPack(service, campaignId, pack), -32002, 'operator_family_unknown');
    }
  });

  it('rejects committed-but-not-enabled families like reserved triggers', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    for (const [family, operatorId] of [
      ['Mutation', 'mutation.risk_reroute.v1'],
      ['Recombination', 'recombine.method_transfer.v1'],
      ['AnalogyTransfer', 'analogy.structure_transfer.v1'],
    ] as const) {
      const pack = mutateCandidate(validPack(campaignId), candidate => {
        const provenance = candidate.provenance as Record<string, unknown>;
        provenance.operator_family = family;
        provenance.operator_id = operatorId;
      });
      const error = expectRpcError(() => importPack(service, campaignId, pack), -32002, 'operator_family_not_enabled');
      expect((error.data.details as Record<string, unknown>).enabled).toEqual(['LiteratureMining', 'FailureRouting']);
    }
  });

  it('enforces arity, parent existence, and honest parent revisions', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const seedNodeId = Object.keys(service.node.store.loadNodes(campaignId))[0]!;
    const failureTrigger = { artifact_ref: 'file:///tmp/failed.jsonl', kind: 'failure_recorded' };
    const asFailureRouting = (candidate: Record<string, unknown>, parents: string[]) => {
      const provenance = candidate.provenance as Record<string, unknown>;
      provenance.operator_family = 'FailureRouting';
      provenance.operator_id = 'failroute.avoid_dead_end.v1';
      provenance.parent_node_ids = parents;
    };

    // LiteratureMining requires exactly zero parents
    let pack = mutateCandidate(validPack(campaignId, {
      evidence_snapshot: {
        parent_revisions: { [seedNodeId]: 1 },
        survey_artifact_ref: 'file:///tmp/survey-artifact.json',
        survey_content_hash: `sha256:${'c'.repeat(64)}`,
      },
    }), candidate => {
      (candidate.provenance as Record<string, unknown>).parent_node_ids = [seedNodeId];
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'operator_arity_invalid');

    // duplicate parents are refused before arity counts them twice
    pack = mutateCandidate(validPack(campaignId, { trigger: failureTrigger }), candidate => {
      asFailureRouting(candidate, [seedNodeId, seedNodeId]);
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'operator_arity_invalid');

    // nonexistent parent
    pack = mutateCandidate(validPack(campaignId, { trigger: failureTrigger }), candidate => {
      asFailureRouting(candidate, ['zzzzzzzz']);
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32004, 'node_not_found');

    // real parent but no recorded read-time revision
    pack = mutateCandidate(validPack(campaignId, { trigger: failureTrigger }), candidate => {
      asFailureRouting(candidate, [seedNodeId]);
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'parent_revisions_missing');

    // fabricated FUTURE revision is refused
    pack = mutateCandidate(validPack(campaignId, {
      evidence_snapshot: { parent_revisions: { [seedNodeId]: 7 } },
      trigger: failureTrigger,
    }), candidate => {
      asFailureRouting(candidate, [seedNodeId]);
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'parent_revision_invalid');

    // a parented FailureRouting candidate must reroute an ARCHIVED parent
    pack = mutateCandidate(validPack(campaignId, {
      evidence_snapshot: { parent_revisions: { [seedNodeId]: 1 } },
      trigger: failureTrigger,
    }), candidate => {
      asFailureRouting(candidate, [seedNodeId]);
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'anchor_missing');

    // honest revision + archived parent imports and pins parent lineage
    archiveNode(service, campaignId, seedNodeId);
    pack = mutateCandidate(validPack(campaignId, {
      evidence_snapshot: { parent_revisions: { [seedNodeId]: 1 } },
      trigger: failureTrigger,
    }), candidate => {
      asFailureRouting(candidate, [seedNodeId]);
    });
    const result = importPack(service, campaignId, pack, 'import-failroute-parented');
    const nodeId = String((result.imported as Array<Record<string, unknown>>)[0]!.node_id);
    const node = service.node.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
    expect(node.parent_node_ids).toEqual([seedNodeId]);
    const inputs = (node.operator_trace as Record<string, unknown>).inputs as Record<string, unknown>;
    expect(inputs.parent_revisions).toEqual({ [seedNodeId]: 1 });
  });

  it('rejects reserved vocabulary triggers and non-manual triggers without an artifact_ref', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    let pack = validPack(campaignId, { trigger: { artifact_ref: 'file:///tmp/match.json', kind: 'match_concluded' } });
    const error = expectRpcError(() => importPack(service, campaignId, pack), -32002, 'trigger_not_enabled');
    expect((error.data.details as Record<string, unknown>).enabled).toEqual(['manual', 'survey_updated', 'failure_recorded']);

    pack = validPack(campaignId, { trigger: { kind: 'survey_updated' } });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'trigger_not_enabled');
  });

  it('enforces retrieval receipts for every evidence URI (no receipt, no URI)', () => {
    const service = freshService();
    const campaignId = initCampaign(service);

    // claim URI missing from evidence_uris_used
    let pack = mutateCandidate(validPack(campaignId), candidate => {
      (candidate.provenance as Record<string, unknown>).evidence_uris_used = [URI_A];
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'evidence_receipt_missing');

    // URI without a receipt
    pack = mutateCandidate(validPack(campaignId), candidate => {
      const inputs = (candidate.provenance as Record<string, unknown>).trace_inputs as Record<string, unknown>;
      inputs.retrieval_receipts = [{ source: 'literature_survey_v1#papers/refA', uri: URI_A }];
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'evidence_receipt_missing');
  });

  it('bans the seed placeholder evidence URI outright', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const pack = mutateCandidate(validPack(campaignId), candidate => {
      const provenance = candidate.provenance as Record<string, unknown>;
      provenance.evidence_uris_used = [URI_A, URI_B, 'https://example.org/reference'];
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'placeholder_evidence_forbidden');
  });

  it('requires a survey anchor for LiteratureMining and re-anchored references for gaps', () => {
    const service = freshService();
    const campaignId = initCampaign(service);

    let pack = mutateCandidate(validPack(campaignId), candidate => {
      const inputs = (candidate.provenance as Record<string, unknown>).trace_inputs as Record<string, unknown>;
      delete inputs.anchor;
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'anchor_missing');

    pack = mutateCandidate(validPack(campaignId), candidate => {
      const inputs = (candidate.provenance as Record<string, unknown>).trace_inputs as Record<string, unknown>;
      inputs.anchor = { kind: 'gap', statement: 'nobody has measured effect X under condition Z' };
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'gap_unanchored');

    pack = mutateCandidate(validPack(campaignId), candidate => {
      const inputs = (candidate.provenance as Record<string, unknown>).trace_inputs as Record<string, unknown>;
      inputs.anchor = {
        kind: 'gap',
        resolved_refs: ['https://example.com/paper-c'],
        statement: 'nobody has measured effect X under condition Z',
      };
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'gap_unanchored');

    // resolved AND receipted gap imports fine
    pack = mutateCandidate(validPack(campaignId), candidate => {
      const inputs = (candidate.provenance as Record<string, unknown>).trace_inputs as Record<string, unknown>;
      inputs.anchor = {
        kind: 'gap',
        resolved_refs: [URI_A],
        statement: 'nobody has measured effect X under condition Z',
      };
    });
    const result = importPack(service, campaignId, pack, 'import-gap');
    expect(result.imported_count).toBe(1);
  });

  it('requires pinned failure-ledger references for parentless FailureRouting candidates', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const failureTrigger = { artifact_ref: 'file:///tmp/failed.jsonl', kind: 'failure_recorded' };
    const asFailureRouting = (candidate: Record<string, unknown>) => {
      const provenance = candidate.provenance as Record<string, unknown>;
      provenance.operator_family = 'FailureRouting';
      provenance.operator_id = 'failroute.avoid_dead_end.v1';
    };

    // no refs at all
    let pack = mutateCandidate(validPack(campaignId, { trigger: failureTrigger }), asFailureRouting);
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'anchor_missing');

    // refs present but NOT pinned in evidence_snapshot.failed_approach_refs
    pack = mutateCandidate(validPack(campaignId, { trigger: failureTrigger }), candidate => {
      asFailureRouting(candidate);
      ((candidate.provenance as Record<string, unknown>).trace_inputs as Record<string, unknown>)
        .failed_approach_refs = ['file:///tmp/failed.jsonl#entry-3'];
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'anchor_missing');

    // pinned refs import
    pack = mutateCandidate(
      validPack(campaignId, {
        evidence_snapshot: { failed_approach_refs: ['file:///tmp/failed.jsonl#entry-3'] },
        trigger: failureTrigger,
      }),
      candidate => {
        asFailureRouting(candidate);
        ((candidate.provenance as Record<string, unknown>).trace_inputs as Record<string, unknown>)
          .failed_approach_refs = ['file:///tmp/failed.jsonl#entry-3'];
      },
    );
    const result = importPack(service, campaignId, pack, 'import-failroute');
    expect(result.imported_count).toBe(1);
  });

  it('declares parameter tweaks and rewordings non-novel', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const pack = mutateCandidate(validPack(campaignId), candidate => {
      (candidate.novelty_delta as Record<string, unknown>).delta_type = 'parameter_tweak';
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'novelty_delta_non_novel');
  });

  it('rejects generator-supplied engine-owned trace keys', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    let pack = mutateCandidate(validPack(campaignId), candidate => {
      const inputs = (candidate.provenance as Record<string, unknown>).trace_inputs as Record<string, unknown>;
      inputs.trigger = { kind: 'manual' };
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'trace_key_reserved');

    pack = mutateCandidate(validPack(campaignId), candidate => {
      const inputs = (candidate.provenance as Record<string, unknown>).trace_inputs as Record<string, unknown>;
      inputs.novelty_delta = { spoofed: true };
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'trace_key_reserved');

    pack = mutateCandidate(validPack(campaignId), candidate => {
      const params = (candidate.provenance as Record<string, unknown>).trace_params as Record<string, unknown>;
      params.formalization = { mode: 'spoofed' };
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'trace_key_reserved');
  });

  it('bans the placeholder URI anywhere in the candidate, including gap anchors and receipts', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const pack = mutateCandidate(validPack(campaignId), candidate => {
      const inputs = (candidate.provenance as Record<string, unknown>).trace_inputs as Record<string, unknown>;
      inputs.anchor = {
        kind: 'gap',
        resolved_refs: ['https://example.org/reference'],
        statement: 'a gap the generator failed to actually re-anchor',
      };
      (inputs.retrieval_receipts as Array<Record<string, unknown>>).push(
        { source: 'self-written-fabricated-receipt', uri: 'https://example.org/reference' },
      );
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'placeholder_evidence_forbidden');
  });

  it('requires receipts for rationale_draft.references and URI-shaped closest_prior', () => {
    const service = freshService();
    const campaignId = initCampaign(service);

    // a bibliography entry with no receipt is a fabricated-decoration vector
    let pack = mutateCandidate(validPack(campaignId), candidate => {
      (candidate.rationale_draft as Record<string, unknown>).references = ['https://example.com/unfetched-decoration'];
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'evidence_receipt_missing');

    // URI-shaped closest_prior must itself be receipted
    pack = mutateCandidate(validPack(campaignId), candidate => {
      (candidate.novelty_delta as Record<string, unknown>).closest_prior = 'https://example.com/never-retrieved';
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'evidence_receipt_missing');

    // a survey ref_key closest_prior needs no receipt; the injected delta claim then carries no URI
    pack = mutateCandidate(validPack(campaignId), candidate => {
      (candidate.novelty_delta as Record<string, unknown>).closest_prior = 'refA';
    });
    const result = importPack(service, campaignId, pack, 'import-refkey-prior');
    const nodeId = String((result.imported as Array<Record<string, unknown>>)[0]!.node_id);
    const card = service.node.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!.idea_card as Record<string, unknown>;
    const deltaClaim = (card.claims as Array<Record<string, unknown>>)[2]!;
    expect(deltaClaim.evidence_uris).toEqual([]);
  });

  it('requires a pinned survey snapshot for LiteratureMining and refuses invalid anchor kinds', () => {
    const service = freshService();
    const campaignId = initCampaign(service);

    let pack = validPack(campaignId, {
      evidence_snapshot: {},
      trigger: { kind: 'manual' },
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'evidence_snapshot_missing');

    pack = mutateCandidate(validPack(campaignId), candidate => {
      const inputs = (candidate.provenance as Record<string, unknown>).trace_inputs as Record<string, unknown>;
      inputs.anchor = { kind: 'vibe', statement: 'not a recognized anchor kind' };
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'anchor_missing');
  });

  it('refuses intra-pack duplicates and self-contradictory dedup records', () => {
    const service = freshService();
    const campaignId = initCampaign(service);

    const twins = validPack(campaignId, { candidates: [tensionCandidate(), tensionCandidate()] });
    const error = expectRpcError(() => importPack(service, campaignId, twins), -32002, 'intra_pack_duplicate');
    expect((error.data.details as Record<string, unknown>).duplicate_of).toBe(0);

    const contradictory = mutateCandidate(validPack(campaignId), candidate => {
      candidate.dedup = { decision: 'unique', method: 'charngram-cosine-v1', nearest_similarity: 0.99 };
    });
    expectRpcError(() => importPack(service, campaignId, contradictory), -32002, 'dedup_inconsistent');
  });

  it('verifies prompt snapshots: declared hashes must be backed by matching archived content', () => {
    const service = freshService();
    const campaignId = initCampaign(service);

    // declared hash with no snapshots at all
    let pack = validPack(campaignId, {});
    delete (pack as Record<string, unknown>).prompt_snapshots;
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'prompt_snapshot_missing');

    // snapshot entry whose content does not hash to its declared hash
    pack = validPack(campaignId, {
      prompt_snapshots: [{ content: 'different content entirely', hash: PROMPT_SNAPSHOT_HASH }],
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'prompt_snapshot_missing');

    // prompt provenance is MANDATORY: a candidate without a declared hash is refused
    pack = mutateCandidate(validPack(campaignId), candidate => {
      delete (candidate.provenance as Record<string, unknown>).prompt_snapshot_hash;
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'prompt_snapshot_missing');

    // origin.prompt_hash hashes the same rendered prompt and must agree
    pack = mutateCandidate(validPack(campaignId), candidate => {
      ((candidate.provenance as Record<string, unknown>).origin as Record<string, unknown>)
        .prompt_hash = `sha256:${'d'.repeat(64)}`;
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'prompt_snapshot_missing');
  });

  it('refuses imports while the campaign is paused', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    service.handle('campaign.pause', { campaign_id: campaignId, idempotency_key: 'pause-1' });
    expectRpcError(() => importPack(service, campaignId, validPack(campaignId)), -32015, 'campaign_not_active');
  });

  it('never overwrites a previously archived pack when the id generator collides', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const first = importPack(service, campaignId, validPack(campaignId));
    const firstArtifact = artifactPathFromRef(String(first.pack_artifact_ref));
    const firstBytes = readFileSync(firstArtifact);

    // force the deterministic id sequence to restart, so the second import
    // draws exactly the ids the first import used
    const collidingService = new IdeaEngineRpcService({
      createId: makeIdSequence(),
      rootDir: service.node.store.rootDir,
    });
    const second = collidingService.handle('node.import_generated', {
      campaign_id: campaignId,
      idempotency_key: 'import-collide',
      pack: validPack(campaignId, { candidates: [secondTensionCandidate()] }),
    });
    expect(second.pack_artifact_ref).not.toBe(first.pack_artifact_ref);
    expect(readFileSync(firstArtifact)).toEqual(firstBytes);
  });

  it('surfaces a held mutation lock as store_locked and reclaims stale locks from dead holders', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const lockPath = join(service.node.store.campaignDir(campaignId), '.lock.lck');

    // stale lock from a provably dead process: reclaimed, import succeeds
    writeFileSync(lockPath, JSON.stringify({ created_at: '2026-07-06T00:00:00Z', pid: 999999999 }), 'utf8');
    const result = importPack(service, campaignId, validPack(campaignId));
    expect(result.imported_count).toBe(1);

    // lock held by a live process (ourselves): distinct store_locked error
    writeFileSync(lockPath, JSON.stringify({ created_at: new Date().toISOString(), pid: process.pid }), 'utf8');
    const error = expectRpcError(
      () => importPack(service, campaignId, validPack(campaignId, { candidates: [secondTensionCandidate()] }), 'import-locked'),
      -32603,
      'store_locked',
    );
    expect((error.data.details as Record<string, unknown>).holder_pid).toBe(process.pid);
    rmSync(lockPath, { force: true });

    // zero-byte lock (crash between create and pid write): fresh -> still
    // locked (a live acquirer passes through that window); old -> reclaimed
    writeFileSync(lockPath, '', 'utf8');
    expectRpcError(
      () => importPack(service, campaignId, validPack(campaignId, { candidates: [secondTensionCandidate()] }), 'import-locked-2'),
      -32603,
      'store_locked',
    );
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);
    const recovered = importPack(service, campaignId, validPack(campaignId, { candidates: [secondTensionCandidate()] }), 'import-after-empty-lock');
    expect(recovered.imported_count).toBe(1);
  });

  it('rejects flagged dedup without an explicit override at the schema layer', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const pack = mutateCandidate(validPack(campaignId), candidate => {
      candidate.dedup = { decision: 'flagged', method: 'charngram-cosine-v1' };
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'schema_invalid');
  });

  it('enforces the nodes budget batch-atomically and flips the campaign to exhausted at the cap', () => {
    const service = freshService();
    const campaignId = initCampaign(service, { max_nodes: 2 });

    // batch of 2 would exceed max_nodes=2 (1 seed already present)
    const twoCandidates = validPack(campaignId, { candidates: [tensionCandidate(), secondTensionCandidate()] });
    const error = expectRpcError(() => importPack(service, campaignId, twoCandidates), -32001, 'dimension_exhausted');
    expect((error.data.details as Record<string, unknown>).exhausted_dimensions).toEqual(['nodes']);
    expect(Object.keys(service.node.store.loadNodes(campaignId))).toHaveLength(1);

    // batch of 1 fits exactly and exhausts the campaign
    const result = importPack(service, campaignId, validPack(campaignId), 'import-fit');
    expect(result.imported_count).toBe(1);
    const status = service.handle('campaign.status', { campaign_id: campaignId });
    expect(status.status).toBe('exhausted');

    // further imports are refused by the campaign state gate
    expectRpcError(() => importPack(service, campaignId, validPack(campaignId), 'import-over'), -32001, 'dimension_exhausted');
  });

  describe('crash recovery (prepared-record drills)', () => {
    function importedNodeId(result: Record<string, unknown>): string {
      return String((result.imported as Array<Record<string, unknown>>)[0]!.node_id);
    }

    it('re-executes freshly when nothing landed (prepared record only)', () => {
      const service = freshService();
      const campaignId = initCampaign(service);
      const result = importPack(service, campaignId, validPack(campaignId));
      const nodeId = importedNodeId(result);

      // wind the store back to the crash point: prepared record, zero effects
      unlinkSync(artifactPathFromRef(String(result.pack_artifact_ref)));
      removeNodeFromStore(service, campaignId, nodeId);
      stripCreateLogLines(service, campaignId, nodeId);
      setNodesUsed(service, campaignId, 1);
      reopenPrepared(service, campaignId, 'import-key-1');

      const retry = importPack(service, campaignId, validPack(campaignId));
      expect((retry.idempotency as Record<string, unknown>).is_replay).toBe(false);
      const retryNodeId = importedNodeId(retry);
      expect(retryNodeId).not.toBe(nodeId); // fresh execution is allowed to re-mint: nothing had landed
      const nodes = service.node.store.loadNodes<Record<string, unknown>>(campaignId);
      expect(nodes[retryNodeId]).toBeDefined();
      expect(nodes[nodeId]).toBeUndefined();
      expect(Object.keys(nodes)).toHaveLength(2);
    });

    it('completes a partially landed import from the archived pack without re-minting', () => {
      const service = freshService();
      const campaignId = initCampaign(service);
      const result = importPack(service, campaignId, validPack(campaignId));
      const nodeId = importedNodeId(result);

      // crash after the pack artifact write: nodes/log/usage missing
      removeNodeFromStore(service, campaignId, nodeId);
      stripCreateLogLines(service, campaignId, nodeId);
      setNodesUsed(service, campaignId, 1);
      reopenPrepared(service, campaignId, 'import-key-1');

      const retry = importPack(service, campaignId, validPack(campaignId));
      expect((retry.idempotency as Record<string, unknown>).is_replay).toBe(true);
      expect(importedNodeId(retry)).toBe(nodeId); // completion, not re-mint
      const nodes = service.node.store.loadNodes<Record<string, unknown>>(campaignId);
      expect(nodes[nodeId]).toBeDefined();
      expect(Object.keys(nodes)).toHaveLength(2);
      const logLines = readFileSync(service.node.store.nodesLogPath(campaignId), 'utf8')
        .split('\n').filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .filter(line => line.mutation === 'create' && line.node_id === nodeId);
      expect(logLines).toHaveLength(1);
      const campaign = service.node.store.loadCampaign<Record<string, unknown>>(campaignId)!;
      expect((campaign.usage as Record<string, number>).nodes_used).toBe(2);
    });

    it('completes missing log entries and usage when only the node landed', () => {
      const service = freshService();
      const campaignId = initCampaign(service);
      const result = importPack(service, campaignId, validPack(campaignId));
      const nodeId = importedNodeId(result);

      stripCreateLogLines(service, campaignId, nodeId);
      setNodesUsed(service, campaignId, 1);
      reopenPrepared(service, campaignId, 'import-key-1');

      const retry = importPack(service, campaignId, validPack(campaignId));
      expect((retry.idempotency as Record<string, unknown>).is_replay).toBe(true);
      expect(importedNodeId(retry)).toBe(nodeId);
      const logLines = readFileSync(service.node.store.nodesLogPath(campaignId), 'utf8')
        .split('\n').filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .filter(line => line.mutation === 'create' && line.node_id === nodeId);
      expect(logLines).toHaveLength(1);
      const campaign = service.node.store.loadCampaign<Record<string, unknown>>(campaignId)!;
      expect((campaign.usage as Record<string, number>).nodes_used).toBe(2);
    });

    it('tolerates legitimate post-import mutations during recovery (immutable projection only)', () => {
      const service = freshService();
      const campaignId = initCampaign(service);
      const result = importPack(service, campaignId, validPack(campaignId));
      const nodeId = importedNodeId(result);

      // evaluation moved the node between crash and retry: posterior written
      service.handle('node.set_posterior', {
        campaign_id: campaignId,
        idempotency_key: 'posterior-mid-crash',
        node_id: nodeId,
        posterior: { evidence_count: 1, value: 0.4 },
      });
      stripCreateLogLines(service, campaignId, nodeId);
      reopenPrepared(service, campaignId, 'import-key-1');

      const retry = importPack(service, campaignId, validPack(campaignId));
      expect((retry.idempotency as Record<string, unknown>).is_replay).toBe(true);
      const node = service.node.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
      expect((node.posterior as Record<string, unknown>).value).toBe(0.4); // recovery must not clobber evaluation
    });

    it('refuses recovery when a stored node disagrees on immutable fields', () => {
      const service = freshService();
      const campaignId = initCampaign(service);
      const result = importPack(service, campaignId, validPack(campaignId));
      const nodeId = importedNodeId(result);

      const nodes = service.node.store.loadNodes<Record<string, unknown>>(campaignId);
      nodes[nodeId]!.operator_id = 'tampered.v1';
      service.node.store.saveNodes(campaignId, nodes);
      reopenPrepared(service, campaignId, 'import-key-1');

      const error = expectRpcError(
        () => importPack(service, campaignId, validPack(campaignId)),
        -32603,
        'import_recovery_conflict',
      );
      expect(String((error.data.details as Record<string, unknown>).message)).toContain('immutable');
    });

    it('refuses recovery when the pack artifact vanished but nodes landed', () => {
      const service = freshService();
      const campaignId = initCampaign(service);
      const result = importPack(service, campaignId, validPack(campaignId));

      unlinkSync(artifactPathFromRef(String(result.pack_artifact_ref)));
      reopenPrepared(service, campaignId, 'import-key-1');

      expectRpcError(
        () => importPack(service, campaignId, validPack(campaignId)),
        -32603,
        'import_recovery_conflict',
      );
    });

    it('refuses recovery when the archived pack no longer matches the recorded pack_hash', () => {
      const service = freshService();
      const campaignId = initCampaign(service);
      const result = importPack(service, campaignId, validPack(campaignId));
      const artifactFile = artifactPathFromRef(String(result.pack_artifact_ref));
      const archive = JSON.parse(readFileSync(artifactFile, 'utf8')) as Record<string, unknown>;
      ((archive.pack as Record<string, unknown>).trigger as Record<string, unknown>).kind = 'manual';
      writeFileSync(artifactFile, JSON.stringify(archive), 'utf8');
      reopenPrepared(service, campaignId, 'import-key-1');

      expectRpcError(
        () => importPack(service, campaignId, validPack(campaignId)),
        -32603,
        'import_recovery_conflict',
      );
    });

    it('refuses recovery when the archived assembled node payload was tampered', () => {
      const service = freshService();
      const campaignId = initCampaign(service);
      const result = importPack(service, campaignId, validPack(campaignId));
      const nodeId = importedNodeId(result);
      const artifactFile = artifactPathFromRef(String(result.pack_artifact_ref));
      const archive = JSON.parse(readFileSync(artifactFile, 'utf8')) as Record<string, unknown>;
      const assembled = (archive.engine_assembled as Record<string, unknown>).nodes as Record<string, Record<string, unknown>>;
      assembled[nodeId]!.operator_id = 'tampered.v1'; // pack untouched; only the completion source is corrupted
      writeFileSync(artifactFile, JSON.stringify(archive), 'utf8');
      removeNodeFromStore(service, campaignId, nodeId);
      stripCreateLogLines(service, campaignId, nodeId);
      setNodesUsed(service, campaignId, 1);
      reopenPrepared(service, campaignId, 'import-key-1');

      expectRpcError(
        () => importPack(service, campaignId, validPack(campaignId)),
        -32603,
        'import_recovery_conflict',
      );
      // the tampered payload must NOT have been imported
      expect(service.node.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]).toBeUndefined();
    });

    it('refuses recovery when the archive lacks an assembled node the result recorded', () => {
      const service = freshService();
      const campaignId = initCampaign(service);
      const result = importPack(service, campaignId, validPack(campaignId));
      const nodeId = importedNodeId(result);
      const artifactFile = artifactPathFromRef(String(result.pack_artifact_ref));
      const archive = JSON.parse(readFileSync(artifactFile, 'utf8')) as Record<string, unknown>;
      delete ((archive.engine_assembled as Record<string, unknown>).nodes as Record<string, unknown>)[nodeId];
      writeFileSync(artifactFile, JSON.stringify(archive), 'utf8');
      removeNodeFromStore(service, campaignId, nodeId);
      reopenPrepared(service, campaignId, 'import-key-1');

      expectRpcError(
        () => importPack(service, campaignId, validPack(campaignId)),
        -32603,
        'import_recovery_conflict',
      );
    });

    it('completes a multi-candidate import with a partially written log, healing a torn line', () => {
      const service = freshService();
      const campaignId = initCampaign(service);
      const pack = validPack(campaignId, { candidates: [tensionCandidate(), secondTensionCandidate()] });
      const result = importPack(service, campaignId, pack);
      const ids = (result.imported as Array<Record<string, unknown>>).map(entry => String(entry.node_id));

      // crash mid-append: first create entry landed, second is a torn fragment
      stripCreateLogLines(service, campaignId, ids[1]!);
      const logPath = service.node.store.nodesLogPath(campaignId);
      const torn = readFileSync(logPath, 'utf8') + `{"mutation":"create","node_id":"${ids[1]}`;
      writeFileSync(logPath, torn, 'utf8');
      setNodesUsed(service, campaignId, 1);
      reopenPrepared(service, campaignId, 'import-key-1');

      const retry = importPack(service, campaignId, pack);
      expect((retry.idempotency as Record<string, unknown>).is_replay).toBe(true);
      const lines = readFileSync(logPath, 'utf8').split('\n').filter(line => line.trim().length > 0);
      const parsed: Array<Record<string, unknown>> = [];
      let unparseable = 0;
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          unparseable += 1;
        }
      }
      expect(unparseable).toBe(1); // the torn fragment stays behind as its own bad line
      for (const nodeId of ids) {
        expect(parsed.filter(entry => entry.mutation === 'create' && entry.node_id === nodeId)).toHaveLength(1);
      }
      const campaign = service.node.store.loadCampaign<Record<string, unknown>>(campaignId)!;
      expect((campaign.usage as Record<string, number>).nodes_used).toBe(3);
    });

    it('flips a running campaign to exhausted when recovery completion reaches the nodes cap', () => {
      const service = freshService();
      const campaignId = initCampaign(service, { max_nodes: 2 });
      const result = importPack(service, campaignId, validPack(campaignId));
      const nodeId = importedNodeId(result);

      // wind back: node missing, usage under cap, campaign forced back to running
      removeNodeFromStore(service, campaignId, nodeId);
      stripCreateLogLines(service, campaignId, nodeId);
      setNodesUsed(service, campaignId, 1);
      const campaign = service.node.store.loadCampaign<Record<string, unknown> & { campaign_id: string }>(campaignId)!;
      campaign.status = 'running';
      service.node.store.saveCampaign(campaign);
      reopenPrepared(service, campaignId, 'import-key-1');

      const retry = importPack(service, campaignId, validPack(campaignId));
      expect((retry.idempotency as Record<string, unknown>).is_replay).toBe(true);
      const after = service.node.store.loadCampaign<Record<string, unknown>>(campaignId)!;
      expect((after.usage as Record<string, number>).nodes_used).toBe(2);
      expect(after.status).toBe('exhausted');
    });
  });
});
