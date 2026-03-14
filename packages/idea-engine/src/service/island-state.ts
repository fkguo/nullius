const BEST_SCORE_EPSILON = 1e-9;
const STAGNATION_PATIENCE_STEPS = 2;

function nodeScore(node: Record<string, unknown>): number | null {
  const scores = (node.eval_info as Record<string, unknown> | undefined)?.scores;
  if (!scores || typeof scores !== 'object') return null;
  const values = Object.values(scores).filter((value): value is number => typeof value === 'number');
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function refreshIslandPopulationSizes(
  campaign: Record<string, unknown>,
  nodes: Record<string, Record<string, unknown>>,
): void {
  const counts = new Map<string, number>();
  for (const node of Object.values(nodes)) {
    if (typeof node.island_id === 'string') counts.set(node.island_id, (counts.get(node.island_id) ?? 0) + 1);
  }
  for (const island of (campaign.island_states as Array<Record<string, unknown>> | undefined) ?? []) {
    island.population_size = counts.get(String(island.island_id ?? '')) ?? 0;
  }
}

export function markIslandsExhausted(campaign: Record<string, unknown>): void {
  for (const island of (campaign.island_states as Array<Record<string, unknown>> | undefined) ?? []) island.state = 'EXHAUSTED';
}

export function pickParentNode(nodes: Record<string, Record<string, unknown>>, islandId: string): Record<string, unknown> | null {
  const islandNodes = Object.values(nodes).filter(node => node.island_id === islandId);
  if (islandNodes.length === 0) return null;
  islandNodes.sort((left, right) => {
    const leftCreated = String(left.created_at ?? '');
    const rightCreated = String(right.created_at ?? '');
    if (leftCreated < rightCreated) return -1;
    if (leftCreated > rightCreated) return 1;
    return String(left.node_id).localeCompare(String(right.node_id));
  });
  return islandNodes[0] ?? null;
}

export function islandBestScore(nodes: Record<string, Record<string, unknown>>, islandId: string): number | null {
  let best: number | null = null;
  for (const node of Object.values(nodes)) {
    if (node.island_id !== islandId) continue;
    const score = nodeScore(node);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

export function isScoreImproved(previousBest: unknown, currentBest: number): boolean {
  return typeof previousBest !== 'number' || currentBest > previousBest + BEST_SCORE_EPSILON;
}

export function advanceIslandStateOneTick(options: {
  island: Record<string, unknown>;
  scoreImproved: boolean;
}): { fromState: string; reason: string; toState: string } {
  const island = options.island;
  const fromState = String(island.state ?? 'SEEDING');
  let stagnationCounter = Number(island.stagnation_counter ?? 0);
  let repopulationCount = Number(island.repopulation_count ?? 0);
  let toState = fromState;
  let reason = 'no_change';
  if (fromState === 'SEEDING') {
    toState = 'EXPLORING';
    stagnationCounter = 0;
    reason = 'seeded_population_ready';
  } else if (fromState === 'EXPLORING' || fromState === 'CONVERGING') {
    if (options.scoreImproved) {
      toState = 'CONVERGING';
      stagnationCounter = 0;
      reason = 'best_score_improved';
    } else if (++stagnationCounter >= STAGNATION_PATIENCE_STEPS) {
      toState = 'STAGNANT';
      reason = 'stagnation_threshold_reached';
    } else {
      reason = 'stagnation_counter_incremented';
    }
  } else if (fromState === 'STAGNANT') {
    toState = 'REPOPULATED';
    stagnationCounter = 0;
    repopulationCount += 1;
    reason = 'repopulate_triggered';
  } else if (fromState === 'REPOPULATED') {
    toState = 'EXPLORING';
    stagnationCounter = 0;
    reason = 'resume_exploration_after_repopulate';
  } else if (fromState === 'EXHAUSTED') {
    reason = 'terminal';
  }
  island.state = toState;
  island.stagnation_counter = Math.max(stagnationCounter, 0);
  island.repopulation_count = Math.max(repopulationCount, 0);
  if (!('best_score' in island)) island.best_score = null;
  return { fromState, toState, reason };
}
