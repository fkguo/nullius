import { payloadHash as artifactPayloadHash } from '../hash/payload-hash.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { NodeLogCorruptionError } from '../store/node-log-store.js';
import { RpcError } from './errors.js';
import type { IdempotencyRecord } from './idempotency.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function recoveryConflict(campaignId: string, nodeId: string, message: string, details: Record<string, unknown> = {}): RpcError {
  return new RpcError(-32603, 'internal_error', {
    reason: 'idea_card_revision_recovery_conflict',
    campaign_id: campaignId,
    node_id: nodeId,
    details: { message, ...details },
  });
}

function loadRecoverableLog(store: IdeaEngineStore, campaignId: string, nodeId: string, event: Record<string, unknown>): Array<Record<string, unknown>> {
  try {
    return store.loadNodeLogEntriesStrict(campaignId);
  } catch (error) {
    if (!(error instanceof NodeLogCorruptionError)) throw error;
    if (error.kind !== 'torn_final') {
      throw recoveryConflict(campaignId, nodeId, 'append-only node log contains interior corruption; automatic recovery is forbidden', {
        corruption_kind: error.kind,
        line_number: error.lineNumber,
      });
    }
    try {
      store.repairTornFinalNodeLogEntry(campaignId, event);
      return store.loadNodeLogEntriesStrict(campaignId);
    } catch (repairError) {
      if (repairError instanceof NodeLogCorruptionError) {
        throw recoveryConflict(campaignId, nodeId, 'torn final node-log fragment does not match the prepared revision event; automatic recovery is forbidden', {
          corruption_kind: repairError.kind,
          line_number: repairError.lineNumber,
        });
      }
      throw repairError;
    }
  }
}

function matchingRevisionEvents(logEntries: Array<Record<string, unknown>>, nodeId: string, idempotencyKey: string): Array<Record<string, unknown>> {
  return logEntries.filter((entry) => {
    if (entry.mutation !== 'revise_card' || entry.node_id !== nodeId) return false;
    return asRecord(entry.idempotency)?.idempotency_key === idempotencyKey;
  });
}

/** Complete the exact node/event embedded in a prepared revision record. */
export function recoverIdeaCardRevision(store: IdeaEngineStore, record: IdempotencyRecord): boolean {
  if (record.response.kind !== 'result') return true;
  const payload = record.response.payload;
  const event = asRecord(payload.mutation_event);
  const expectedNode = asRecord(payload.node);
  const beforeNode = asRecord(event?.before_node);
  const eventNode = asRecord(event?.node);
  const topLevelIdempotency = asRecord(payload.idempotency);
  const eventIdempotency = asRecord(event?.idempotency);
  const campaignId = payload.campaign_id;
  const nodeId = expectedNode?.node_id;
  const idempotencyKey = topLevelIdempotency?.idempotency_key;
  if (!event || !expectedNode || !beforeNode || !eventNode || !eventIdempotency || typeof campaignId !== 'string' || typeof nodeId !== 'string' || typeof idempotencyKey !== 'string') {
    throw recoveryConflict(
      typeof campaignId === 'string' ? campaignId : '00000000',
      typeof nodeId === 'string' ? nodeId : '00000000',
      'prepared node.revise_card response is malformed; exact recovery payload is unavailable',
    );
  }

  const targetRevision = Number(expectedNode.revision);
  const expectedRevision = Number(event.expected_revision);
  const beforeHash = event.before_idea_card_hash;
  const afterHash = event.after_idea_card_hash;
  if (
    typeof expectedNode.revision !== 'number' ||
    typeof event.expected_revision !== 'number' ||
    !Number.isInteger(targetRevision) ||
    !Number.isInteger(expectedRevision) ||
    targetRevision !== expectedRevision + 1 ||
    event.revision !== targetRevision ||
    typeof beforeHash !== 'string' ||
    typeof afterHash !== 'string' ||
    topLevelIdempotency?.payload_hash !== record.payload_hash ||
    eventIdempotency.idempotency_key !== idempotencyKey ||
    eventIdempotency.payload_hash !== record.payload_hash ||
    artifactPayloadHash(eventNode) !== artifactPayloadHash(expectedNode) ||
    event.campaign_id !== campaignId ||
    event.node_id !== nodeId ||
    beforeNode.campaign_id !== campaignId ||
    beforeNode.node_id !== nodeId ||
    beforeNode.revision !== expectedRevision ||
    artifactPayloadHash(beforeNode.idea_card ?? null) !== beforeHash ||
    artifactPayloadHash(expectedNode.idea_card ?? null) !== afterHash
  ) {
    throw recoveryConflict(campaignId, nodeId, 'prepared node.revise_card revisions or canonical hashes are inconsistent', {
      expected_revision: expectedRevision,
      target_revision: targetRevision,
    });
  }

  const logEntries = loadRecoverableLog(store, campaignId, nodeId, event);
  const ownEvents = matchingRevisionEvents(logEntries, nodeId, idempotencyKey);
  if (ownEvents.length > 1) {
    throw recoveryConflict(campaignId, nodeId, 'append-only log contains duplicate events for one node.revise_card idempotency key', {
      idempotency_key: idempotencyKey,
      event_count: ownEvents.length,
    });
  }
  if (ownEvents.length === 1 && artifactPayloadHash(ownEvents[0]) !== artifactPayloadHash(event)) {
    throw recoveryConflict(campaignId, nodeId, 'append-only log event conflicts with the exact event stored in the prepared idempotency record', {
      idempotency_key: idempotencyKey,
    });
  }

  const nodes = store.loadNodes<Record<string, unknown>>(campaignId);
  const current = nodes[nodeId];
  if (!current) throw recoveryConflict(campaignId, nodeId, 'node is missing while recovering a prepared card revision');
  const currentRevision = Number(current.revision);
  const currentCardHash = artifactPayloadHash(current.idea_card ?? null);
  if (ownEvents.length === 1) {
    if (currentRevision < targetRevision) {
      throw recoveryConflict(campaignId, nodeId, 'append-only revision event exists but latest node predates its resulting revision', {
        current_revision: currentRevision,
        target_revision: targetRevision,
      });
    }
    if (currentRevision === targetRevision && artifactPayloadHash(current) !== artifactPayloadHash(expectedNode)) {
      throw recoveryConflict(campaignId, nodeId, 'latest node at the logged target revision conflicts with the prepared result', { current_revision: currentRevision });
    }
    return true;
  }

  const blockingLaterEvent = logEntries.find((entry) => entry.node_id === nodeId && Number.isInteger(Number(entry.revision)) && Number(entry.revision) >= targetRevision);
  if (blockingLaterEvent) {
    throw recoveryConflict(campaignId, nodeId, 'a same-node event at the target or a later revision already exists; late insertion of the prepared event is forbidden', {
      target_revision: targetRevision,
      blocking_revision: Number(blockingLaterEvent.revision),
      blocking_mutation: blockingLaterEvent.mutation ?? null,
    });
  }
  if (currentRevision < expectedRevision) {
    throw recoveryConflict(campaignId, nodeId, 'latest node revision moved backwards relative to the prepared card revision', {
      current_revision: currentRevision,
      expected_revision: expectedRevision,
    });
  }
  if (currentRevision === expectedRevision) {
    if (currentCardHash !== beforeHash || artifactPayloadHash(current) !== artifactPayloadHash(beforeNode)) {
      throw recoveryConflict(campaignId, nodeId, 'latest node at expected_revision no longer equals the exact prepared before-state', {
        current_revision: currentRevision,
        current_card_hash: currentCardHash,
        before_idea_card_hash: beforeHash,
      });
    }
    nodes[nodeId] = structuredClone(expectedNode);
    store.saveNodes(campaignId, nodes);
    store.appendNodeLogEntry(campaignId, structuredClone(event));
    return true;
  }
  if (currentRevision > targetRevision) {
    throw recoveryConflict(campaignId, nodeId, 'latest node advanced beyond the prepared revision before its event landed; late insertion is forbidden', {
      current_revision: currentRevision,
      target_revision: targetRevision,
    });
  }
  if (currentRevision !== targetRevision || currentCardHash !== afterHash || artifactPayloadHash(current) !== artifactPayloadHash(expectedNode)) {
    throw recoveryConflict(campaignId, nodeId, 'latest node at the target revision conflicts with the exact prepared result', {
      current_revision: currentRevision,
      current_card_hash: currentCardHash,
      after_idea_card_hash: afterHash,
    });
  }
  store.appendNodeLogEntry(campaignId, structuredClone(event));
  return true;
}
