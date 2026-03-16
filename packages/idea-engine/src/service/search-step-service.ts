import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { IdeaEngineContractCatalog, ContractRuntimeError } from '../contracts/catalog.js';
import { hashWithoutIdempotency } from '../hash/payload-hash.js';
import { IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot, exhaustedDimensions } from './budget-snapshot.js';
import { loadBuiltinLibrarianRecipeBook, loadBuiltinSearchDomainPackRuntime } from './domain-pack-registry.js';
import { initialIslandStates } from './domain-pack.js';
import { RpcError, schemaValidationError } from './errors.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { advanceIslandStateOneTick, islandBestScore, isScoreImproved, markIslandsExhausted, pickParentNode, refreshIslandPopulationSizes } from './island-state.js';
import { buildLibrarianEvidencePacket, claimEvidenceUris, type LibrarianRecipeBook } from './librarian-recipes.js';
import { buildOperatorNode } from './operator-node.js';
import { chooseSearchOperator, type SearchDomainPackRuntime } from './search-operator.js';
import { ensureCampaignRunning, loadCampaignDomainPackMetadata, loadCampaignOrError, setCampaignRunningIfBudgetAvailable, type SearchCampaignRecord } from './search-step-campaign.js';

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function stepBudgetExhausted(localUsage: Record<string, number>, stepBudget: unknown): boolean {
  if (!stepBudget || typeof stepBudget !== 'object' || Array.isArray(stepBudget)) return false;
  const budget = stepBudget as Record<string, unknown>;
  const pairs: Array<[string, string]> = [['max_steps', 'steps'], ['max_nodes', 'nodes'], ['max_tokens', 'tokens'], ['max_cost_usd', 'cost_usd'], ['max_wall_clock_s', 'wall_clock_s']];
  return pairs.some(([budgetKey, usageKey]) => typeof budget[budgetKey] === 'number' && localUsage[usageKey] >= budget[budgetKey]);
}

export class IdeaEngineSearchStepService {
  readonly contracts: IdeaEngineContractCatalog;
  readonly store: IdeaEngineStore;
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(options: { contractDir?: string; createId?: () => string; now?: () => string; rootDir: string }) {
    this.store = new IdeaEngineStore(options.rootDir);
    this.contracts = new IdeaEngineContractCatalog(options.contractDir);
    this.now = options.now ?? utcNowIso;
    this.createId = options.createId ?? randomUUID;
  }

  handle(method: string, params: unknown): Record<string, unknown> {
    if (method !== 'search.step') throw new RpcError(-32601, 'method_not_found', { reason: 'method_not_found', details: { method } });
    try {
      this.contracts.validateRequestParams(method, params);
      return this.searchStep(params as Record<string, unknown>);
    } catch (error) {
      if (error instanceof ContractRuntimeError) throw schemaValidationError(error.message);
      if (error instanceof RpcError) this.contracts.validateErrorData(error.data);
      throw error;
    }
  }

  private searchStep(params: Record<string, unknown>): Record<string, unknown> {
    const campaignId = String(params.campaign_id);
    const idempotencyKeyValue = String(params.idempotency_key);
    const nStepsRequested = Number(params.n_steps);
    const payloadHash = hashWithoutIdempotency('search.step', params);
    return this.store.withMutationLock(campaignId, () => {
      const replay = recordOrReplay({ campaignId, idempotencyKeyValue, method: 'search.step', payloadHash, store: this.store });
      if (replay) return replay.kind === 'error' ? (() => { throw new RpcError(-32603, 'internal_error', replay.payload); })() : replay.payload;
      const campaign = loadCampaignOrError(this.store, campaignId);
      ensureCampaignRunning(campaign);
      const { packId } = loadCampaignDomainPackMetadata(campaign);
      let runtimePack: SearchDomainPackRuntime;
      let recipeBook: LibrarianRecipeBook;
      try {
        runtimePack = loadBuiltinSearchDomainPackRuntime(packId);
        recipeBook = loadBuiltinLibrarianRecipeBook(packId);
      } catch (error) {
        throw schemaValidationError(
          `failed to load campaign domain pack ${packId}: ${error instanceof Error ? error.message : String(error)}`,
          { campaign_id: campaignId },
        );
      }
      const plannedCampaign = structuredClone(campaign) as SearchCampaignRecord;
      if (plannedCampaign.island_states.length === 0) plannedCampaign.island_states = initialIslandStates(1);
      const runtime = (plannedCampaign.search_runtime as Record<string, unknown> | undefined) ?? {};
      plannedCampaign.search_runtime = runtime;
      const nodes = this.store.loadNodes<Record<string, unknown>>(campaignId);
      refreshIslandPopulationSizes(plannedCampaign, nodes);
      const stepId = this.createId();
      const localUsage = { steps: 0, nodes: 0, tokens: 0, cost_usd: 0, wall_clock_s: 0 };
      const transitionEvents: Record<string, unknown>[] = [];
      const operatorEvents: Record<string, unknown>[] = [];
      const operatorTraceArtifacts: Array<[string, Record<string, unknown>]> = [];
      const evidenceArtifacts: Array<[string, Record<string, unknown>]> = [];
      const newNodeIds: string[] = [];
      const newNodesPayload: Record<string, unknown>[] = [];
      let earlyStopReason: string | undefined;
      let nStepsExecuted = 0;
      for (let tick = 0; tick < nStepsRequested; tick += 1) {
        if (stepBudgetExhausted(localUsage, params.step_budget)) {
          earlyStopReason = 'step_budget_exhausted';
          break;
        }
        if (exhaustedDimensions(plannedCampaign).length > 0) {
          plannedCampaign.status = 'exhausted';
          markIslandsExhausted(plannedCampaign);
          earlyStopReason = 'budget_exhausted';
          break;
        }
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
          const operator = chooseSearchOperator({ islandId, runtime, searchOperators: runtimePack.searchOperators, selectionPolicy: runtimePack.operatorSelectionPolicy });
          const operatorOutput = operator.run(
            { campaignId, islandId, parentNodeId: String(parentNode.node_id), stepId, tick: tick + 1 },
            structuredClone(parentNode),
          );
          const generatedAt = this.now();
          const evidencePacketName = `${stepId}-tick-${String(tick + 1).padStart(3, '0')}-librarian.json`;
          const evidencePacketRef = pathToFileURL(this.store.artifactPath(campaignId, 'evidence_packets', evidencePacketName)).href;
          const evidencePacketPayload = buildLibrarianEvidencePacket({ campaignId, domain: String((plannedCampaign.charter as Record<string, unknown>).domain ?? ''), generatedAt, islandId, operatorOutput, recipeBook, stepId, tick: tick + 1 });
          const newNode = buildOperatorNode({ campaignId, createId: this.createId, evidenceUris: claimEvidenceUris({ operatorEvidenceUris: operatorOutput.evidenceUrisUsed, packetPayload: evidencePacketPayload, packetRef: evidencePacketRef }), islandId, now: generatedAt, operatorOutput, parentNodeId: String(parentNode.node_id) });
          try {
            this.contracts.validateAgainstRef('./idea_node_v1.schema.json', newNode, `search.step/node/${String(newNode.node_id)}`);
          } catch (error) {
            if (error instanceof ContractRuntimeError) {
              throw schemaValidationError(`search.step generated invalid node: ${error.message}`, { campaign_id: campaignId });
            }
            throw error;
          }
          nodes[String(newNode.node_id)] = newNode;
          newNodeIds.push(String(newNode.node_id));
          newNodesPayload.push(structuredClone(newNode));
          evidenceArtifacts.push([evidencePacketName, evidencePacketPayload]);
          plannedCampaign.usage.nodes_used = Number(plannedCampaign.usage.nodes_used ?? 0) + 1;
          localUsage.nodes += 1;
          const traceArtifactName = `${stepId}-tick-${String(tick + 1).padStart(3, '0')}.json`;
          operatorTraceArtifacts.push([traceArtifactName, { campaign_id: campaignId, step_id: stepId, tick: tick + 1, island_id: islandId, operator_id: operatorOutput.operatorId, operator_family: operatorOutput.operatorFamily, backend_id: operatorOutput.backendId, parent_node_id: parentNode.node_id, new_node_id: newNode.node_id, operator_trace: structuredClone(newNode.operator_trace as Record<string, unknown>), evidence_packet_ref: evidencePacketRef, generated_at: generatedAt }]);
          operatorEvents.push({ tick: tick + 1, island_id: islandId, operator_id: operatorOutput.operatorId, operator_family: operatorOutput.operatorFamily, backend_id: operatorOutput.backendId, parent_node_id: parentNode.node_id, new_node_id: newNode.node_id, operator_trace_artifact_ref: pathToFileURL(this.store.artifactPath(campaignId, 'operator_traces', traceArtifactName)).href, evidence_packet_ref: evidencePacketRef });
          transitionEvent.operator_id = operatorOutput.operatorId;
          transitionEvent.new_node_id = newNode.node_id;
        } else {
          transitionEvent.operator_skipped = 'no_parent_node';
        }
        transitionEvents.push(transitionEvent);
        plannedCampaign.usage.steps_used = Number(plannedCampaign.usage.steps_used ?? 0) + 1;
        plannedCampaign.last_step_id = stepId;
        localUsage.steps += 1;
        nStepsExecuted += 1;
        setCampaignRunningIfBudgetAvailable(plannedCampaign);
        if (plannedCampaign.status === 'exhausted') {
          markIslandsExhausted(plannedCampaign);
          if (nStepsExecuted < nStepsRequested) earlyStopReason = 'budget_exhausted';
          break;
        }
      }
      refreshIslandPopulationSizes(plannedCampaign, nodes);
      const result: Record<string, unknown> = { campaign_id: campaignId, step_id: stepId, n_steps_requested: nStepsRequested, n_steps_executed: nStepsExecuted, new_node_ids: newNodeIds, updated_node_ids: [], island_states: structuredClone(plannedCampaign.island_states), budget_snapshot: budgetSnapshot(plannedCampaign), idempotency: responseIdempotency(idempotencyKeyValue, payloadHash) };
      if (newNodeIds.length > 0) result.new_nodes_artifact_ref = pathToFileURL(this.store.artifactPath(campaignId, 'search_steps', `${stepId}-new-nodes.json`)).href;
      if (earlyStopReason) Object.assign(result, { early_stopped: true, early_stop_reason: earlyStopReason });
      this.contracts.validateResult('search.step', result);
      storeIdempotency({ campaignId, createdAt: this.now(), idempotencyKeyValue, kind: 'result', method: 'search.step', payload: result, payloadHash, state: 'prepared', store: this.store });
      if (newNodeIds.length > 0) this.store.writeArtifact(campaignId, 'search_steps', `${stepId}-new-nodes.json`, { campaign_id: campaignId, step_id: stepId, new_node_ids: newNodeIds, nodes: newNodesPayload, operator_events: operatorEvents, generated_at: this.now() });
      for (const [artifactName, payload] of operatorTraceArtifacts) this.store.writeArtifact(campaignId, 'operator_traces', artifactName, payload);
      for (const [artifactName, payload] of evidenceArtifacts) this.store.writeArtifact(campaignId, 'evidence_packets', artifactName, payload);
      this.store.writeArtifact(campaignId, 'search_steps', `${stepId}.json`, { campaign_id: campaignId, step_id: stepId, n_steps_requested: nStepsRequested, n_steps_executed: nStepsExecuted, transition_events: transitionEvents, operator_events: operatorEvents, new_node_ids: newNodeIds, new_nodes_artifact_ref: result.new_nodes_artifact_ref ?? null, step_budget: params.step_budget ?? null, budget_snapshot: result.budget_snapshot, island_states: result.island_states, early_stopped: result.early_stopped ?? false, early_stop_reason: result.early_stop_reason ?? null, generated_at: this.now() });
      this.store.saveNodes(campaignId, nodes);
      for (const nodeId of newNodeIds) this.store.appendNodeLog(campaignId, nodes[nodeId]!, 'create');
      this.store.saveCampaign(plannedCampaign);
      storeIdempotency({ campaignId, createdAt: this.now(), idempotencyKeyValue, kind: 'result', method: 'search.step', payload: result, payloadHash, state: 'committed', store: this.store });
      return result;
    });
  }
}
