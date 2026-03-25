import { readFileSync } from 'fs';
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
function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
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
function loadFailureLibraryConfig(campaign: SearchCampaignRecord, campaignId: string): { indexPath: string; queryDoc: Record<string, unknown> } | null {
  const extensions = typeof campaign.charter.extensions === 'object' && campaign.charter.extensions && !Array.isArray(campaign.charter.extensions)
    ? campaign.charter.extensions as Record<string, unknown>
    : {};
  const raw = extensions.failure_library;
  if (raw === undefined) return null;
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
  return {
    indexPath: typeof config.index_path === 'string' ? config.index_path.trim() : 'global/failure_library_index_v1.json',
    queryDoc: structuredClone(config.query as Record<string, unknown>),
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

  if (typeof query.text === 'string' && query.text.trim()) {
    const haystack = [
      entry.failed_approach.approach_summary,
      ...(entry.failed_approach.lessons ?? []),
      entry.failed_approach.failure_mode,
      ...(entry.failed_approach.failure_modes ?? []),
      ...(entry.failed_approach.tags ?? []),
    ].join(' ').toLowerCase();
    if (!haystack.includes(query.text.trim().toLowerCase())) return false;
  }

  return true;
}

export function prepareFailureAvoidance(options: {
  campaign: SearchCampaignRecord;
  contracts: IdeaEngineContractCatalog;
  now: string;
  store: IdeaEngineStore;
}): PreparedFailureAvoidance | undefined {
  const config = loadFailureLibraryConfig(options.campaign, options.campaign.campaign_id);
  if (!config) return undefined;

  validateSchema(
    options.contracts,
    './failure_library_query_v1.schema.json',
    config.queryDoc,
    `failure_library_query/${options.campaign.campaign_id}`,
    options.campaign.campaign_id,
  );

  const indexPath = resolveWithin(options.store.rootDir, config.indexPath, 'failure_library.index_path', options.campaign.campaign_id);
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
