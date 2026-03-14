import { getMethodContract, getMethodDefault } from '../contracts/openrpc.js';
import { schemaValidationError } from './errors.js';
import type { NodeListFilter } from './filter-nodes.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILTER_KEYS = new Set([
  'idea_id',
  'node_id',
  'island_id',
  'operator_id',
  'has_idea_card',
  'has_eval_info',
  'has_reduction_report',
  'grounding_status',
]);

type ParamsRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is ParamsRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertUuid(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw schemaValidationError(`${fieldName} must be a UUID string`);
  }
  return value;
}

function assertNoExtraParams(method: string, params: ParamsRecord): void {
  const allowed = new Set((getMethodContract(method)?.params ?? []).map(param => param.name));
  const extras = Object.keys(params).filter(key => !allowed.has(key));
  if (extras.length > 0) {
    throw schemaValidationError(`unknown params: ${extras.join(', ')}`);
  }
}

function assertRequiredParams(method: string, params: ParamsRecord): void {
  const missing = (getMethodContract(method)?.params ?? [])
    .filter(param => param.required)
    .map(param => param.name)
    .filter(name => !(name in params));
  if (missing.length > 0) {
    throw schemaValidationError(`missing required params: ${missing.join(', ')}`);
  }
}

function validateFilter(filter: unknown): NodeListFilter | undefined {
  if (filter === undefined) return undefined;
  if (!isPlainObject(filter)) {
    throw schemaValidationError('filter must be an object');
  }

  const extras = Object.keys(filter).filter(key => !FILTER_KEYS.has(key));
  if (extras.length > 0) {
    throw schemaValidationError(`filter has unknown fields: ${extras.join(', ')}`);
  }

  if (filter.idea_id !== undefined) assertUuid(filter.idea_id, 'filter.idea_id');
  if (filter.node_id !== undefined) assertUuid(filter.node_id, 'filter.node_id');
  if (filter.island_id !== undefined && typeof filter.island_id !== 'string') throw schemaValidationError('filter.island_id must be a string');
  if (filter.operator_id !== undefined && typeof filter.operator_id !== 'string') throw schemaValidationError('filter.operator_id must be a string');
  if (filter.has_idea_card !== undefined && typeof filter.has_idea_card !== 'boolean') throw schemaValidationError('filter.has_idea_card must be a boolean');
  if (filter.has_eval_info !== undefined && typeof filter.has_eval_info !== 'boolean') throw schemaValidationError('filter.has_eval_info must be a boolean');
  if (filter.has_reduction_report !== undefined && typeof filter.has_reduction_report !== 'boolean') throw schemaValidationError('filter.has_reduction_report must be a boolean');
  if (filter.grounding_status !== undefined && !['pass', 'fail', 'partial'].includes(String(filter.grounding_status))) {
    throw schemaValidationError('filter.grounding_status must be one of pass, fail, partial');
  }

  return filter as NodeListFilter;
}

export function validateReadParams(
  method: string,
  params: unknown,
): ParamsRecord {
  if (!isPlainObject(params)) {
    throw schemaValidationError('params must be an object');
  }

  assertRequiredParams(method, params);
  assertNoExtraParams(method, params);

  if (method === 'campaign.status') {
    return { campaign_id: assertUuid(params.campaign_id, 'campaign_id') };
  }

  if (method === 'node.get') {
    return {
      campaign_id: assertUuid(params.campaign_id, 'campaign_id'),
      node_id: assertUuid(params.node_id, 'node_id'),
    };
  }

  if (method === 'node.list') {
    const limitDefault = getMethodDefault('node.list', 'limit');
    const limit = params.limit === undefined ? limitDefault : params.limit;
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 500) {
      throw schemaValidationError('limit must be an integer between 1 and 500');
    }

    if (params.cursor !== undefined && typeof params.cursor !== 'string') {
      throw schemaValidationError('cursor must be a string');
    }

    return {
      campaign_id: assertUuid(params.campaign_id, 'campaign_id'),
      filter: validateFilter(params.filter),
      cursor: params.cursor,
      limit: Number(limit),
    };
  }

  throw schemaValidationError(`unsupported read method: ${method}`);
}
