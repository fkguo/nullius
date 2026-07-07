import { shortId } from '@nullius/shared';
import { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import { hashWithoutIdempotency } from '../hash/payload-hash.js';
import { IdeaEngineStore } from '../store/engine-store.js';
import { RpcError } from './errors.js';
import { executeImportGenerated } from './import-generated-executor.js';
import { executeNodePromote } from './node-promote-executor.js';
import { executeNodeSetLifecycle } from './node-set-lifecycle-executor.js';
import { executeNodeSetPosterior } from './node-set-posterior-executor.js';
import { executeRankCompute } from './rank-compute-executor.js';
import { toSchemaError, utcNowIso } from './service-contract-error.js';

const NODE_METHODS = new Set([
  'rank.compute',
  'node.promote',
  'node.set_posterior',
  'node.set_lifecycle',
  'node.import_generated',
]);

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
