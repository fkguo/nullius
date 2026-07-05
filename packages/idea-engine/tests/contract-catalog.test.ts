import { describe, expect, it } from 'vitest';
import { ContractRuntimeError, IdeaEngineContractCatalog } from '../src/contracts/catalog.js';

const catalog = new IdeaEngineContractCatalog();

const VALID_PAIRWISE_MATCH = {
  match_id: '11111111-1111-4111-8111-111111111111',
  campaign_id: '22222222-2222-4222-8222-222222222222',
  idea_a_node_id: '33333333-3333-4333-8333-333333333333',
  idea_b_node_id: '44444444-4444-4444-8444-444444444444',
  criteria_commitment: {
    committed_at: '2026-07-05T00:00:00Z',
    criteria: ['mechanism plausibility against cited sources'],
    commitment_hash: `sha256:${'a'.repeat(64)}`,
  },
  panel: [
    {
      reviewer_family: 'claude',
      model: 'claude-fable-5',
      vote: 'a',
      anchored_arguments: [
        {
          argument: 'Idea A rests on a published measurement; idea B extrapolates beyond it.',
          anchor_type: 'literature',
          anchor_ref: 'https://example.org/paper-1',
        },
      ],
      unanchored_arguments_discarded: 2,
    },
    {
      reviewer_family: 'codex',
      model: 'gpt-5.5',
      vote: 'tie',
      anchored_arguments: [],
      unanchored_arguments_discarded: 0,
    },
    {
      reviewer_family: 'opencode',
      model: 'glm-5.2',
      vote: 'a',
      anchored_arguments: [],
      unanchored_arguments_discarded: 0,
    },
  ],
  outcome: {
    // claude='a', codex='tie', opencode='a' -> votes_a=2, votes_b=0, ties=1
    // winner='a', vote_margin = |2-0|/3 = 2/3, matching validate_pairwise_match's recompute.
    winner: 'a',
    vote_margin: 0.6666666666666666,
    decided_at: '2026-07-05T01:00:00Z',
  },
  observation_write: {
    written: true,
    gaia_package_ref: 'file:///external/project/gaia/pkg-7',
  },
};

const VALID_ALLOCATION_DECISION = {
  decision_id: '55555555-5555-4555-8555-555555555555',
  campaign_id: '22222222-2222-4222-8222-222222222222',
  generated_at: '2026-07-05T02:00:00Z',
  method: 'thompson_sampling',
  random_seed: 20260705,
  candidates: [
    {
      node_id: '33333333-3333-4333-8333-333333333333',
      posterior_value: 0.62,
      evidence_count: 5,
      sampled_value: 0.71,
      allocation: 'deep_investment',
      budget_note: 'one focused derivation cycle',
    },
    {
      node_id: '44444444-4444-4444-8444-444444444444',
      posterior_value: 0.31,
      evidence_count: 2,
      sampled_value: 0.28,
      allocation: 'hold',
      budget_note: 'no spend this round',
    },
  ],
  waiting_activation: [
    {
      node_id: '66666666-6666-4666-8666-666666666666',
      activation_condition: {
        kind: 'data_release',
        description: 'next experimental data release',
        satisfied: false,
      },
      last_checked_at: '2026-07-05T02:00:00Z',
    },
  ],
};

describe('contract catalog: decision-layer schemas', () => {
  it('accepts a valid pairwise_match_v1 record', () => {
    expect(() => catalog.validateAgainstRef(
      './pairwise_match_v1.schema.json',
      VALID_PAIRWISE_MATCH,
      'test/pairwise_match/valid',
    )).not.toThrow();
  });

  it('rejects pairwise_match_v1 records with a malformed commitment hash or empty panel', () => {
    const badHash = structuredClone(VALID_PAIRWISE_MATCH);
    badHash.criteria_commitment.commitment_hash = 'sha256:not-hex';
    expect(() => catalog.validateAgainstRef(
      './pairwise_match_v1.schema.json',
      badHash,
      'test/pairwise_match/bad-hash',
    )).toThrow(ContractRuntimeError);

    const emptyPanel = structuredClone(VALID_PAIRWISE_MATCH);
    emptyPanel.panel = [];
    expect(() => catalog.validateAgainstRef(
      './pairwise_match_v1.schema.json',
      emptyPanel,
      'test/pairwise_match/empty-panel',
    )).toThrow(ContractRuntimeError);

    const badFamily = structuredClone(VALID_PAIRWISE_MATCH);
    (badFamily.panel[0] as Record<string, unknown>).reviewer_family = 'gemini';
    expect(() => catalog.validateAgainstRef(
      './pairwise_match_v1.schema.json',
      badFamily,
      'test/pairwise_match/bad-family',
    )).toThrow(ContractRuntimeError);
  });

  it('accepts a valid allocation_decision_v1 record', () => {
    expect(() => catalog.validateAgainstRef(
      './allocation_decision_v1.schema.json',
      VALID_ALLOCATION_DECISION,
      'test/allocation_decision/valid',
    )).not.toThrow();
  });

  it('rejects allocation_decision_v1 records with the wrong method or an unknown allocation', () => {
    const badMethod = structuredClone(VALID_ALLOCATION_DECISION);
    (badMethod as Record<string, unknown>).method = 'greedy';
    expect(() => catalog.validateAgainstRef(
      './allocation_decision_v1.schema.json',
      badMethod,
      'test/allocation_decision/bad-method',
    )).toThrow(ContractRuntimeError);

    const badAllocation = structuredClone(VALID_ALLOCATION_DECISION);
    (badAllocation.candidates[0] as Record<string, unknown>).allocation = 'all_in';
    expect(() => catalog.validateAgainstRef(
      './allocation_decision_v1.schema.json',
      badAllocation,
      'test/allocation_decision/bad-allocation',
    )).toThrow(ContractRuntimeError);

    const badCondition = structuredClone(VALID_ALLOCATION_DECISION);
    delete (badCondition.waiting_activation[0]!.activation_condition as Record<string, unknown>).satisfied;
    expect(() => catalog.validateAgainstRef(
      './allocation_decision_v1.schema.json',
      badCondition,
      'test/allocation_decision/bad-condition',
    )).toThrow(ContractRuntimeError);
  });

  it('validates idea_node_v1 with the portfolio fields and rejects the removed eval_info field', () => {
    const node = {
      campaign_id: '22222222-2222-4222-8222-222222222222',
      idea_id: '77777777-7777-4777-8777-777777777777',
      node_id: '88888888-8888-4888-8888-888888888888',
      revision: 3,
      parent_node_ids: [],
      operator_id: 'seed.import',
      operator_family: 'Seed',
      origin: {
        model: 'seed_pack',
        temperature: 0,
        prompt_hash: `sha256:${'b'.repeat(64)}`,
        timestamp: '2026-07-05T00:00:00Z',
        role: 'SeedImporter',
      },
      operator_trace: {
        inputs: {},
        params: {},
        evidence_uris_used: [],
      },
      rationale_draft: {
        title: 'Portfolio node',
        rationale: 'A candidate idea with an externally computed posterior.',
        risks: ['unverified'],
        kill_criteria: ['fails the first consistency check'],
      },
      idea_card: null,
      lifecycle_state: 'waiting_activation',
      posterior: {
        value: 0.4,
        evidence_count: 2,
        updated_at: '2026-07-05T00:00:00Z',
        gaia_package_ref: 'file:///external/project/gaia/pkg-1',
      },
      activation_condition: {
        kind: 'stage_reached',
        description: 'prerequisite derivation milestone complete',
        satisfied: false,
      },
      grounding_audit: null,
      reduction_report: null,
      reduction_audit: null,
      created_at: '2026-07-05T00:00:00Z',
    };
    expect(() => catalog.validateAgainstRef(
      './idea_node_v1.schema.json',
      node,
      'test/idea_node/portfolio-fields',
    )).not.toThrow();

    const withEvalInfo = { ...structuredClone(node), eval_info: { scores: {} } };
    expect(() => catalog.validateAgainstRef(
      './idea_node_v1.schema.json',
      withEvalInfo,
      'test/idea_node/eval-info-removed',
    )).toThrow(ContractRuntimeError);
  });
});
