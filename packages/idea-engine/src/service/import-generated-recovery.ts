import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { canonicalJson, payloadHash } from '../hash/payload-hash.js';
import { writeJsonFileAtomic } from '../store/file-io.js';
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

function readArchiveFileOrNull(path: string): ImportArchive | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ImportArchive;
  } catch {
    return null;
  }
}

function replacePackArtifactRefInNode(node: Record<string, unknown>, oldRef: string, newRef: string): boolean {
  const trace = node.operator_trace;
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
    return false;
  }
  const inputs = (trace as Record<string, unknown>).inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    return false;
  }
  const inputRecord = inputs as Record<string, unknown>;
  if (inputRecord.pack_artifact !== oldRef) {
    return false;
  }
  inputRecord.pack_artifact = newRef;
  return true;
}

function markReplay(payload: Record<string, unknown>, isReplay: boolean): void {
  const idempotency = payload.idempotency;
  if (idempotency && typeof idempotency === 'object' && !Array.isArray(idempotency)) {
    (idempotency as Record<string, unknown>).is_replay = isReplay;
  }
}

function updateReplayIdempotencyRecord(
  store: IdeaEngineStore,
  campaignId: string,
  idempotencyKeyValue: string,
  payload: Record<string, unknown>,
): void {
  const idempotencyStore = store.loadIdempotency<Record<string, unknown>>(campaignId);
  const key = `${IMPORT_GENERATED_METHOD}:${idempotencyKeyValue}`;
  const record = idempotencyStore[key] as Record<string, unknown> | undefined;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw recoveryConflict(campaignId, 'idempotency record missing during import replay migration', {
      idempotency_key: idempotencyKeyValue,
    });
  }
  const response = record.response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw recoveryConflict(campaignId, 'idempotency record response malformed during import replay migration', {
      idempotency_key: idempotencyKeyValue,
    });
  }
  (response as Record<string, unknown>).payload = payload;
  record.state = 'committed';
  idempotencyStore[key] = record as Record<string, unknown>;
  store.saveIdempotency(campaignId, idempotencyStore);
}

function updateNodeLogRefs(
  store: IdeaEngineStore,
  campaignId: string,
  imported: ImportedEntry[],
  oldRef: string,
  newRef: string,
): void {
  const logPath = store.nodesLogPath(campaignId);
  if (!existsSync(logPath)) {
    return;
  }
  const importedIds = new Set(imported.map(entry => String(entry.node_id)));
  const content = readFileSync(logPath, 'utf8');
  let changed = false;
  const lines = content.split('\n').map(line => {
    if (!line.trim()) {
      return line;
    }
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      let entryChanged = false;
      if (entry.pack_artifact_ref === oldRef) {
        entry.pack_artifact_ref = newRef;
        entryChanged = true;
      }
      const node = entry.node;
      if (importedIds.has(String(entry.node_id)) && node && typeof node === 'object' && !Array.isArray(node)) {
        entryChanged = replacePackArtifactRefInNode(node as Record<string, unknown>, oldRef, newRef) || entryChanged;
      }
      if (!entryChanged) {
        return line;
      }
      changed = true;
      return JSON.stringify(entry);
    } catch {
      return line;
    }
  });
  if (!changed) {
    return;
  }
  const tempPath = `${logPath}.tmp`;
  writeFileSync(tempPath, lines.join('\n'), 'utf8');
  renameSync(tempPath, logPath);
}

function legacyFileBasename(artifactRef: string): string | null {
  try {
    return basename(fileURLToPath(new URL(artifactRef)));
  } catch {
    return null;
  }
}

function candidateGenerationArtifactPaths(store: IdeaEngineStore, campaignId: string, legacyRef: string): string[] {
  const candidates = new Set<string>();
  try {
    const directPath = store.artifactPathFromRef(legacyRef);
    if (existsSync(directPath)) {
      candidates.add(directPath);
    }
  } catch {
    // A legacy file:// ref may point at the old machine/path after the project
    // moved. The current store copy is still discoverable by content below.
  }

  const generationDir = dirname(store.artifactPath(campaignId, IMPORT_ARTIFACT_TYPE, '__scan__.json'));
  if (!existsSync(generationDir)) {
    return [...candidates];
  }

  const legacyName = legacyFileBasename(legacyRef);
  const entries = readdirSync(generationDir)
    .filter(name => name.endsWith('.json'))
    .sort((left, right) => {
      if (left === legacyName) return -1;
      if (right === legacyName) return 1;
      return left.localeCompare(right);
    });
  for (const entry of entries) {
    candidates.add(store.artifactPath(campaignId, IMPORT_ARTIFACT_TYPE, entry));
  }
  return [...candidates];
}

function archiveWithRefsReplaced(
  archive: ImportArchive,
  imported: ImportedEntry[],
  oldRef: string,
  newRef: string,
): ImportArchive {
  const clone = structuredClone(archive) as ImportArchive;
  const assembled = clone.engine_assembled?.nodes ?? {};
  for (const entry of imported) {
    const node = assembled[String(entry.node_id)];
    if (node) {
      replacePackArtifactRefInNode(node, oldRef, newRef);
    }
  }
  return clone;
}

interface LegacyArchiveMigration {
  archive: ImportArchive;
  artifactPath: string;
  newRef: string;
}

function searchLegacyArchiveForMigration(options: {
  campaignId: string;
  imported: ImportedEntry[];
  legacyRef: string;
  recordedArchiveHash: string;
  recordedPackHash: string;
  store: IdeaEngineStore;
}): { match: LegacyArchiveMigration | null; packHashMatchCount: number } {
  let packHashMatchCount = 0;
  for (const artifactPath of candidateGenerationArtifactPaths(options.store, options.campaignId, options.legacyRef)) {
    const archive = readArchiveFileOrNull(artifactPath);
    if (!archive || !archive.pack || !archive.engine_assembled) {
      continue;
    }
    if (payloadHash(archive.pack) !== options.recordedPackHash) {
      continue;
    }
    packHashMatchCount += 1;
    const newRef = options.store.portableArtifactRef(artifactPath, options.recordedPackHash);
    if (payloadHash(archive as unknown as Record<string, unknown>) === options.recordedArchiveHash) {
      return { match: { archive, artifactPath, newRef }, packHashMatchCount };
    }

    // Resumability: if a previous replay died after rewriting the archive but
    // before updating idempotency, the current archive contains newRef while
    // the stored record still carries legacyRef + the old archive_hash.
    const legacyEquivalent = archiveWithRefsReplaced(archive, options.imported, newRef, options.legacyRef);
    if (payloadHash(legacyEquivalent as unknown as Record<string, unknown>) === options.recordedArchiveHash) {
      return { match: { archive, artifactPath, newRef }, packHashMatchCount };
    }
  }

  return { match: null, packHashMatchCount };
}

function legacyArchiveNotFoundConflict(options: {
  campaignId: string;
  legacyRef: string;
  packHashMatchCount: number;
}): never {
  throw recoveryConflict(options.campaignId, 'current pack artifact not found for legacy replay migration', {
    matching_pack_hash_artifacts: options.packHashMatchCount,
    pack_artifact_ref: options.legacyRef,
  });
}

function findLegacyArchiveForMigration(options: {
  campaignId: string;
  imported: ImportedEntry[];
  legacyRef: string;
  recordedArchiveHash: string;
  recordedPackHash: string;
  store: IdeaEngineStore;
}): LegacyArchiveMigration {
  const search = searchLegacyArchiveForMigration(options);
  if (search.match) {
    return search.match;
  }
  legacyArchiveNotFoundConflict({
    campaignId: options.campaignId,
    legacyRef: options.legacyRef,
    packHashMatchCount: search.packHashMatchCount,
  });
}

export function refreshImportGeneratedReplay(
  store: IdeaEngineStore,
  idempotencyKeyValue: string,
  replayPayload: Record<string, unknown>,
): Record<string, unknown> {
  const payload = structuredClone(replayPayload);
  const campaignId = String(payload.campaign_id ?? '');
  const imported = Array.isArray(payload.imported) ? (payload.imported as ImportedEntry[]) : [];
  const packArtifactRef = String(payload.pack_artifact_ref ?? '');
  const recordedPackHash = String(payload.pack_hash ?? '');
  const recordedArchiveHash = String(payload.archive_hash ?? '');
  if (!campaignId || imported.length === 0 || !packArtifactRef || !recordedPackHash || !recordedArchiveHash) {
    throw recoveryConflict(campaignId || 'unknown', 'recorded import replay payload is malformed');
  }

  const refHash = store.artifactHashFromRef(packArtifactRef);
  if (refHash !== null) {
    if (refHash !== recordedPackHash) {
      throw recoveryConflict(campaignId, 'pack artifact ref hash disagrees with recorded pack_hash', {
        pack_artifact_ref: packArtifactRef,
      });
    }
    markReplay(payload, true);
    return payload;
  }

  if (!packArtifactRef.startsWith('file://')) {
    throw recoveryConflict(campaignId, 'pack artifact ref is neither project:// nor legacy file://', {
      pack_artifact_ref: packArtifactRef,
    });
  }

  const { archive, artifactPath, newRef } = findLegacyArchiveForMigration({
    campaignId,
    imported,
    legacyRef: packArtifactRef,
    recordedArchiveHash,
    recordedPackHash,
    store,
  });
  const migratedArchive = archiveWithRefsReplaced(archive, imported, packArtifactRef, newRef);
  const newArchiveHash = payloadHash(migratedArchive as unknown as Record<string, unknown>);
  writeJsonFileAtomic(artifactPath, migratedArchive as unknown as Record<string, unknown>);

  const nodes = store.loadNodes<Record<string, unknown>>(campaignId);
  let nodesMutated = false;
  for (const entry of imported) {
    const node = nodes[String(entry.node_id)];
    if (node) {
      nodesMutated = replacePackArtifactRefInNode(node, packArtifactRef, newRef) || nodesMutated;
    }
  }
  if (nodesMutated) {
    store.saveNodes(campaignId, nodes);
  }
  updateNodeLogRefs(store, campaignId, imported, packArtifactRef, newRef);

  payload.pack_artifact_ref = newRef;
  payload.archive_hash = newArchiveHash;
  const storedPayload = structuredClone(payload);
  markReplay(storedPayload, false);
  updateReplayIdempotencyRecord(store, campaignId, idempotencyKeyValue, storedPayload);
  markReplay(payload, true);
  return payload;
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

  const nodes = store.loadNodes<Record<string, unknown>>(campaignId);
  const anyNodePresent = imported.some(entry => nodes[String(entry.node_id)] !== undefined);

  let archive: ImportArchive | null;
  let effectivePackArtifactRef = packArtifactRef;
  let effectiveArchiveHash = recordedArchiveHash;
  let legacyMigrationPath: string | null = null;
  let legacyMigrationOldRef: string | null = null;
  let legacyMigrationNewRef: string | null = null;
  if (packArtifactRef.startsWith('file://')) {
    const search = searchLegacyArchiveForMigration({
      campaignId,
      imported,
      legacyRef: packArtifactRef,
      recordedArchiveHash,
      recordedPackHash,
      store,
    });
    if (!search.match) {
      if (!anyNodePresent) {
        // Crash landed between the prepared record and the first store write:
        // zero effects exist, so the generic delete-and-re-execute path is safe.
        return false;
      }
      legacyArchiveNotFoundConflict({
        campaignId,
        legacyRef: packArtifactRef,
        packHashMatchCount: search.packHashMatchCount,
      });
    }
    legacyMigrationPath = search.match.artifactPath;
    legacyMigrationOldRef = packArtifactRef;
    legacyMigrationNewRef = search.match.newRef;
    effectivePackArtifactRef = search.match.newRef;
    archive = archiveWithRefsReplaced(search.match.archive, imported, packArtifactRef, search.match.newRef);
    effectiveArchiveHash = payloadHash(archive as unknown as Record<string, unknown>);
  } else {
    archive = loadArchiveOrNull(store, campaignId, packArtifactRef);
  }

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

  const refHash = store.artifactHashFromRef(effectivePackArtifactRef);
  if (refHash !== null && refHash !== recordedPackHash) {
    throw recoveryConflict(campaignId, 'pack artifact ref hash disagrees with recorded pack_hash', {
      pack_artifact_ref: effectivePackArtifactRef,
    });
  }

  // archive_hash covers the ENTIRE artifact — verbatim pack AND the
  // engine-assembled node payloads completion may re-write below. Verifying
  // it first means recovery only ever completes from content the original
  // execution produced and schema-validated (pinned, not trusted); a
  // tampered/corrupted engine_assembled section can never be imported.
  if (legacyMigrationPath === null && payloadHash(archive as unknown as Record<string, unknown>) !== recordedArchiveHash) {
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
    const comparableCurrent = structuredClone(current);
    if (legacyMigrationOldRef !== null && legacyMigrationNewRef !== null) {
      replacePackArtifactRefInNode(comparableCurrent, legacyMigrationOldRef, legacyMigrationNewRef);
    }
    if (canonicalJson(immutableNodeProjection(comparableCurrent)) !== canonicalJson(immutableNodeProjection(expected))) {
      throw recoveryConflict(campaignId, 'stored node disagrees with the archived import on immutable fields', {
        node_id: nodeId,
      });
    }
    if (
      legacyMigrationOldRef !== null
      && legacyMigrationNewRef !== null
      && replacePackArtifactRefInNode(current, legacyMigrationOldRef, legacyMigrationNewRef)
    ) {
      nodesMutated = true;
    }
  }
  if (legacyMigrationPath !== null) {
    writeJsonFileAtomic(legacyMigrationPath, archive as unknown as Record<string, unknown>);
  }
  if (nodesMutated) {
    store.saveNodes(campaignId, nodes);
  }
  if (legacyMigrationOldRef !== null && legacyMigrationNewRef !== null) {
    updateNodeLogRefs(store, campaignId, imported, legacyMigrationOldRef, legacyMigrationNewRef);
    payload.pack_artifact_ref = legacyMigrationNewRef;
    payload.archive_hash = effectiveArchiveHash;
  }

  const logged = loggedCreateNodeIds(store, campaignId);
  for (const entry of imported) {
    const nodeId = String(entry.node_id);
    if (!logged.has(nodeId)) {
      store.appendNodeLog(campaignId, assembled[nodeId]!, 'create', {
        method: IMPORT_GENERATED_METHOD,
        pack_artifact_ref: effectivePackArtifactRef,
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
