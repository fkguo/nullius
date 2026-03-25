import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeaEngineContractCatalog } from '../src/contracts/catalog.js';
import { IdeaEngineStore } from '../src/store/engine-store.js';
import { buildDistributorActionId, type DistributorAction } from '../src/service/distributor-action-space.js';
import { advanceDiscountedUcbState, initializeDistributorState, recordDiscountedUcbOutcome, selectDiscountedUcbAction } from '../src/service/distributor-discounted-ucb-v.js';
import { DISTRIBUTOR_POLICY_FAMILY, DISTRIBUTOR_POLICY_ID, type DistributorPolicyConfigRecord } from '../src/service/distributor-config.js';
import { loadDistributorState, saveDistributorState } from '../src/service/distributor-state.js';
import type { SearchOperator } from '../src/service/search-operator.js';

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-03-25T00:00:00Z';

function makeAction(suffix: string): DistributorAction {
  const backendId = `backend-${suffix}`;
  const operatorId = `op-${suffix}`;
  const operator: SearchOperator = { descriptor: { backendId, operatorFamily: `Family${suffix.toUpperCase()}`, operatorId }, run: () => { throw new Error('not used in distributor-policy unit tests'); } };
  return { actionId: buildDistributorActionId(backendId, operatorId, 'island-0'), backendId, islandId: 'island-0', operator, operatorFamily: operator.descriptor.operatorFamily, operatorId };
}

function buildConfig(actions: DistributorAction[]): DistributorPolicyConfigRecord {
  return {
    action_space: { backend_ids: actions.map(action => action.backendId).sort((left, right) => left.localeCompare(right)), factorization: 'factorized', island_ids: ['island-0'], operator_ids: actions.map(action => action.operatorId).sort((left, right) => left.localeCompare(right)) },
    campaign_id: CAMPAIGN_ID,
    cost_mapping: { lambda_cost: 0 },
    created_at: NOW,
    policy_family: DISTRIBUTOR_POLICY_FAMILY,
    policy_id: DISTRIBUTOR_POLICY_ID,
    reward_mapping: { reward_range: [0, 1.25] },
  };
}

function benchmarkReward(tick: number, actionId: string): number {
  if (tick <= 4) return actionId.includes('op-a') ? 1 : 0;
  if (tick <= 8) return actionId.includes('op-b') ? 1 : 0;
  if (tick <= 12) return actionId.includes('op-c') ? 1 : 0;
  if (tick <= 16) return actionId.includes('op-a') ? 1 : 0;
  if (tick <= 20) return actionId.includes('op-b') ? 1 : 0;
  return actionId.includes('op-c') ? 1 : 0;
}

function cumulativeRegretForDiscountedUcb(actions: DistributorAction[]): number {
  const config = buildConfig(actions);
  const snapshot = initializeDistributorState({ actionIds: actions.map(action => action.actionId), campaignId: CAMPAIGN_ID, policyId: DISTRIBUTOR_POLICY_ID, timestamp: NOW });
  let regret = 0;

  for (let tick = 1; tick <= 24; tick += 1) {
    advanceDiscountedUcbState(snapshot);
    const decision = selectDiscountedUcbAction({ config, eligibleActions: actions, snapshot });
    const reward = benchmarkReward(tick, decision.selectedAction.actionId);
    regret += 1 - reward;
    recordDiscountedUcbOutcome({ observedReward: reward, realizedCostScalar: 1, selectedActionId: decision.selectedAction.actionId, snapshot, tick, timestamp: NOW });
  }

  return regret;
}

function cumulativeRegretForSoftmaxEma(actions: DistributorAction[]): number {
  const estimates = Object.fromEntries(actions.map(action => [action.actionId, 0]));
  const seen = new Set<string>();
  const alpha = 0.1;
  let regret = 0;

  for (let tick = 1; tick <= 24; tick += 1) {
    const unseen = actions.filter(action => !seen.has(action.actionId));
    const selected = unseen.length > 0
      ? [...unseen].sort((left, right) => left.actionId.localeCompare(right.actionId))[0]!
      : [...actions].sort((left, right) => {
          const scoreDiff = estimates[right.actionId]! - estimates[left.actionId]!;
          return scoreDiff === 0 ? left.actionId.localeCompare(right.actionId) : scoreDiff;
        })[0]!;
    const reward = benchmarkReward(tick, selected.actionId);

    seen.add(selected.actionId);
    estimates[selected.actionId] = (1 - alpha) * estimates[selected.actionId]! + alpha * reward;
    regret += 1 - reward;
  }

  return regret;
}

describe('discounted UCB-V distributor policy', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
  });

  it('uses lexical tie-breaks and discounted updates deterministically', () => {
    const actions = [makeAction('b'), makeAction('a')];
    const config = buildConfig(actions);
    const snapshot = initializeDistributorState({
      actionIds: actions.map(action => action.actionId),
      campaignId: CAMPAIGN_ID,
      policyId: DISTRIBUTOR_POLICY_ID,
      timestamp: NOW,
    });
    const firstDecision = selectDiscountedUcbAction({ config, eligibleActions: actions, snapshot });

    expect(firstDecision.selectedAction.actionId).toBe(actions.map(action => action.actionId).sort()[0]);

    recordDiscountedUcbOutcome({
      observedReward: 1,
      realizedCostScalar: 2,
      selectedActionId: firstDecision.selectedAction.actionId,
      snapshot,
      tick: 1,
      timestamp: NOW,
    });

    let stats = snapshot.action_stats[firstDecision.selectedAction.actionId] as Record<string, number>;
    expect(stats.n).toBe(1);
    expect(stats.Q).toBeCloseTo(1, 8);
    expect(stats.C).toBeCloseTo(2, 8);
    expect(stats.w).toBeCloseTo(1, 8);

    advanceDiscountedUcbState(snapshot);
    stats = snapshot.action_stats[firstDecision.selectedAction.actionId] as Record<string, number>;
    expect(stats.w).toBeCloseTo(0.85, 8);
    expect(stats.Q).toBeCloseTo(1, 8);
    expect(stats.C).toBeCloseTo(2, 8);

    recordDiscountedUcbOutcome({
      observedReward: 0,
      realizedCostScalar: 1,
      selectedActionId: firstDecision.selectedAction.actionId,
      snapshot,
      tick: 2,
      timestamp: NOW,
    });
    stats = snapshot.action_stats[firstDecision.selectedAction.actionId] as Record<string, number>;
    expect(stats.n).toBe(2);
    expect(stats.w).toBeCloseTo(1.85, 8);
    expect(stats.Q).toBeCloseTo(0.85 / 1.85, 8);
    expect(stats.C).toBeCloseTo((2 * 0.85 + 1) / 1.85, 8);
  });

  it('preserves selection after snapshot round-trip', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-distributor-policy-'));
    tempDirs.push(rootDir);
    const actions = [makeAction('a'), makeAction('b')];
    const config = buildConfig(actions);
    const snapshot = initializeDistributorState({
      actionIds: actions.map(action => action.actionId),
      campaignId: CAMPAIGN_ID,
      policyId: DISTRIBUTOR_POLICY_ID,
      timestamp: NOW,
    });

    recordDiscountedUcbOutcome({
      observedReward: 1,
      realizedCostScalar: 1,
      selectedActionId: actions[0]!.actionId,
      snapshot,
      tick: 1,
      timestamp: NOW,
    });

    const contracts = new IdeaEngineContractCatalog();
    const store = new IdeaEngineStore(rootDir);
    saveDistributorState({ config, contracts, snapshot, store });
    const reloaded = loadDistributorState({
      actionIds: actions.map(action => action.actionId),
      campaignId: CAMPAIGN_ID,
      contracts,
      policyId: DISTRIBUTOR_POLICY_ID,
      store,
      timestamp: NOW,
    });
    const expected = selectDiscountedUcbAction({ config, eligibleActions: actions, snapshot: structuredClone(snapshot) });
    const actual = selectDiscountedUcbAction({ config, eligibleActions: actions, snapshot: reloaded });

    expect(actual.selectedAction.actionId).toBe(expected.selectedAction.actionId);
    expect(actual.breakdowns).toEqual(expected.breakdowns);
  });

  it('replays deterministically for the same config, state, and action ordering', () => {
    const actions = [makeAction('a'), makeAction('b'), makeAction('c')];
    const config = buildConfig(actions);
    const snapshot = initializeDistributorState({
      actionIds: actions.map(action => action.actionId),
      campaignId: CAMPAIGN_ID,
      policyId: DISTRIBUTOR_POLICY_ID,
      timestamp: NOW,
    });

    recordDiscountedUcbOutcome({
      observedReward: 1,
      realizedCostScalar: 1,
      selectedActionId: actions[0]!.actionId,
      snapshot,
      tick: 1,
      timestamp: NOW,
    });
    advanceDiscountedUcbState(snapshot);

    const left = selectDiscountedUcbAction({ config, eligibleActions: actions, snapshot: structuredClone(snapshot) });
    const right = selectDiscountedUcbAction({ config, eligibleActions: actions, snapshot: structuredClone(snapshot) });

    expect(right.selectedAction.actionId).toBe(left.selectedAction.actionId);
    expect(right.breakdowns).toEqual(left.breakdowns);
  });

  it('beats the bounded softmax_ema baseline on cumulative regret', () => {
    const actions = [makeAction('a'), makeAction('b'), makeAction('c')];

    // This regression check assumes the checked-in EVO-11 hyperparameters remain stable.
    expect(cumulativeRegretForDiscountedUcb(actions)).toBeLessThan(cumulativeRegretForSoftmaxEma(actions));
  });
});
