import { existsSync, readFileSync } from 'fs';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { canonicalJson, payloadHash } from '../hash/payload-hash.js';
import { exhaustedDimensions } from './budget-snapshot.js';
import { RpcError } from './errors.js';

export const IMPORT_GENERATED_METHOD = 'node.import_generated';
export const IMPORT_ARTIFACT_TYPE = 'generation';

/**
 * The idea_node_v1 mutability contract's IMMUTABLE fields. Recovery compares
 * nodes on this projection only: mutable fields (posterior, lifecycle_state,
 * grounding_audit, idea_card, revision, updated_at, ...) may legitimately have
 * moved between the crash and the retry — e.g. an admission run archived the
 * node — and must not be mistaken for import corruption.
 */
const IMMUTABLE_NODE_FIELDS = [
  'campaign_id',
  'idea_id',
  'node_id',
  'parent_node_ids',
  'island_id',
  'operator_id',
  'operator_family',
  'origin',
  'operator_trace',
  'rationale_draft',
  'created_at',
] as const;

export function immutableNodeProjection(node: Record<string, unknown>): Record<string, unknown> {
  const projection: Record<string, unknown> = {};
  for (const field of IMMUTABLE_NODE_FIELDS) {
    if (node[field] !== undefined) {
      projection[field] = node[field];
    }
  }
  return projection;
}

interface ImportedEntry {
  idea_id: string;
  node_id: string;
  operator_family: string;
  operator_id: string;
}

interface ImportArchive {
  engine_assembled: {
    imported_at: string;
    method: string;
    nodes: Record<string, Record<string, unknown>>;
  };
  pack: Record<string, unknown>;
  pack_hash: string;
}

function recoveryConflict(
  campaignId: string,
  message: string,
  details: Record<string, unknown> = {},
): RpcError {
  return new RpcError(-32603, 'internal_error', {
    reason: 'import_recovery_conflict',
    campaign_id: campaignId,
    details: { message, ...details },
  });
}

/** node_ids that already have a `create` entry in the campaign's node log. */
function loggedCreateNodeIds(store: IdeaEngineStore, campaignId: string): Set<string> {
  const logged = new Set<string>();
  const logPath = store.nodesLogPath(campaignId);
  if (!existsSync(logPath)) {
    return logged;
  }
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      if (entry.mutation === 'create' && typeof entry.node_id === 'string') {
        logged.add(entry.node_id);
      }
    } catch {
      // A torn trailing line from a crash mid-append is possible; it can only
      // be the final line and only for an entry we are about to re-append.
      continue;
    }
  }
  return logged;
}

function loadArchiveOrNull(store: IdeaEngineStore, campaignId: string, ref: string): ImportArchive | null {
  try {
    return store.loadArtifactFromRef<Record<string, unknown>>(ref) as unknown as ImportArchive;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    throw recoveryConflict(campaignId, `pack artifact unreadable: ${String((error as Error).message)}`, {
      pack_artifact_ref: ref,
    });
  }
}

/**
 * Import-specific crash recovery, called from the idempotency layer when a
 * PREPARED node.import_generated record is found on retry.
 *
 * The generic prepared-record handling (delete + fresh re-execution) is only
 * safe when NOTHING landed: a fresh run re-mints node ids, so re-executing on
 * top of partially landed effects would import the same burst twice under new
 * ids. This routine therefore probes all four effect classes recorded by the
 * import (pack artifact + hash, nodes on their immutable projection, one
 * `create` node-log entry per node, derived campaign usage) and COMPLETES the
 * missing ones from the archived pack artifact — never re-minting, never
 * regenerating.
 *
 * Returns:
 * - true  → effects verified/completed; the caller commits and replays.
 * - false → nothing landed at all; the generic fresh re-execution is safe.
 * - throws import_recovery_conflict → a value mismatch that completion cannot
 *   resolve; manual repair required.
 */
export function recoverImportGenerated(
  store: IdeaEngineStore,
  record: { response: { kind: string; payload: Record<string, unknown> } },
): boolean {
  if (record.response.kind !== 'result') {
    return true;
  }
  const payload = record.response.payload;
  const campaignId = String(payload.campaign_id ?? '');
  const imported = Array.isArray(payload.imported) ? (payload.imported as ImportedEntry[]) : [];
  const packArtifactRef = String(payload.pack_artifact_ref ?? '');
  const recordedPackHash = String(payload.pack_hash ?? '');
  const recordedArchiveHash = String(payload.archive_hash ?? '');
  if (!campaignId || imported.length === 0 || !packArtifactRef || !recordedPackHash || !recordedArchiveHash) {
    throw recoveryConflict(campaignId || 'unknown', 'recorded import result payload is malformed');
  }

  const archive = loadArchiveOrNull(store, campaignId, packArtifactRef);
  const nodes = store.loadNodes<Record<string, unknown>>(campaignId);
  const anyNodePresent = imported.some(entry => nodes[String(entry.node_id)] !== undefined);

  if (!archive) {
    if (!anyNodePresent) {
      // Crash landed between the prepared record and the first store write:
      // zero effects exist, so the generic delete-and-re-execute path is safe.
      return false;
    }
    throw recoveryConflict(campaignId, 'pack artifact missing but imported nodes present', {
      pack_artifact_ref: packArtifactRef,
    });
  }

  // archive_hash covers the ENTIRE artifact — verbatim pack AND the
  // engine-assembled node payloads completion may re-write below. Verifying
  // it first means recovery only ever completes from content the original
  // execution produced and schema-validated (pinned, not trusted); a
  // tampered/corrupted engine_assembled section can never be imported.
  if (payloadHash(archive as unknown as Record<string, unknown>) !== recordedArchiveHash) {
    throw recoveryConflict(campaignId, 'archived artifact does not match recorded archive_hash', {
      pack_artifact_ref: packArtifactRef,
    });
  }
  if (payloadHash(archive.pack) !== recordedPackHash) {
    throw recoveryConflict(campaignId, 'archived pack content does not match recorded pack_hash', {
      pack_artifact_ref: packArtifactRef,
    });
  }

  const assembled = archive.engine_assembled?.nodes ?? {};
  let nodesMutated = false;
  for (const entry of imported) {
    const nodeId = String(entry.node_id);
    const expected = assembled[nodeId];
    if (!expected) {
      throw recoveryConflict(campaignId, 'archived pack lacks an assembled node recorded in the result', {
        node_id: nodeId,
      });
    }
    const current = nodes[nodeId];
    if (!current) {
      nodes[nodeId] = structuredClone(expected);
      nodesMutated = true;
      continue;
    }
    if (canonicalJson(immutableNodeProjection(current)) !== canonicalJson(immutableNodeProjection(expected))) {
      throw recoveryConflict(campaignId, 'stored node disagrees with the archived import on immutable fields', {
        node_id: nodeId,
      });
    }
  }
  if (nodesMutated) {
    store.saveNodes(campaignId, nodes);
  }

  const logged = loggedCreateNodeIds(store, campaignId);
  for (const entry of imported) {
    const nodeId = String(entry.node_id);
    if (!logged.has(nodeId)) {
      store.appendNodeLog(campaignId, assembled[nodeId]!, 'create', {
        method: IMPORT_GENERATED_METHOD,
        pack_artifact_ref: packArtifactRef,
      });
    }
  }

  // usage.nodes_used is derived state (total node count, as campaign.init
  // defines it), so recovery recomputes rather than comparing a recorded
  // counter — robust to imports/promotions that ran between crash and retry.
  const campaign = store.loadCampaign<Record<string, unknown> & { campaign_id: string }>(campaignId);
  if (!campaign) {
    throw recoveryConflict(campaignId, 'campaign manifest missing during import recovery');
  }
  const usage = campaign.usage as Record<string, number>;
  const nodeCount = Object.keys(store.loadNodes<Record<string, unknown>>(campaignId)).length;
  if (Number(usage.nodes_used) !== nodeCount) {
    usage.nodes_used = nodeCount;
    const budgeted = campaign as unknown as { budget: Record<string, number | null>; usage: Record<string, number> };
    if (campaign.status === 'running' && exhaustedDimensions(budgeted).length > 0) {
      // Only running → exhausted: recovery never resurrects paused/completed
      // campaigns and never un-exhausts one.
      campaign.status = 'exhausted';
    }
    store.saveCampaign(campaign);
  }

  return true;
}
