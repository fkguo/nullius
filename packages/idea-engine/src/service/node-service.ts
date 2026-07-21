import { shortId } from '@nullius/shared';
import { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import { hashWithoutIdempotency } from '../hash/payload-hash.js';
import { IdeaEngineStore } from '../store/engine-store.js';
import { RpcError } from './errors.js';
import { executeImportGenerated } from './import-generated-executor.js';
import { executeNodePromote } from './node-promote-executor.js';
import { executeNodeReviseCard } from './node-revise-card-executor.js';
import { executeNodeRewriteProvenance } from './node-rewrite-provenance-executor.js';
import { executeNodeSetGroundingAudit } from './node-set-grounding-audit-executor.js';
import { executeNodeSetLifecycle } from './node-set-lifecycle-executor.js';
import { executeNodeSetPosterior } from './node-set-posterior-executor.js';
import { executeRankCompute } from './rank-compute-executor.js';
import { toSchemaError, utcNowIso } from './service-contract-error.js';

const NODE_METHODS = new Set([
  'rank.compute',
  'node.promote',
  'node.set_posterior',
  'node.set_lifecycle',
  'node.set_grounding_audit',
  'node.revise_card',
  'node.rewrite_provenance',
  'node.import_generated',
]);

const CAMPAIGN_ID_RE = /^[0123456789abcdefghjkmnpqrstvwxyz]{8}$/;

function hasRevisionIdempotencyScope(params: unknown): params is Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return false;
  }
  const record = params as Record<string, unknown>;
  return typeof record.campaign_id === 'string'
    && CAMPAIGN_ID_RE.test(record.campaign_id)
    && typeof record.idempotency_key === 'string'
    && record.idempotency_key.length > 0;
}

export class IdeaEngineNodeService {
  readonly contracts: IdeaEngineContractCatalog;
  readonly store: IdeaEngineStore;
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(options: { contractDir?: string; createId?: () => string; now?: () => string; projectRoot?: string; rootDir: string }) {
    this.store = new IdeaEngineStore(options.rootDir, { projectRoot: options.projectRoot });
    this.contracts = new IdeaEngineContractCatalog(options.contractDir);
    this.now = options.now ?? utcNowIso;
    this.createId = options.createId ?? shortId;
  }

  canHandle(method: string): boolean {
    return NODE_METHODS.has(method);
  }

  handle(method: string, params: unknown): Record<string, unknown> {
    if (!this.canHandle(method)) {
      throw new RpcError(-32601, 'method_not_found', {
        reason: 'method_not_found',
        details: { method },
      });
    }

    try {
      // node.revise_card owns exact first-response idempotency, including
      // rejected requests. Once its safe campaign/key scope is identifiable,
      // hash and enter the executor before deep schema validation so an
      // existing different payload conflicts and an existing error replays
      // instead of being re-evaluated against later node state.
      if (method === 'node.revise_card' && hasRevisionIdempotencyScope(params)) {
        return executeNodeReviseCard({
          contracts: this.contracts,
          now: this.now,
          params,
          payloadHash: hashWithoutIdempotency(method, params),
          store: this.store,
        });
      }
      this.contracts.validateRequestParams(method, params);
      const typedParams = params as Record<string, unknown>;
      const payloadHash = hashWithoutIdempotency(method, typedParams);
      const executorOptions = {
        contracts: this.contracts,
        now: this.now,
        params: typedParams,
        payloadHash,
        store: this.store,
      };
      if (method === 'rank.compute') {
        return executeRankCompute(executorOptions);
      }
      if (method === 'node.set_posterior') {
        return executeNodeSetPosterior(executorOptions);
      }
      if (method === 'node.set_lifecycle') {
        return executeNodeSetLifecycle(executorOptions);
      }
      if (method === 'node.set_grounding_audit') {
        return executeNodeSetGroundingAudit(executorOptions);
      }
      if (method === 'node.revise_card') {
        return executeNodeReviseCard(executorOptions);
      }
      if (method === 'node.rewrite_provenance') {
        return executeNodeRewriteProvenance(executorOptions);
      }
      if (method === 'node.import_generated') {
        return executeImportGenerated({ ...executorOptions, createId: this.createId });
      }
      return executeNodePromote(executorOptions);
    } catch (error) {
      if (error instanceof RpcError) {
        this.contracts.validateErrorData(error.data);
        throw error;
      }
      throw toSchemaError(error);
    }
  }
}
