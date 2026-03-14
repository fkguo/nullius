import { IdeaEngineReadService } from './read-service.js';
import { IdeaEngineSearchStepService } from './search-step-service.js';
import { IdeaEngineWriteService } from './write-service.js';

export class IdeaEngineRpcService {
  readonly read: IdeaEngineReadService;
  readonly search: IdeaEngineSearchStepService;
  readonly write: IdeaEngineWriteService;

  constructor(options: { contractDir?: string; createId?: () => string; now?: () => string; rootDir: string }) {
    this.read = new IdeaEngineReadService({ rootDir: options.rootDir });
    this.search = new IdeaEngineSearchStepService(options);
    this.write = new IdeaEngineWriteService(options);
  }

  handle(method: string, params: unknown): Record<string, unknown> {
    if (method === 'campaign.init') {
      return this.write.handle(method, params);
    }
    if (method === 'search.step') {
      return this.search.handle(method, params);
    }
    return this.read.handle(method, params);
  }
}
