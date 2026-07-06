import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeaEngineRpcService } from '../src/service/rpc-service.js';
import { RpcError } from '../src/service/errors.js';

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
        prompt_hash: `sha256:${'a'.repeat(64)}`,
        role: 'Generator',
        temperature: 0.7,
        timestamp: '2026-07-06T00:00:00Z',
      },
      parent_node_ids: [],
      prompt_snapshot_hash: `sha256:${'b'.repeat(64)}`,
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
    rejected_candidates: [
      { reason: 'embedding dedup >= 0.95 against an active node', summary: 'near-duplicate of an existing thesis' },
    ],
    trigger: { artifact_ref: 'file:///tmp/survey-artifact.json', kind: 'survey_updated' },
    ...overrides,
  };
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
    const card = node.idea_card as Record<string, unknown>;
    expect(String(card.thesis_statement)).toContain('Resolve the anchored X tension');

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

  it('enforces the family arity table and parent existence', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    const seedNodeId = Object.keys(service.node.store.loadNodes(campaignId))[0]!;

    // Mutation requires exactly one parent
    let pack = mutateCandidate(validPack(campaignId), candidate => {
      const provenance = candidate.provenance as Record<string, unknown>;
      provenance.operator_family = 'Mutation';
      provenance.operator_id = 'mutation.risk_reroute.v1';
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'operator_arity_invalid');

    // Mutation with a nonexistent parent
    pack = mutateCandidate(validPack(campaignId), candidate => {
      const provenance = candidate.provenance as Record<string, unknown>;
      provenance.operator_family = 'Mutation';
      provenance.operator_id = 'mutation.risk_reroute.v1';
      provenance.parent_node_ids = ['zzzzzzzz'];
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32004, 'node_not_found');

    // Mutation with a real parent but no recorded parent revision
    pack = mutateCandidate(validPack(campaignId), candidate => {
      const provenance = candidate.provenance as Record<string, unknown>;
      provenance.operator_family = 'Mutation';
      provenance.operator_id = 'mutation.risk_reroute.v1';
      provenance.parent_node_ids = [seedNodeId];
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'parent_revisions_missing');

    // Same, with the revision recorded: imports and pins parent lineage
    pack = mutateCandidate(
      validPack(campaignId, {
        evidence_snapshot: {
          parent_revisions: { [seedNodeId]: 1 },
          survey_artifact_ref: 'file:///tmp/survey-artifact.json',
        },
      }),
      candidate => {
        const provenance = candidate.provenance as Record<string, unknown>;
        provenance.operator_family = 'Mutation';
        provenance.operator_id = 'mutation.risk_reroute.v1';
        provenance.parent_node_ids = [seedNodeId];
      },
    );
    const result = importPack(service, campaignId, pack, 'import-mutation');
    const nodeId = String((result.imported as Array<Record<string, unknown>>)[0]!.node_id);
    const node = service.node.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
    expect(node.parent_node_ids).toEqual([seedNodeId]);
    const inputs = (node.operator_trace as Record<string, unknown>).inputs as Record<string, unknown>;
    expect(inputs.parent_revisions).toEqual({ [seedNodeId]: 1 });

    // Recombination requires at least two parents
    pack = mutateCandidate(validPack(campaignId), candidate => {
      const provenance = candidate.provenance as Record<string, unknown>;
      provenance.operator_family = 'Recombination';
      provenance.operator_id = 'recombine.method_transfer.v1';
      provenance.parent_node_ids = [seedNodeId];
    });
    expectRpcError(() => importPack(service, campaignId, pack, 'import-recomb'), -32002, 'operator_arity_invalid');

    // AnalogyTransfer requires a non-empty analogy_mapping
    pack = mutateCandidate(validPack(campaignId), candidate => {
      const provenance = candidate.provenance as Record<string, unknown>;
      provenance.operator_family = 'AnalogyTransfer';
      provenance.operator_id = 'analogy.structure_transfer.v1';
    });
    expectRpcError(() => importPack(service, campaignId, pack, 'import-analogy'), -32002, 'operator_arity_invalid');
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

  it('requires failure-ledger references for parentless FailureRouting candidates', () => {
    const service = freshService();
    const campaignId = initCampaign(service);
    let pack = mutateCandidate(
      validPack(campaignId, { trigger: { artifact_ref: 'file:///tmp/failed.jsonl', kind: 'failure_recorded' } }),
      candidate => {
        const provenance = candidate.provenance as Record<string, unknown>;
        provenance.operator_family = 'FailureRouting';
        provenance.operator_id = 'failroute.avoid_dead_end.v1';
      },
    );
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'anchor_missing');

    pack = mutateCandidate(
      validPack(campaignId, { trigger: { artifact_ref: 'file:///tmp/failed.jsonl', kind: 'failure_recorded' } }),
      candidate => {
        const provenance = candidate.provenance as Record<string, unknown>;
        provenance.operator_family = 'FailureRouting';
        provenance.operator_id = 'failroute.avoid_dead_end.v1';
        (provenance.trace_inputs as Record<string, unknown>).failed_approach_refs = ['file:///tmp/failed.jsonl#entry-3'];
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
      const params = (candidate.provenance as Record<string, unknown>).trace_params as Record<string, unknown>;
      params.formalization = { mode: 'spoofed' };
    });
    expectRpcError(() => importPack(service, campaignId, pack), -32002, 'trace_key_reserved');
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
    const twoCandidates = validPack(campaignId, { candidates: [tensionCandidate(), tensionCandidate()] });
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
  });
});
