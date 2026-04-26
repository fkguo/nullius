import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'fs';
import { basename, join, relative, resolve } from 'path';
import { pathToFileURL, URL } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { appendJsonLine, readJsonFile, writeJsonFileAtomic } from '../store/file-io.js';
import { buildDistributorActionId } from './distributor-action-space.js';
import { type DistributorPolicyConfigRecord, loadDistributorPolicyConfig } from './distributor-config.js';
import { appendDistributorEvent } from './distributor-events.js';
import { recordDiscountedUcbOutcome, type DistributorStateSnapshot } from './distributor-discounted-ucb-v.js';
import { distributorStatePath, saveDistributorState } from './distributor-state.js';
import { schemaValidationError } from './errors.js';
import { validateFormalizationTrace } from './post-search-shared.js';
import { loadPromotionEvidenceSupport } from './promotion-evidence-support.js';
import computationFeedbackSchema from './computation_feedback_v1.schema.json' with { type: 'json' };

const PENDING_FEEDBACK_DIR = 'computation_feedback_pending';
const INGESTED_FEEDBACK_DIR = 'computation_feedback_ingested';
const FAILURE_LIBRARY_ARTIFACT_TYPE = 'failure_library';
const FAILED_APPROACH_NAME = 'failed_approach_v1.jsonl';
const FAILURE_LIBRARY_INDEX_PATH = 'global/failure_library_index_v1.json';

type AjvValidator = ((value: unknown) => boolean) & {
  errors?: Array<{ instancePath?: string; message?: string }>;
};

type AjvInstance = {
  addFormat: (name: string, validate: (value: string) => boolean) => void;
  compile: (schema: Record<string, unknown>) => AjvValidator;
};

type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;

const Ajv2020Ctor = Ajv2020 as unknown as AjvConstructor;
const feedbackAjv = new Ajv2020Ctor({
  allErrors: true,
  strict: false,
  validateFormats: true,
  addUsedSchema: false,
});

feedbackAjv.addFormat('uuid', value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
feedbackAjv.addFormat('date-time', value => value.includes('T') && !Number.isNaN(Date.parse(value)));
feedbackAjv.addFormat('uri', value => {
  try {
    const parsed = new URL(value);
    return parsed.protocol.length > 0;
  } catch {
    return false;
  }
});

const validateComputationFeedbackRecord = feedbackAjv.compile({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'local://idea-engine/computation_feedback_v1',
  ...(computationFeedbackSchema as Record<string, unknown>),
});

interface ComputationFeedbackRecord extends Record<string, unknown> {
  campaign_id: string;
  computation_result_uri: string;
  decision_kind: 'capture_finding' | 'branch_idea' | 'downgrade_idea' | 'literature_followup';
  execution_status: 'completed' | 'failed';
  executor_step_ids: string[];
  failure_reason: string | null;
  feedback_signal: 'success' | 'weak_signal' | 'failure';
  finished_at: string;
  idea_id: string;
  manifest_ref_uri: string;
  node_id: string;
  objective_title: string;
  priority_change: 'raise' | 'keep' | 'lower';
  produced_artifact_uris: string[];
  prune_candidate: boolean;
  run_id: string;
  source_handoff_uri: string;
  summary: string;
}

function pendingFeedbackDir(store: IdeaEngineStore, campaignId: string): string {
  return join(store.campaignDir(campaignId), 'artifacts', PENDING_FEEDBACK_DIR);
}

function ingestedFeedbackDir(store: IdeaEngineStore, campaignId: string): string {
  return join(store.campaignDir(campaignId), 'artifacts', INGESTED_FEEDBACK_DIR);
}

function failedApproachPath(store: IdeaEngineStore, campaignId: string): string {
  return store.artifactPath(campaignId, FAILURE_LIBRARY_ARTIFACT_TYPE, FAILED_APPROACH_NAME);
}

function listPendingFeedbackFiles(store: IdeaEngineStore, campaignId: string): string[] {
  const dir = pendingFeedbackDir(store, campaignId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(entry => entry.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right))
    .map(entry => resolve(dir, entry));
}

function readFeedbackRecord(options: {
  campaignId: string;
  filePath: string;
}): ComputationFeedbackRecord {
  const record = readJsonFile<Record<string, unknown>>(options.filePath, {} as Record<string, unknown>);
  if (!validateComputationFeedbackRecord(record)) {
    const first = validateComputationFeedbackRecord.errors?.[0];
    const location = first?.instancePath ? first.instancePath.slice(1) || '<root>' : '<root>';
    throw schemaValidationError(`queued computation feedback invalid at '${location}': ${first?.message ?? 'validation failed'}`, {
      campaign_id: options.campaignId,
    });
  }
  if (record.campaign_id !== options.campaignId) {
    throw schemaValidationError('queued computation feedback campaign_id does not match campaign', {
      campaign_id: options.campaignId,
    });
  }
  return record as ComputationFeedbackRecord;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function actionIdForNode(node: Record<string, unknown>): string {
  const traceInputs = (node.operator_trace as Record<string, unknown> | undefined)?.inputs;
  if (traceInputs && typeof traceInputs === 'object' && !Array.isArray(traceInputs)) {
    const typedInputs = traceInputs as Record<string, unknown>;
    if (typeof typedInputs.selected_action_id === 'string') {
      return typedInputs.selected_action_id;
    }
  }
  const backendId = typeof (node.origin as Record<string, unknown> | undefined)?.model === 'string'
    ? String((node.origin as Record<string, unknown>).model)
    : null;
  const operatorId = typeof node.operator_id === 'string' ? node.operator_id : null;
  const islandId = typeof node.island_id === 'string' ? node.island_id : null;
  if (!backendId || !operatorId || !islandId) {
    throw schemaValidationError('queued computation feedback cannot recover distributor action id from source node');
  }
  return buildDistributorActionId(backendId, operatorId, islandId);
}

function sourceStepIdForNode(node: Record<string, unknown>): string {
  const traceInputs = (node.operator_trace as Record<string, unknown> | undefined)?.inputs;
  if (traceInputs && typeof traceInputs === 'object' && !Array.isArray(traceInputs)) {
    const typedInputs = traceInputs as Record<string, unknown>;
    if (typeof typedInputs.step_id === 'string') {
      return typedInputs.step_id;
    }
  }
  if (typeof node.node_id === 'string') {
    return node.node_id;
  }
  throw schemaValidationError('queued computation feedback cannot recover source step_id from source node');
}

function splitActionId(actionId: string): { backendId: string; islandId: string; operatorId: string } {
  const parts = actionId.split('::');
  if (parts.length !== 3 || parts.some(part => !part)) {
    throw schemaValidationError(`invalid distributor action id in queued computation feedback: ${actionId}`);
  }
  return {
    backendId: parts[0]!,
    operatorId: parts[1]!,
    islandId: parts[2]!,
  };
}

function buildFailureLibraryIndexEntry(options: {
  campaign: Record<string, unknown>;
  failedApproach: Record<string, unknown>;
  filePath: string;
  lineNumber: number;
  store: IdeaEngineStore;
}): Record<string, unknown> {
  const campaignName = typeof (options.campaign.charter as Record<string, unknown> | undefined)?.campaign_name === 'string'
    ? String((options.campaign.charter as Record<string, unknown>).campaign_name)
    : String(options.campaign.campaign_id);
  return {
    project_slug: campaignName,
    artifact_relpath: relative(options.store.rootDir, options.filePath).split('\\').join('/'),
    line_number: options.lineNumber,
    failed_approach: options.failedApproach,
  };
}

function jsonLinesCount(filePath: string): number {
  if (!existsSync(filePath)) {
    return 0;
  }
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .length;
}

function updateFailureLibraryIndex(options: {
  campaign: Record<string, unknown>;
  contracts: IdeaEngineContractCatalog;
  failedApproach: Record<string, unknown>;
  now: string;
  store: IdeaEngineStore;
}): void {
  const indexPath = resolve(options.store.rootDir, FAILURE_LIBRARY_INDEX_PATH);
  const existing = readJsonFile<Record<string, unknown> | null>(indexPath, null);
  const index = existing ?? {
    version: 1,
    generated_at_utc: options.now,
    entries: [],
    stats: { projects_scanned: 0, entries_total: 0 },
  };
  if (existing) {
    options.contracts.validateAgainstRef(
      './failure_library_index_v1.schema.json',
      index,
      `search.step/failure_library_index/${String(options.campaign.campaign_id)}`,
    );
  }

  const entries = Array.isArray(index.entries) ? [...index.entries as Record<string, unknown>[]] : [];
  const alreadyIndexed = entries.some(entry => {
    const failed = entry.failed_approach as Record<string, unknown> | undefined;
    const evidence = Array.isArray(failed?.failure_evidence_uris) ? failed.failure_evidence_uris as unknown[] : [];
    return evidence.includes((options.failedApproach.failure_evidence_uris as string[])[0]);
  });
  if (alreadyIndexed) {
    return;
  }

  const filePath = failedApproachPath(options.store, String(options.campaign.campaign_id));
  const lineNumber = jsonLinesCount(filePath) + 1;
  options.contracts.validateAgainstRef(
    './failed_approach_v1.schema.json',
    options.failedApproach,
    `search.step/failed_approach/${String(options.campaign.campaign_id)}`,
  );
  entries.push(buildFailureLibraryIndexEntry({
    campaign: options.campaign,
    failedApproach: options.failedApproach,
    filePath,
    lineNumber,
    store: options.store,
  }));

  const projectSlugs = new Set(entries.map(entry => String((entry as Record<string, unknown>).project_slug)));
  const nextIndex = {
    version: 1,
    generated_at_utc: options.now,
    entries,
    stats: {
      projects_scanned: projectSlugs.size,
      entries_total: entries.length,
    },
  };
  options.contracts.validateAgainstRef(
    './failure_library_index_v1.schema.json',
    nextIndex,
    `search.step/failure_library_index/${String(options.campaign.campaign_id)}`,
  );
  appendJsonLine(filePath, options.failedApproach);
  writeJsonFileAtomic(indexPath, nextIndex);
}

function buildFailedApproach(options: {
  feedback: ComputationFeedbackRecord;
  node: Record<string, unknown>;
}): Record<string, unknown> {
  const ideaCard = options.node.idea_card as Record<string, unknown> | undefined;
  const candidateFormalisms = Array.isArray(ideaCard?.candidate_formalisms) ? ideaCard?.candidate_formalisms as string[] : [];
  const requiredObservables = Array.isArray(ideaCard?.required_observables) ? ideaCard?.required_observables as string[] : [];
  const selectedActionId = actionIdForNode(options.node);
  const operatorFamily = typeof options.node.operator_family === 'string' ? options.node.operator_family : 'unknown_operator_family';
  const failureMode = options.feedback.decision_kind === 'literature_followup' ? 'literature_backtrack' : 'execution_failure';
  const failureModes = uniqueStrings([failureMode, options.feedback.decision_kind, operatorFamily]);
  const lessons = uniqueStrings([
    options.feedback.failure_reason ?? options.feedback.summary,
    'Avoid rerunning the same promoted approach without changing the governing formalism, observables, or execution method.',
  ]);

  return {
    approach_id: options.feedback.node_id,
    campaign_id: options.feedback.campaign_id,
    idea_id: options.feedback.idea_id,
    approach_summary: typeof ideaCard?.thesis_statement === 'string'
      ? ideaCard.thesis_statement
      : options.feedback.objective_title,
    failure_mode: failureMode,
    failure_modes: failureModes,
    failure_evidence_uris: uniqueStrings([
      options.feedback.computation_result_uri,
      options.feedback.manifest_ref_uri,
      ...options.feedback.produced_artifact_uris,
    ]),
    lessons,
    reuse_potential: options.feedback.decision_kind === 'literature_followup' ? 'medium' : 'low',
    tags: uniqueStrings([
      `campaign:${options.feedback.campaign_id}`,
      `idea:${options.feedback.idea_id}`,
      `node:${options.feedback.node_id}`,
      `feedback:${options.feedback.feedback_signal}`,
      `decision:${options.feedback.decision_kind}`,
      `action:${selectedActionId}`,
      `operator_family:${operatorFamily}`,
      ...candidateFormalisms.map(item => `formalism:${item}`),
      ...requiredObservables.map(item => `observable:${item}`),
    ]),
    created_at: options.feedback.finished_at,
  };
}

function computeDownstreamReward(feedback: ComputationFeedbackRecord): {
  observedReward: number;
  realizedCost: Record<string, number>;
  rewardComponents: Record<string, number>;
} {
  const rewardComponents = {
    produced_structured_results: feedback.produced_artifact_uris.length > 0 ? 0.5 : 0,
    capture_finding: feedback.decision_kind === 'capture_finding' ? 0.75 : 0,
    branch_idea: feedback.decision_kind === 'branch_idea' ? 0.25 : 0,
  };
  return {
    observedReward: rewardComponents.produced_structured_results + rewardComponents.capture_finding + rewardComponents.branch_idea,
    realizedCost: {
      downstream_runs: 1,
      steps: 0,
      cost_usd: 0,
      wall_clock_s: 0,
      tokens: 0,
    },
    rewardComponents,
  };
}

function loadDistributorSnapshot(options: {
  campaignId: string;
  config: DistributorPolicyConfigRecord;
  contracts: IdeaEngineContractCatalog;
  store: IdeaEngineStore;
}): DistributorStateSnapshot {
  const snapshot = readJsonFile<DistributorStateSnapshot | null>(
    distributorStatePath(options.store, options.campaignId),
    null,
  );
  if (!snapshot) {
    throw schemaValidationError('queued computation feedback requires an existing distributor state snapshot', {
      campaign_id: options.campaignId,
    });
  }
  options.contracts.validateAgainstRef(
    './distributor_state_snapshot_v1.schema.json',
    snapshot,
    `search.step/distributor_state/${options.campaignId}`,
  );
  if (snapshot.campaign_id !== options.campaignId || snapshot.policy_id !== options.config.policy_id) {
    throw schemaValidationError('queued computation feedback distributor snapshot does not match campaign/policy', {
      campaign_id: options.campaignId,
    });
  }
  return snapshot;
}

function maxTick(snapshot: DistributorStateSnapshot): number {
  return Object.values(snapshot.action_stats).reduce((max, stats) => {
    const value = Number((stats as Record<string, unknown>).t_last ?? 0);
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0);
}

function canonicalHandoffRef(options: {
  campaignId: string;
  nodeId: string;
  store: IdeaEngineStore;
}): string {
  return pathToFileURL(options.store.artifactPath(
    options.campaignId,
    'handoff',
    `handoff-${options.nodeId}.json`,
  )).href;
}

function hasSupportedPromotionProvenance(options: {
  contracts: IdeaEngineContractCatalog;
  feedback: ComputationFeedbackRecord;
  node: Record<string, unknown>;
  store: IdeaEngineStore;
}): boolean {
  const groundingAudit = options.node.grounding_audit;
  const groundingAuditRecord = groundingAudit && typeof groundingAudit === 'object' && !Array.isArray(groundingAudit)
    ? groundingAudit as Record<string, unknown>
    : null;
  if (!groundingAuditRecord || groundingAuditRecord.status !== 'pass') {
    return false;
  }
  if (options.feedback.source_handoff_uri !== canonicalHandoffRef({
    campaignId: options.feedback.campaign_id,
    nodeId: options.feedback.node_id,
    store: options.store,
  })) {
    return false;
  }

  try {
    validateFormalizationTrace({
      campaignId: options.feedback.campaign_id,
      node: options.node,
      nodeId: options.feedback.node_id,
    });
    const evidenceSupport = loadPromotionEvidenceSupport({
      campaignId: options.feedback.campaign_id,
      contracts: options.contracts,
      node: options.node,
      nodeId: options.feedback.node_id,
      store: options.store,
    });
    const handoff = options.store.loadArtifactFromRef<Record<string, unknown>>(options.feedback.source_handoff_uri);
    const handoffSupport = handoff.evidence_support && typeof handoff.evidence_support === 'object' && !Array.isArray(handoff.evidence_support)
      ? handoff.evidence_support as Record<string, unknown>
      : null;
    return handoff.campaign_id === options.feedback.campaign_id
      && handoff.node_id === options.feedback.node_id
      && handoff.idea_id === options.feedback.idea_id
      && handoffSupport !== null
      && handoffSupport.scorecards_artifact_ref === evidenceSupport.scorecards_artifact_ref;
  } catch {
    return false;
  }
}

function applyDistributorFeedback(options: {
  campaign: Record<string, unknown>;
  contracts: IdeaEngineContractCatalog;
  createId: () => string;
  feedback: ComputationFeedbackRecord;
  node: Record<string, unknown>;
  store: IdeaEngineStore;
}): void {
  if (options.feedback.execution_status !== 'completed' || options.feedback.feedback_signal !== 'success') {
    return;
  }
  const distributor = loadDistributorPolicyConfig({
    campaign: options.campaign,
    contracts: options.contracts,
    store: options.store,
  });
  if (!distributor) {
    return;
  }
  if (!hasSupportedPromotionProvenance({
    contracts: options.contracts,
    feedback: options.feedback,
    node: options.node,
    store: options.store,
  })) {
    return;
  }

  const selectedActionId = actionIdForNode(options.node);
  const snapshot = loadDistributorSnapshot({
    campaignId: options.feedback.campaign_id,
    config: distributor.config,
    contracts: options.contracts,
    store: options.store,
  });
  if (!(selectedActionId in snapshot.action_stats)) {
    throw schemaValidationError(`queued computation feedback selected action is not present in distributor state: ${selectedActionId}`, {
      campaign_id: options.feedback.campaign_id,
    });
  }

  const reward = computeDownstreamReward(options.feedback);
  recordDiscountedUcbOutcome({
    observedReward: reward.observedReward,
    realizedCostScalar: Object.values(reward.realizedCost).reduce((sum, value) => sum + value, 0),
    selectedActionId,
    snapshot,
    timestamp: options.feedback.finished_at,
    tick: maxTick(snapshot) + 1,
  });

  const selectedAction = splitActionId(selectedActionId);
  appendDistributorEvent({
    campaignId: options.feedback.campaign_id,
    contracts: options.contracts,
    event: {
      campaign_id: options.feedback.campaign_id,
      step_id: sourceStepIdForNode(options.node),
      decision_id: options.createId(),
      timestamp: options.feedback.finished_at,
      policy_id: distributor.config.policy_id,
      factorization: String(distributor.config.action_space.factorization),
      eligible_action_ids: Object.keys(snapshot.action_stats).sort((left, right) => left.localeCompare(right)),
      selected_action: {
        backend_id: selectedAction.backendId,
        operator_id: selectedAction.operatorId,
        island_id: selectedAction.islandId,
      },
      observed_reward: reward.observedReward,
      realized_cost: reward.realizedCost,
      diagnostics: {
        source: 'computation_feedback',
        policy_family: distributor.config.policy_family,
        computation_result_uri: options.feedback.computation_result_uri,
        feedback_signal: options.feedback.feedback_signal,
        decision_kind: options.feedback.decision_kind,
        reward_components: reward.rewardComponents,
      },
    },
    store: options.store,
  });
  saveDistributorState({
    config: distributor.config,
    contracts: options.contracts,
    snapshot,
    store: options.store,
  });
}

export function drainPendingComputationFeedback(options: {
  campaign: Record<string, unknown>;
  contracts: IdeaEngineContractCatalog;
  createId: () => string;
  store: IdeaEngineStore;
}): void {
  const campaignId = String(options.campaign.campaign_id);
  const nodes = options.store.loadNodes<Record<string, unknown>>(campaignId);
  const pendingFiles = listPendingFeedbackFiles(options.store, campaignId);
  if (pendingFiles.length === 0) {
    return;
  }

  const ingestedDir = ingestedFeedbackDir(options.store, campaignId);
  mkdirSync(ingestedDir, { recursive: true });

  for (const filePath of pendingFiles) {
    const feedback = readFeedbackRecord({
      campaignId,
      filePath,
    });
    const node = nodes[feedback.node_id];
    if (!node) {
      throw schemaValidationError('queued computation feedback node_id is not present in the campaign node store', {
        campaign_id: campaignId,
        node_id: feedback.node_id,
      });
    }

    if (feedback.feedback_signal === 'failure') {
      updateFailureLibraryIndex({
        campaign: options.campaign,
        contracts: options.contracts,
        failedApproach: buildFailedApproach({ feedback, node }),
        now: feedback.finished_at,
        store: options.store,
      });
    }

    applyDistributorFeedback({
      campaign: options.campaign,
      contracts: options.contracts,
      createId: options.createId,
      feedback,
      node,
      store: options.store,
    });

    renameSync(filePath, resolve(ingestedDir, basename(filePath) || `${feedback.run_id}.json`));
  }
}
