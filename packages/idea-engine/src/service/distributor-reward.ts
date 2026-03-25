export interface DistributorRewardComputation {
  observedReward: number;
  realizedCost: Record<string, number>;
  rewardComponents: Record<string, number>;
}

export function computeDistributorReward(options: {
  newNodeCreated: boolean;
  scoreImproved: boolean;
}): DistributorRewardComputation {
  const rewardComponents = {
    node_committed: options.newNodeCreated ? 1.0 : 0.0,
    island_best_score_improved: options.scoreImproved ? 0.25 : 0.0,
  };
  return {
    observedReward: rewardComponents.node_committed + rewardComponents.island_best_score_improved,
    realizedCost: {
      steps: 1,
      nodes_created: options.newNodeCreated ? 1 : 0,
      tokens: 0,
      cost_usd: 0,
      wall_clock_s: 0,
    },
    rewardComponents,
  };
}
