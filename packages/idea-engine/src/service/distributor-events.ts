import { appendJsonLine } from '../store/file-io.js';
import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';

const DISTRIBUTOR_EVENTS_NAME = 'distributor_events_v1.jsonl';
const DISTRIBUTOR_ARTIFACT_TYPE = 'distributor';

export function appendDistributorEvent(options: {
  campaignId: string;
  contracts: IdeaEngineContractCatalog;
  event: Record<string, unknown>;
  store: IdeaEngineStore;
}): void {
  options.contracts.validateAgainstRef(
    './distributor_event_v1.schema.json',
    options.event,
    `search.step/distributor_event/${options.campaignId}`,
  );
  appendJsonLine(
    options.store.artifactPath(options.campaignId, DISTRIBUTOR_ARTIFACT_TYPE, DISTRIBUTOR_EVENTS_NAME),
    options.event,
  );
}
