import { pathToFileURL } from 'url';
import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { writeJsonFileAtomic } from '../store/file-io.js';
import { budgetSnapshot, exhaustedDimensions } from './budget-snapshot.js';
import { buildEligibleDistributorActions, buildDistributorActionId, validateDistributorActionSpace } from './distributor-action-space.js';
import { loadDistributorPolicyConfig } from './distributor-config.js';
import { advanceDiscountedUcbState, recordDiscountedUcbOutcome, selectDiscountedUcbAction } from './distributor-discounted-ucb-v.js';
import { appendDistributorEvent } from './distributor-events.js';
import { computeDistributorReward } from './distributor-reward.js';
import { loadDistributorState, saveDistributorState } from './distributor-state.js';
import { loadBuiltinLibrarianRecipeBook, loadBuiltinSearchDomainPackRuntime } from './domain-pack-registry.js';
import { initialIslandStates } from './domain-pack.js';
import { RpcError, schemaValidationError } from './errors.js';
import { prepareFailureAvoidance } from './failure-library.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { advanceIslandStateOneTick, islandBestScore, isScoreImproved, markIslandsExhausted, pickParentNode, refreshIslandPopulationSizes } from './island-state.js';
import { buildLibrarianEvidencePacket, claimEvidenceUris, type LibrarianRecipeBook } from './librarian-recipes.js';
import { buildOperatorNode } from './operator-node.js';
import { chooseSearchOperator, type SearchDomainPackRuntime } from './search-operator.js';
import { ensureCampaignRunning, loadCampaignDomainPackMetadata, loadCampaignOrError, setCampaignRunningIfBudgetAvailable, type SearchCampaignRecord } from './search-step-campaign.js';
import type { DistributorStateSnapshot } from './distributor-discounted-ucb-v.js';

function stepBudgetExhausted(localUsage: Record<string, number>, stepBudget: unknown): boolean {
  if (!stepBudget || typeof stepBudget !== 'object' || Array.isArray(stepBudget)) return false;
  const budget = stepBudget as Record<string, unknown>;
  const pairs: Array<[string, string]> = [['max_steps', 'steps'], ['max_nodes', 'nodes'], ['max_tokens', 'tokens'], ['max_cost_usd', 'cost_usd'], ['max_wall_clock_s', 'wall_clock_s']];
  return pairs.some(([budgetKey, usageKey]) => typeof budget[budgetKey] === 'number' && localUsage[usageKey] >= budget[budgetKey]);
}

export function executeSearchStep(options: {
  contracts: IdeaEngineContractCatalog;
  createId: () => string;
  now: () => string;
  params: Record<string, unknown>;
  payloadHash: string;
  store: IdeaEngineStore;
}): Record<string, unknown> {
  const campaignId = String(options.params.campaign_id);
  const idempotencyKeyValue = String(options.params.idempotency_key);
  const nStepsRequested = Number(options.params.n_steps);
  const { payloadHash } = options;
  return options.store.withMutationLock(campaignId, () => {
    const replay = recordOrReplay({ campaignId, idempotencyKeyValue, method: 'search.step', payloadHash, store: options.store });
    if (replay) return replay.kind === 'error' ? (() => { throw new RpcError(-32603, 'internal_error', replay.payload); })() : replay.payload;
    const campaign = loadCampaignOrError(options.store, campaignId);
    ensureCampaignRunning(campaign);
    const { packId } = loadCampaignDomainPackMetadata(campaign);
    let runtimePack: SearchDomainPackRuntime;
    let recipeBook: LibrarianRecipeBook;
    try {
      runtimePack = loadBuiltinSearchDomainPackRuntime(packId);
      recipeBook = loadBuiltinLibrarianRecipeBook(packId);
    } catch (error) {
      throw schemaValidationError(`failed to load campaign domain pack ${packId}: ${error instanceof Error ? error.message : String(error)}`, { campaign_id: campaignId });
    }
    const plannedCampaign = structuredClone(campaign) as SearchCampaignRecord;
    if (plannedCampaign.island_states.length === 0) plannedCampaign.island_states = initialIslandStates(1);
    const runtime = (plannedCampaign.search_runtime as Record<string, unknown> | undefined) ?? {};
    plannedCampaign.search_runtime = runtime;
    const nodes = options.store.loadNodes<Record<string, unknown>>(campaignId);
    refreshIslandPopulationSizes(plannedCampaign, nodes);
    const failureAvoidance = prepareFailureAvoidance({ campaign: plannedCampaign, contracts: options.contracts, now: options.now(), store: options.store });
    const distributor = loadDistributorPolicyConfig({ campaign: plannedCampaign, contracts: options.contracts, store: options.store });
    let distributorState: DistributorStateSnapshot | null = null;
    if (distributor) {
      validateDistributorActionSpace({ config: distributor.config, islandIds: plannedCampaign.island_states.map(state => String(state.island_id)), runtime: runtimePack });
      const allActionIds = plannedCampaign.island_states.flatMap(state => runtimePack.searchOperators.map(operator => buildDistributorActionId(operator.descriptor.backendId, operator.descriptor.operatorId, String(state.island_id))));
      distributorState = loadDistributorState({ actionIds: allActionIds, campaignId, contracts: options.contracts, policyId: distributor.config.policy_id, store: options.store, timestamp: options.now() });
    }
    const stepId = options.createId();
    const localUsage = { steps: 0, nodes: 0, tokens: 0, cost_usd: 0, wall_clock_s: 0 };
    const transitionEvents: Record<string, unknown>[] = [];
    const operatorEvents: Record<string, unknown>[] = [];
    const operatorTraceArtifacts: Array<[string, Record<string, unknown>]> = [];
    const evidenceArtifacts: Array<[string, Record<string, unknown>]> = [];
    const distributorEvents: Record<string, unknown>[] = [];
    const newNodeIds: string[] = [];
    const newNodesPayload: Record<string, unknown>[] = [];
    let earlyStopReason: string | undefined;
    let nStepsExecuted = 0;
    for (let tick = 0; tick < nStepsRequested; tick += 1) {
      if (stepBudgetExhausted(localUsage, options.params.step_budget)) { earlyStopReason = 'step_budget_exhausted'; break; }
      if (exhaustedDimensions(plannedCampaign).length > 0) { plannedCampaign.status = 'exhausted'; markIslandsExhausted(plannedCampaign); earlyStopReason = 'budget_exhausted'; break; }
      const islands = plannedCampaign.island_states;
      const chosenIndex = Number(runtime.next_island_index ?? 0) % islands.length;
      runtime.next_island_index = (chosenIndex + 1) % islands.length;
      const island = islands[chosenIndex]!;
      const islandId = String(island.island_id ?? `island-${chosenIndex}`);
      const bestScore = islandBestScore(nodes, islandId);
      const improved = bestScore !== null && isScoreImproved(island.best_score, bestScore);
      if (bestScore !== null) island.best_score = bestScore;
      const transition = advanceIslandStateOneTick({ island, scoreImproved: improved });
      const transitionEvent: Record<string, unknown> = { tick: tick + 1, island_id: islandId, from_state: transition.fromState, to_state: transition.toState, reason: transition.reason, score_improved: improved, best_score: island.best_score ?? null };
      const parentNode = pickParentNode(nodes, islandId);
      if (parentNode && island.state !== 'EXHAUSTED') {
        let distributorDecision: ReturnType<typeof selectDiscountedUcbAction> | null = null;
        const operator = distributor && distributorState
          ? (() => {
          advanceDiscountedUcbState(distributorState);
          distributorDecision = selectDiscountedUcbAction({
            config: distributor.config,
            eligibleActions: buildEligibleDistributorActions({ config: distributor.config, islandId, runtime: runtimePack }),
            snapshot: distributorState,
          });
            return distributorDecision.selectedAction.operator;
          })()
          : chooseSearchOperator({ islandId, runtime, searchOperators: runtimePack.searchOperators, selectionPolicy: runtimePack.operatorSelectionPolicy });
        const selection = distributor && distributorDecision ? { actionId: distributorDecision.selectedAction.actionId, deterministicPolicy: distributor.config.policy_id, policyId: distributor.config.policy_id } : undefined;
        const operatorOutput = operator.run({ campaignId, failureAvoidance: failureAvoidance?.summary, islandId, parentNodeId: String(parentNode.node_id), selection, stepId, tick: tick + 1 }, structuredClone(parentNode));
        const generatedAt = options.now();
        const evidencePacketName = `${stepId}-tick-${String(tick + 1).padStart(3, '0')}-librarian.json`;
        const evidencePacketRef = pathToFileURL(options.store.artifactPath(campaignId, 'evidence_packets', evidencePacketName)).href;
        const evidencePacketPayload = buildLibrarianEvidencePacket({ campaignId, domain: String((plannedCampaign.charter as Record<string, unknown>).domain ?? ''), generatedAt, islandId, operatorOutput, recipeBook, stepId, tick: tick + 1 });
        const newNode = buildOperatorNode({ campaignId, createId: options.createId, evidenceUris: claimEvidenceUris({ operatorEvidenceUris: operatorOutput.evidenceUrisUsed, packetPayload: evidencePacketPayload, packetRef: evidencePacketRef }), islandId, now: generatedAt, operatorOutput, parentNodeId: String(parentNode.node_id) });
        try {
          options.contracts.validateAgainstRef('./idea_node_v1.schema.json', newNode, `search.step/node/${String(newNode.node_id)}`);
        } catch (error) {
          throw schemaValidationError(`search.step generated invalid node: ${error instanceof Error ? error.message : String(error)}`, { campaign_id: campaignId });
        }
        nodes[String(newNode.node_id)] = newNode;
        newNodeIds.push(String(newNode.node_id));
        newNodesPayload.push(structuredClone(newNode));
        evidenceArtifacts.push([evidencePacketName, evidencePacketPayload]);
        plannedCampaign.usage.nodes_used = Number(plannedCampaign.usage.nodes_used ?? 0) + 1;
        localUsage.nodes += 1;
        const traceArtifactName = `${stepId}-tick-${String(tick + 1).padStart(3, '0')}.json`;
        operatorTraceArtifacts.push([traceArtifactName, { campaign_id: campaignId, step_id: stepId, tick: tick + 1, island_id: islandId, operator_id: operatorOutput.operatorId, operator_family: operatorOutput.operatorFamily, backend_id: operatorOutput.backendId, parent_node_id: parentNode.node_id, new_node_id: newNode.node_id, operator_trace: structuredClone(newNode.operator_trace as Record<string, unknown>), evidence_packet_ref: evidencePacketRef, generated_at: generatedAt }]);
        operatorEvents.push({ tick: tick + 1, island_id: islandId, operator_id: operatorOutput.operatorId, operator_family: operatorOutput.operatorFamily, backend_id: operatorOutput.backendId, parent_node_id: parentNode.node_id, new_node_id: newNode.node_id, operator_trace_artifact_ref: pathToFileURL(options.store.artifactPath(campaignId, 'operator_traces', traceArtifactName)).href, evidence_packet_ref: evidencePacketRef });
        if (distributor && distributorState && distributorDecision) {
          const reward = computeDistributorReward({ newNodeCreated: true, scoreImproved: improved });
          recordDiscountedUcbOutcome({
            observedReward: reward.observedReward,
            realizedCostScalar: Object.values(reward.realizedCost).reduce((sum, value) => sum + value, 0),
            selectedActionId: distributorDecision.selectedAction.actionId,
            snapshot: distributorState,
            timestamp: generatedAt,
            tick: tick + 1,
          });
          distributorEvents.push({
            campaign_id: campaignId,
            step_id: stepId,
            decision_id: options.createId(),
            timestamp: generatedAt,
            policy_id: distributor.config.policy_id,
            factorization: distributor.config.action_space.factorization,
            eligible_action_ids: Object.keys(distributorDecision.breakdowns).sort((left, right) => left.localeCompare(right)),
            selected_action: {
              backend_id: distributorDecision.selectedAction.backendId,
              operator_id: distributorDecision.selectedAction.operatorId,
              island_id: distributorDecision.selectedAction.islandId,
            },
            logits: Object.fromEntries(Object.entries(distributorDecision.breakdowns).map(([actionId, breakdown]) => [actionId, breakdown.score])),
            observed_reward: reward.observedReward,
            realized_cost: reward.realizedCost,
            new_node_ids: [String(newNode.node_id)],
            diagnostics: {
              breakdowns: distributorDecision.breakdowns,
              failure_avoidance_hit_count: failureAvoidance?.summary.hitCount ?? 0,
              reward_components: reward.rewardComponents,
            },
          });
        }
        transitionEvent.operator_id = operatorOutput.operatorId;
        transitionEvent.new_node_id = newNode.node_id;
      } else transitionEvent.operator_skipped = 'no_parent_node';
      transitionEvents.push(transitionEvent);
      plannedCampaign.usage.steps_used = Number(plannedCampaign.usage.steps_used ?? 0) + 1;
      plannedCampaign.last_step_id = stepId;
      localUsage.steps += 1;
      nStepsExecuted += 1;
      setCampaignRunningIfBudgetAvailable(plannedCampaign);
      if (plannedCampaign.status === 'exhausted') { markIslandsExhausted(plannedCampaign); if (nStepsExecuted < nStepsRequested) earlyStopReason = 'budget_exhausted'; break; }
    }
    refreshIslandPopulationSizes(plannedCampaign, nodes);
    const result: Record<string, unknown> = { campaign_id: campaignId, step_id: stepId, n_steps_requested: nStepsRequested, n_steps_executed: nStepsExecuted, new_node_ids: newNodeIds, updated_node_ids: [], island_states: structuredClone(plannedCampaign.island_states), budget_snapshot: budgetSnapshot(plannedCampaign), idempotency: responseIdempotency(idempotencyKeyValue, payloadHash), ...(distributor ? { distributor_policy_config_ref: distributor.configRef } : {}) };
    if (newNodeIds.length > 0) result.new_nodes_artifact_ref = pathToFileURL(options.store.artifactPath(campaignId, 'search_steps', `${stepId}-new-nodes.json`)).href;
    if (earlyStopReason) Object.assign(result, { early_stopped: true, early_stop_reason: earlyStopReason });
    options.contracts.validateResult('search.step', result);
    storeIdempotency({ campaignId, createdAt: options.now(), idempotencyKeyValue, kind: 'result', method: 'search.step', payload: result, payloadHash, state: 'prepared', store: options.store });
    if (newNodeIds.length > 0) options.store.writeArtifact(campaignId, 'search_steps', `${stepId}-new-nodes.json`, { campaign_id: campaignId, step_id: stepId, new_node_ids: newNodeIds, nodes: newNodesPayload, operator_events: operatorEvents, generated_at: options.now() });
    for (const [artifactName, payload] of operatorTraceArtifacts) options.store.writeArtifact(campaignId, 'operator_traces', artifactName, payload);
    for (const [artifactName, payload] of evidenceArtifacts) options.store.writeArtifact(campaignId, 'evidence_packets', artifactName, payload);
    if (failureAvoidance) writeJsonFileAtomic(failureAvoidance.artifactPath, failureAvoidance.artifactPayload);
    if (distributorState && distributor) {
      for (const event of distributorEvents) appendDistributorEvent({ campaignId, contracts: options.contracts, event, store: options.store });
      saveDistributorState({ config: distributor.config, contracts: options.contracts, snapshot: distributorState, store: options.store });
    }
    options.store.writeArtifact(campaignId, 'search_steps', `${stepId}.json`, { campaign_id: campaignId, step_id: stepId, n_steps_requested: nStepsRequested, n_steps_executed: nStepsExecuted, transition_events: transitionEvents, operator_events: operatorEvents, ...(result.distributor_policy_config_ref ? { distributor_policy_config_ref: result.distributor_policy_config_ref } : {}), new_node_ids: newNodeIds, new_nodes_artifact_ref: result.new_nodes_artifact_ref ?? null, step_budget: options.params.step_budget ?? null, budget_snapshot: result.budget_snapshot, island_states: result.island_states, early_stopped: result.early_stopped ?? false, early_stop_reason: result.early_stop_reason ?? null, generated_at: options.now() });
    options.store.saveNodes(campaignId, nodes);
    for (const nodeId of newNodeIds) options.store.appendNodeLog(campaignId, nodes[nodeId]!, 'create');
    options.store.saveCampaign(plannedCampaign);
    storeIdempotency({ campaignId, createdAt: options.now(), idempotencyKeyValue, kind: 'result', method: 'search.step', payload: result, payloadHash, state: 'committed', store: options.store });
    return result;
  });
}
