import { IdeaEngineNodeService } from './node-service.js';
import { IdeaEngineReadService } from './read-service.js';
import { IdeaEngineWriteService } from './write-service.js';

export class IdeaEngineRpcService {
  readonly read: IdeaEngineReadService;
  readonly node: IdeaEngineNodeService;
  readonly write: IdeaEngineWriteService;

  constructor(options: { contractDir?: string; createId?: () => string; now?: () => string; projectRoot?: string; rootDir: string }) {
    this.read = new IdeaEngineReadService({ projectRoot: options.projectRoot, rootDir: options.rootDir });
    this.node = new IdeaEngineNodeService(options);
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
    if (this.node.canHandle(method)) {
      return this.node.handle(method, params);
    }
    return this.read.handle(method, params);
  }
}
