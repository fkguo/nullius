import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { ContractRuntimeError, IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { schemaValidationError } from './errors.js';
import type { SearchCampaignRecord } from './search-step-campaign.js';

export interface SearchFailureAvoidance {
  artifactRef: string;
  hitCount: number;
  hits: Array<{ approachSummary: string; failureMode: string; lessons: string[] }>;
  matchedFailureModes: string[];
  matchedTags: string[];
}

export interface PreparedFailureAvoidance {
  artifactPath: string;
  artifactPayload: Record<string, unknown>;
  summary: SearchFailureAvoidance;
}

interface FailureLibraryIndexEntry {
  artifact_relpath: string;
  failed_approach: {
    approach_summary: string;
    failure_mode: string;
    failure_modes?: string[];
    lessons?: string[];
    tags?: string[];
  };
  line_number: number;
  project_slug: string;
}

interface FailureLibraryConfig {
  indexPath: string;
  queryDoc: Record<string, unknown>;
  source: 'derived' | 'explicit';
}

const DEFAULT_FAILURE_LIBRARY_INDEX_PATH = 'global/failure_library_index_v1.json';
const DEFAULT_FAILURE_LIBRARY_OUTPUT_PATH = 'artifacts/failure_library/failure_library_hits_v1.json';

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.filter((item): item is string => typeof item === 'string'));
}

function tagValues(prefix: string, values: string[]): string[] {
  return values.map(value => `${prefix}:${value}`);
}

function actionTagForNode(node: Record<string, unknown>): string | null {
  const traceInputs = (node.operator_trace as Record<string, unknown> | undefined)?.inputs;
  if (traceInputs && typeof traceInputs === 'object' && !Array.isArray(traceInputs)) {
    const selectedActionId = (traceInputs as Record<string, unknown>).selected_action_id;
    if (typeof selectedActionId === 'string' && selectedActionId.trim()) {
      return `action:${selectedActionId.trim()}`;
    }
  }

  const backendId = typeof (node.origin as Record<string, unknown> | undefined)?.model === 'string'
    ? String((node.origin as Record<string, unknown>).model).trim()
    : '';
  const operatorId = typeof node.operator_id === 'string' ? node.operator_id.trim() : '';
  const islandId = typeof node.island_id === 'string' ? node.island_id.trim() : '';
  if (!backendId || !operatorId || !islandId) return null;
  return `action:${backendId}::${operatorId}::${islandId}`;
}

function buildDerivedFailureLibraryQueryDoc(options: {
  node?: Record<string, unknown>;
  now: string;
  outputArtifactPath?: string;
}): Record<string, unknown> | null {
  const node = options.node;
  if (!node) return null;

  const ideaCard = node.idea_card && typeof node.idea_card === 'object' && !Array.isArray(node.idea_card)
    ? node.idea_card as Record<string, unknown>
    : null;
  const evalInfo = node.eval_info && typeof node.eval_info === 'object' && !Array.isArray(node.eval_info)
    ? node.eval_info as Record<string, unknown>
    : null;

  const actionTag = actionTagForNode(node);
  const tags = uniqueStrings([
    ...(actionTag ? [actionTag] : []),
    ...(typeof node.operator_family === 'string' && node.operator_family.trim()
      ? [`operator_family:${node.operator_family.trim()}`]
      : []),
    ...tagValues('formalism', stringArray(ideaCard?.candidate_formalisms)),
    ...tagValues('observable', stringArray(ideaCard?.required_observables)),
  ]);
  if (tags.length === 0) return null;

  const failureModes = stringArray(evalInfo?.failure_modes);
  return {
    version: 1,
    generated_at_utc: options.now,
    query: {
      tags,
      ...(failureModes.length > 0 ? { failure_modes: failureModes } : {}),
    },
    output_artifact_path: options.outputArtifactPath ?? DEFAULT_FAILURE_LIBRARY_OUTPUT_PATH,
  };
}

function validateSchema(
  contracts: IdeaEngineContractCatalog,
  ref: string,
  instance: unknown,
  scope: string,
  campaignId: string,
): void {
  try {
    contracts.validateAgainstRef(ref, instance, scope);
  } catch (error) {
    if (error instanceof ContractRuntimeError) {
      throw schemaValidationError(error.message, { campaign_id: campaignId });
    }
    throw error;
  }
}
function resolveWithin(baseDir: string, relativePath: string, label: string, campaignId: string): string {
  if (!relativePath.trim()) {
    throw schemaValidationError(`${label} must be a non-empty relative path`, { campaign_id: campaignId });
  }
  const resolved = resolve(baseDir, relativePath);
  if (resolved !== baseDir && !resolved.startsWith(`${baseDir}/`)) {
    throw schemaValidationError(`${label} must stay within ${label === 'failure_library.index_path' ? 'store root' : 'campaign root'}`, {
      campaign_id: campaignId,
    });
  }
  return resolved;
}

function rejectBroadTextQuery(queryDoc: Record<string, unknown>, campaignId: string): void {
  const query = queryDoc.query;
  if (!query || typeof query !== 'object' || Array.isArray(query)) return;
  const text = (query as Record<string, unknown>).text;
  if (typeof text === 'string' && text.trim()) {
    throw schemaValidationError('failure_library.query.text is unsupported for search.step failure reflection; use bounded tags and failure_modes', {
      campaign_id: campaignId,
    });
  }
}

function loadFailureLibraryConfig(options: {
  campaign: SearchCampaignRecord;
  campaignId: string;
  node?: Record<string, unknown>;
  now: string;
  outputArtifactPath?: string;
}): FailureLibraryConfig | null {
  const { campaign, campaignId } = options;
  const extensions = typeof campaign.charter.extensions === 'object' && campaign.charter.extensions && !Array.isArray(campaign.charter.extensions)
    ? campaign.charter.extensions as Record<string, unknown>
    : {};
  const raw = extensions.failure_library;
  if (raw === undefined) {
    const queryDoc = buildDerivedFailureLibraryQueryDoc({
      node: options.node,
      now: options.now,
      outputArtifactPath: options.outputArtifactPath,
    });
    if (!queryDoc) return null;
    return {
      indexPath: DEFAULT_FAILURE_LIBRARY_INDEX_PATH,
      queryDoc,
      source: 'derived',
    };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw schemaValidationError('failure_library extension must be an object', { campaign_id: campaignId });
  }
  const config = raw as Record<string, unknown>;
  if (!config.query || typeof config.query !== 'object' || Array.isArray(config.query)) {
    throw schemaValidationError('failure_library.query must be an object', { campaign_id: campaignId });
  }
  if (config.index_path !== undefined && (typeof config.index_path !== 'string' || !config.index_path.trim())) {
    throw schemaValidationError('failure_library.index_path must be a non-empty string when provided', { campaign_id: campaignId });
  }
  const queryDoc = structuredClone(config.query as Record<string, unknown>);
  rejectBroadTextQuery(queryDoc, campaignId);
  return {
    indexPath: typeof config.index_path === 'string' ? config.index_path.trim() : DEFAULT_FAILURE_LIBRARY_INDEX_PATH,
    queryDoc,
    source: 'explicit',
  };
}
function matchesEntry(entry: FailureLibraryIndexEntry, queryDoc: Record<string, unknown>): boolean {
  const query = queryDoc.query as Record<string, unknown>;
  const queryTags = uniqueStrings(Array.isArray(query.tags) ? query.tags.map(value => String(value).toLowerCase()) : []);
  const entryTags = new Set(uniqueStrings((entry.failed_approach.tags ?? []).map(value => value.toLowerCase())));
  if (queryTags.some(tag => !entryTags.has(tag))) return false;

  const rawFailureModes = Array.isArray(query.failure_modes) ? query.failure_modes.map(value => String(value).toLowerCase()) : [];
  if (rawFailureModes.length > 0) {
    const entryFailureModes = new Set(uniqueStrings([
      entry.failed_approach.failure_mode,
      ...(entry.failed_approach.failure_modes ?? []),
    ].map(value => value.toLowerCase())));
    if (!rawFailureModes.some(mode => entryFailureModes.has(mode))) return false;
  }

  return true;
}

export function prepareFailureAvoidance(options: {
  campaign: SearchCampaignRecord;
  contracts: IdeaEngineContractCatalog;
  node?: Record<string, unknown>;
  now: string;
  outputArtifactPath?: string;
  store: IdeaEngineStore;
}): PreparedFailureAvoidance | undefined {
  const config = loadFailureLibraryConfig({
    campaign: options.campaign,
    campaignId: options.campaign.campaign_id,
    node: options.node,
    now: options.now,
    outputArtifactPath: options.outputArtifactPath,
  });
  if (!config) return undefined;

  validateSchema(
    options.contracts,
    './failure_library_query_v1.schema.json',
    config.queryDoc,
    `failure_library_query/${options.campaign.campaign_id}`,
    options.campaign.campaign_id,
  );

  const indexPath = resolveWithin(options.store.rootDir, config.indexPath, 'failure_library.index_path', options.campaign.campaign_id);
  if (config.source === 'derived' && !existsSync(indexPath)) {
    return undefined;
  }
  let indexDoc: Record<string, unknown>;
  try {
    indexDoc = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw schemaValidationError(`failed to load failure library index: ${detail}`, { campaign_id: options.campaign.campaign_id });
  }
  validateSchema(
    options.contracts,
    './failure_library_index_v1.schema.json',
    indexDoc,
    `failure_library_index/${options.campaign.campaign_id}`,
    options.campaign.campaign_id,
  );

  const entries = ((indexDoc.entries as FailureLibraryIndexEntry[] | undefined) ?? []).filter(entry => matchesEntry(entry, config.queryDoc));
  const deduped: FailureLibraryIndexEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.project_slug}|${entry.artifact_relpath}|${entry.line_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(structuredClone(entry));
  }
  const maxHits = typeof config.queryDoc.max_hits === 'number' ? config.queryDoc.max_hits : 50;
  const hits = deduped.slice(0, maxHits);
  const artifactRelativePath = String(config.queryDoc.output_artifact_path);
  const artifactPath = resolveWithin(options.store.campaignDir(options.campaign.campaign_id), artifactRelativePath, 'failure_library.query.output_artifact_path', options.campaign.campaign_id);
  const artifactRef = pathToFileURL(artifactPath).href;
  const artifactPayload = {
    version: 1,
    generated_at_utc: options.now,
    query: structuredClone(config.queryDoc),
    index_ref: {
      path: config.indexPath,
      generated_at_utc: String(indexDoc.generated_at_utc),
      entries_total: Array.isArray(indexDoc.entries) ? indexDoc.entries.length : 0,
    },
    hits,
  };
  validateSchema(
    options.contracts,
    './failure_library_hits_v1.schema.json',
    artifactPayload,
    `failure_library_hits/${options.campaign.campaign_id}`,
    options.campaign.campaign_id,
  );

  return {
    artifactPath,
    artifactPayload,
    summary: {
      artifactRef,
      hitCount: hits.length,
      hits: hits.map(entry => ({
        approachSummary: entry.failed_approach.approach_summary,
        failureMode: entry.failed_approach.failure_mode,
        lessons: [...(entry.failed_approach.lessons ?? [])],
      })),
      matchedFailureModes: uniqueStrings(hits.map(entry => entry.failed_approach.failure_mode)),
      matchedTags: uniqueStrings(hits.flatMap(entry => entry.failed_approach.tags ?? [])),
    },
  };
}
