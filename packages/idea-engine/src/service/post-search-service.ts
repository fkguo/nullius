import { randomUUID } from 'crypto';
import { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import { hashWithoutIdempotency } from '../hash/payload-hash.js';
import { IdeaEngineStore } from '../store/engine-store.js';
import { RpcError } from './errors.js';
import { executeEvalRun } from './eval-run-executor.js';
import { executeNodePromote } from './node-promote-executor.js';
import { executeRankCompute } from './rank-compute-executor.js';
import { toSchemaError, utcNowIso } from './service-contract-error.js';

const POST_SEARCH_METHODS = new Set(['eval.run', 'rank.compute', 'node.promote']);

export class IdeaEnginePostSearchService {
  readonly contracts: IdeaEngineContractCatalog;
  readonly store: IdeaEngineStore;
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(options: { contractDir?: string; createId?: () => string; now?: () => string; rootDir: string }) {
    this.store = new IdeaEngineStore(options.rootDir);
    this.contracts = new IdeaEngineContractCatalog(options.contractDir);
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? utcNowIso;
  }

  canHandle(method: string): boolean {
    return POST_SEARCH_METHODS.has(method);
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
      if (method === 'eval.run') {
        return executeEvalRun({
          contracts: this.contracts,
          createId: this.createId,
          now: this.now,
          params: typedParams,
          payloadHash,
          store: this.store,
        });
      }
      if (method === 'rank.compute') {
        return executeRankCompute({
          contracts: this.contracts,
          now: this.now,
          params: typedParams,
          payloadHash,
          store: this.store,
        });
      }
      return executeNodePromote({
        contracts: this.contracts,
        now: this.now,
        params: typedParams,
        payloadHash,
        store: this.store,
      });
    } catch (error) {
      if (error instanceof RpcError) {
        this.contracts.validateErrorData(error.data);
        throw error;
      }
      throw toSchemaError(error);
    }
  }
}
