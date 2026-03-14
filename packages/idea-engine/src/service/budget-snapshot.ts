interface BudgetUsageRecord {
  budget: Record<string, number | null>;
  usage: Record<string, number>;
}

function remaining(limit: number | null | undefined, used: number): number | null {
  if (limit === undefined || limit === null) {
    return null;
  }
  return Math.max(Number(limit) - used, 0);
}

export function budgetSnapshot(campaign: BudgetUsageRecord): Record<string, number | null> {
  const tokensUsed = Number(campaign.usage.tokens_used);
  const costUsed = Number(campaign.usage.cost_usd_used);
  const wallClockUsed = Number(campaign.usage.wall_clock_s_elapsed);
  const stepsUsed = Number(campaign.usage.steps_used);
  const nodesUsed = Number(campaign.usage.nodes_used);
  return {
    tokens_used: tokensUsed,
    tokens_remaining: remaining(campaign.budget.max_tokens, tokensUsed),
    cost_usd_used: costUsed,
    cost_usd_remaining: remaining(campaign.budget.max_cost_usd, costUsed),
    wall_clock_s_elapsed: wallClockUsed,
    wall_clock_s_remaining: remaining(campaign.budget.max_wall_clock_s, wallClockUsed),
    steps_used: stepsUsed,
    steps_remaining: remaining(campaign.budget.max_steps, stepsUsed),
    nodes_used: nodesUsed,
    nodes_remaining: remaining(campaign.budget.max_nodes, nodesUsed),
  };
}

export function exhaustedDimensions(campaign: BudgetUsageRecord): string[] {
  const snapshot = budgetSnapshot(campaign);
  const exhausted: string[] = [];
  if ((snapshot.tokens_remaining ?? 1) <= 0) exhausted.push('tokens');
  if ((snapshot.cost_usd_remaining ?? 1) <= 0) exhausted.push('cost_usd');
  if ((snapshot.wall_clock_s_remaining ?? 1) <= 0) exhausted.push('wall_clock_s');
  if (snapshot.steps_remaining !== null && snapshot.steps_remaining <= 0) exhausted.push('steps');
  if (snapshot.nodes_remaining !== null && snapshot.nodes_remaining <= 0) exhausted.push('nodes');
  return exhausted;
}
