import { IdeaEngineReadService } from './read-service.js';
import { IdeaEnginePostSearchService } from './post-search-service.js';
import { IdeaEngineSearchStepService } from './search-step-service.js';
import { IdeaEngineWriteService } from './write-service.js';

export class IdeaEngineRpcService {
  readonly read: IdeaEngineReadService;
  readonly postSearch: IdeaEnginePostSearchService;
  readonly search: IdeaEngineSearchStepService;
  readonly write: IdeaEngineWriteService;

  constructor(options: { contractDir?: string; createId?: () => string; now?: () => string; rootDir: string }) {
    this.read = new IdeaEngineReadService({ rootDir: options.rootDir });
    this.postSearch = new IdeaEnginePostSearchService(options);
    this.search = new IdeaEngineSearchStepService(options);
    this.write = new IdeaEngineWriteService(options);
  }

  handle(method: string, params: unknown): Record<string, unknown> {
    if (
      method === 'campaign.init'
      || method === 'campaign.topup'
      || method === 'campaign.pause'
      || method === 'campaign.resume'
      || method === 'campaign.complete'
    ) {
      return this.write.handle(method, params);
    }
    if (method === 'search.step') {
      return this.search.handle(method, params);
    }
    if (this.postSearch.canHandle(method)) {
      return this.postSearch.handle(method, params);
    }
    return this.read.handle(method, params);
  }
}
