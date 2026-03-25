import { randomUUID } from 'crypto';
import { IdeaEngineContractCatalog, ContractRuntimeError } from '../contracts/catalog.js';
import { executeSearchStep } from './search-step-executor.js';
import { hashWithoutIdempotency } from '../hash/payload-hash.js';
import { IdeaEngineStore } from '../store/engine-store.js';
import { RpcError, schemaValidationError } from './errors.js';
import { utcNowIso } from './service-contract-error.js';

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
      const typedParams = params as Record<string, unknown>;
      return executeSearchStep({
        contracts: this.contracts,
        createId: this.createId,
        now: this.now,
        params: typedParams,
        payloadHash: hashWithoutIdempotency('search.step', typedParams),
        store: this.store,
      });
    } catch (error) {
      if (error instanceof ContractRuntimeError) throw schemaValidationError(error.message);
      if (error instanceof RpcError) this.contracts.validateErrorData(error.data);
      throw error;
    }
  }
}
