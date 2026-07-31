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

function declared(limit: number | null | undefined): boolean {
  return limit !== undefined && limit !== null;
}

/**
 * Snapshot renders exactly the declared dimensions: the tokens / cost /
 * wall-clock pairs appear only when their ceiling exists in the budget
 * envelope. An undeclared dimension has no metering path, so rendering a
 * constant-zero counter under an untouchable ceiling would state a control
 * that does not exist. steps and nodes are engine-metered and always
 * present (their ceilings stay optional: remaining is null when unset).
 */
export function budgetSnapshot(campaign: BudgetUsageRecord): Record<string, number | null> {
  const tokensUsed = Number(campaign.usage.tokens_used);
  const costUsed = Number(campaign.usage.cost_usd_used);
  const wallClockUsed = Number(campaign.usage.wall_clock_s_elapsed);
  const stepsUsed = Number(campaign.usage.steps_used);
  const nodesUsed = Number(campaign.usage.nodes_used);
  return {
    ...(declared(campaign.budget.max_tokens)
      ? { tokens_used: tokensUsed, tokens_remaining: remaining(campaign.budget.max_tokens, tokensUsed) }
      : {}),
    ...(declared(campaign.budget.max_cost_usd)
      ? { cost_usd_used: costUsed, cost_usd_remaining: remaining(campaign.budget.max_cost_usd, costUsed) }
      : {}),
    ...(declared(campaign.budget.max_wall_clock_s)
      ? { wall_clock_s_elapsed: wallClockUsed, wall_clock_s_remaining: remaining(campaign.budget.max_wall_clock_s, wallClockUsed) }
      : {}),
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
