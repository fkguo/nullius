import type { DistributorAction } from './distributor-action-space.js';
import { DISTRIBUTOR_HYPERPARAMETERS, type DistributorPolicyConfigRecord } from './distributor-config.js';
import { schemaValidationError } from './errors.js';

type DistributorActionStats = Record<string, unknown> & {
  C: number;
  Q: number;
  n: number;
  sigma: number;
  t_last: number;
  w: number;
};

export interface DistributorStateSnapshot extends Record<string, unknown> {
  action_stats: Record<string, DistributorActionStats>;
  campaign_id: string;
  policy_id: string;
  timestamp: string;
}

interface ActionScoreBreakdown {
  bonus: number;
  costPenalty: number;
  meanReward: number;
  score: number;
  sigma: number;
  weight: number;
}

export interface DiscountedUcbDecision {
  breakdowns: Record<string, ActionScoreBreakdown>;
  selectedAction: DistributorAction;
}

function rewardUpperBound(config: DistributorPolicyConfigRecord): number {
  const rewardRange = (config.reward_mapping as Record<string, unknown> | undefined)?.reward_range;
  return Array.isArray(rewardRange) && typeof rewardRange[1] === 'number'
    ? rewardRange[1]
    : DISTRIBUTOR_HYPERPARAMETERS.reward_upper_bound;
}

function lambdaCost(config: DistributorPolicyConfigRecord): number {
  const mapping = config.cost_mapping as Record<string, unknown> | undefined;
  return typeof mapping?.lambda_cost === 'number' ? mapping.lambda_cost : 0;
}

function statsFor(snapshot: DistributorStateSnapshot, actionId: string): DistributorActionStats {
  const stats = snapshot.action_stats[actionId];
  if (!stats) {
    throw schemaValidationError(`distributor state missing action stats for ${actionId}`, {
      campaign_id: snapshot.campaign_id,
    });
  }
  return stats as DistributorActionStats;
}

function effectiveCount(stats: DistributorActionStats): number {
  return typeof stats.n_discounted === 'number' ? Math.max(stats.n_discounted, 0) : 0;
}

function discountedCountSum(snapshot: DistributorStateSnapshot, actions: DistributorAction[]): number {
  return actions.reduce((sum, action) => sum + effectiveCount(statsFor(snapshot, action.actionId)), 0);
}

function recomputeMoments(stats: DistributorActionStats): void {
  const weight = effectiveCount(stats);
  if (weight <= 0) {
    stats.Q = 0;
    stats.C = 0;
    stats.sigma = 0;
    stats.w = 0;
    return;
  }
  const rewardSum = typeof stats.reward_sum === 'number' ? stats.reward_sum : 0;
  const rewardSqSum = typeof stats.reward_sq_sum === 'number' ? stats.reward_sq_sum : 0;
  const costSum = typeof stats.cost_sum === 'number' ? stats.cost_sum : 0;
  stats.Q = rewardSum / weight;
  stats.C = costSum / weight;
  stats.w = weight;
  stats.sigma = Math.sqrt(Math.max(rewardSqSum / weight - stats.Q * stats.Q, 0));
}

export function initializeDistributorState(options: {
  actionIds: string[];
  campaignId: string;
  policyId: string;
  timestamp: string;
}): DistributorStateSnapshot {
  return {
    campaign_id: options.campaignId,
    policy_id: options.policyId,
    timestamp: options.timestamp,
    action_stats: Object.fromEntries(options.actionIds.map(actionId => [actionId, {
      n: 0,
      Q: 0,
      C: 0,
      sigma: 0,
      w: 0,
      t_last: 0,
      n_discounted: 0,
      reward_sum: 0,
      reward_sq_sum: 0,
      cost_sum: 0,
    }])),
  };
}

export function advanceDiscountedUcbState(snapshot: DistributorStateSnapshot): void {
  const discount = DISTRIBUTOR_HYPERPARAMETERS.discount;
  for (const stats of Object.values(snapshot.action_stats)) {
    const typedStats = stats as DistributorActionStats;
    typedStats.n_discounted = effectiveCount(typedStats) * discount;
    typedStats.reward_sum = (typeof typedStats.reward_sum === 'number' ? typedStats.reward_sum : 0) * discount;
    typedStats.reward_sq_sum = (typeof typedStats.reward_sq_sum === 'number' ? typedStats.reward_sq_sum : 0) * discount;
    typedStats.cost_sum = (typeof typedStats.cost_sum === 'number' ? typedStats.cost_sum : 0) * discount;
    recomputeMoments(typedStats);
  }
}

export function selectDiscountedUcbAction(options: {
  config: DistributorPolicyConfigRecord;
  eligibleActions: DistributorAction[];
  snapshot: DistributorStateSnapshot;
}): DiscountedUcbDecision {
  const unseen = options.eligibleActions.filter(action => effectiveCount(statsFor(options.snapshot, action.actionId)) === 0);
  if (unseen.length > 0) {
    return {
      breakdowns: Object.fromEntries(options.eligibleActions.map(action => [action.actionId, {
        bonus: effectiveCount(statsFor(options.snapshot, action.actionId)) === 0 ? Number.POSITIVE_INFINITY : 0,
        costPenalty: 0,
        meanReward: statsFor(options.snapshot, action.actionId).Q,
        score: effectiveCount(statsFor(options.snapshot, action.actionId)) === 0 ? Number.POSITIVE_INFINITY : 0,
        sigma: statsFor(options.snapshot, action.actionId).sigma,
        weight: effectiveCount(statsFor(options.snapshot, action.actionId)),
      }])),
      selectedAction: [...unseen].sort((left, right) => left.actionId.localeCompare(right.actionId))[0]!,
    };
  }
  const logTerm = Math.max(1, Math.log(discountedCountSum(options.snapshot, options.eligibleActions) + 1));
  const maxReward = rewardUpperBound(options.config);
  const costWeight = lambdaCost(options.config);
  let chosen: DistributorAction | null = null;
  let chosenScore = Number.NEGATIVE_INFINITY;
  const breakdowns: Record<string, ActionScoreBreakdown> = {};
  for (const action of options.eligibleActions) {
    const stats = statsFor(options.snapshot, action.actionId);
    const weight = Math.max(effectiveCount(stats), 1e-9);
    const variance = Math.max(stats.sigma * stats.sigma, 0);
    const bonus = Math.sqrt((2 * variance * logTerm) / weight) + (3 * maxReward * logTerm) / weight;
    const costPenalty = costWeight * stats.C;
    const score = stats.Q - costPenalty + DISTRIBUTOR_HYPERPARAMETERS.exploration_scale * bonus;
    breakdowns[action.actionId] = {
      bonus,
      costPenalty,
      meanReward: stats.Q,
      score,
      sigma: stats.sigma,
      weight,
    };
    if (!chosen || score > chosenScore || (score === chosenScore && action.actionId.localeCompare(chosen.actionId) < 0)) {
      chosen = action;
      chosenScore = score;
    }
  }
  return { breakdowns, selectedAction: chosen! };
}

export function recordDiscountedUcbOutcome(options: {
  observedReward: number;
  realizedCostScalar: number;
  selectedActionId: string;
  snapshot: DistributorStateSnapshot;
  timestamp: string;
  tick: number;
}): void {
  const stats = statsFor(options.snapshot, options.selectedActionId);
  stats.n += 1;
  stats.t_last = options.tick;
  stats.n_discounted = effectiveCount(stats) + 1;
  stats.reward_sum = (typeof stats.reward_sum === 'number' ? stats.reward_sum : 0) + options.observedReward;
  stats.reward_sq_sum = (typeof stats.reward_sq_sum === 'number' ? stats.reward_sq_sum : 0) + options.observedReward ** 2;
  stats.cost_sum = (typeof stats.cost_sum === 'number' ? stats.cost_sum : 0) + options.realizedCostScalar;
  recomputeMoments(stats);
  options.snapshot.timestamp = options.timestamp;
}
