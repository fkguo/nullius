import { randomUUID } from 'node:crypto';

import type { EpigeneticMark } from '../generated/index.js';
import type { CapsuleWithMeta, MemoryGraphEdge, MemoryGraphNode, NodeSummary } from './types.js';
import { normalizeSignals } from './hash.js';
import { jaccardSimilarity } from './similarity.js';
import { execSql, queryJson, sqlJsonLiteral, sqlStringLiteral } from './sqlite-cli.js';
import { withReadPragmas, withWritePragmas } from './sqlite-schema.js';

export interface SqliteGraphBackend {
  dbPath: string;
  ensureInitialized(): Promise<void>;
}

interface NodeRow {
  id: string;
  node_type: string;
  track: MemoryGraphNode['track'];
  payload: string;
  created_at: string;
  updated_at: string;
  decay_ts: string | null;
  weight: number;
}

function parseNode(row: NodeRow): MemoryGraphNode {
  return { ...row, payload: JSON.parse(row.payload) as Record<string, unknown> };
}

export async function addNodeRecord(backend: SqliteGraphBackend, node: Omit<MemoryGraphNode, 'id' | 'created_at' | 'updated_at'>): Promise<string> {
  await backend.ensureInitialized();
  const id = `mgn_${randomUUID()}`;
  const now = new Date().toISOString();
  const sql = withWritePragmas(`
    INSERT INTO mg_nodes(id, node_type, track, payload, created_at, updated_at, decay_ts, weight)
    VALUES (${sqlStringLiteral(id)}, ${sqlStringLiteral(node.node_type)}, ${sqlStringLiteral(node.track)},
      ${sqlJsonLiteral(node.payload)}, ${sqlStringLiteral(now)}, ${sqlStringLiteral(now)},
      ${node.decay_ts ? sqlStringLiteral(node.decay_ts) : 'NULL'}, ${node.weight})
  `);
  await execSql(backend.dbPath, sql);
  return id;
}

export async function addEdgeRecord(backend: SqliteGraphBackend, edge: Omit<MemoryGraphEdge, 'id' | 'created_at'>): Promise<string> {
  await backend.ensureInitialized();
  const id = `mge_${randomUUID()}`;
  const now = new Date().toISOString();
  const sql = withWritePragmas(`
    INSERT INTO mg_edges(id, edge_type, source_id, target_id, payload, created_at, weight)
    VALUES (${sqlStringLiteral(id)}, ${sqlStringLiteral(edge.edge_type)}, ${sqlStringLiteral(edge.source_id)},
      ${sqlStringLiteral(edge.target_id)}, ${sqlJsonLiteral(edge.payload)}, ${sqlStringLiteral(now)}, ${edge.weight})
  `);
  await execSql(backend.dbPath, sql);
  return id;
}

export async function updateGeneMarksRecord(backend: SqliteGraphBackend, geneId: string, marks: EpigeneticMark[]): Promise<void> {
  await backend.ensureInitialized();
  const rows = await queryJson<NodeRow>(backend.dbPath, withReadPragmas(`
    SELECT id, node_type, track, payload, created_at, updated_at, decay_ts, weight
    FROM mg_nodes WHERE node_type = 'gene'
  `), { readonly: true });

  const matching = rows.map(parseNode).filter(node => (node.payload as { gene_id?: string }).gene_id === geneId);
  const now = new Date().toISOString();
  for (const node of matching) {
    const payload = { ...node.payload, epigenetic_marks: marks };
    const sql = withWritePragmas(`
      UPDATE mg_nodes SET payload = ${sqlJsonLiteral(payload)}, updated_at = ${sqlStringLiteral(now)}
      WHERE id = ${sqlStringLiteral(node.id)}
    `);
    await execSql(backend.dbPath, sql);
  }
}

export async function archivalCandidatesRecord(backend: SqliteGraphBackend, weightThreshold: number): Promise<NodeSummary[]> {
  await backend.ensureInitialized();
  const rows = await queryJson<Array<{ id: string; node_type: string; track: MemoryGraphNode['track']; weight: number; updated_at: string }>[number]>(
    backend.dbPath,
    withReadPragmas(`
      SELECT id, node_type, track, weight, updated_at
      FROM mg_nodes WHERE weight < ${weightThreshold}
      ORDER BY weight ASC, updated_at ASC
    `),
    { readonly: true },
  );
  return rows.map(row => ({ id: row.id, nodeType: row.node_type, track: row.track, weight: row.weight, updatedAt: row.updated_at }));
}

export async function listNodeDecayInputsRecord(backend: SqliteGraphBackend): Promise<Array<{ id: string; updated_at: string }>> {
  await backend.ensureInitialized();
  return queryJson(backend.dbPath, withReadPragmas(`SELECT id, updated_at FROM mg_nodes`), { readonly: true });
}

export async function applyNodeDecayUpdatesRecord(
  backend: SqliteGraphBackend,
  updates: Array<{ id: string; weight: number; decayTs: string }>,
): Promise<void> {
  await backend.ensureInitialized();
  for (const update of updates) {
    const sql = withWritePragmas(`
      UPDATE mg_nodes SET weight = ${update.weight}, decay_ts = ${sqlStringLiteral(update.decayTs)}
      WHERE id = ${sqlStringLiteral(update.id)}
    `);
    await execSql(backend.dbPath, sql);
  }
}

export async function findSimilarCapsulesRecord(
  backend: SqliteGraphBackend,
  normalizedTrigger: string[],
  jaccardThreshold: number,
): Promise<CapsuleWithMeta[]> {
  await backend.ensureInitialized();
  const rows = await queryJson<NodeRow>(backend.dbPath, withReadPragmas(`
    SELECT id, node_type, track, payload, created_at, updated_at, decay_ts, weight
    FROM mg_nodes WHERE node_type = 'capsule'
  `), { readonly: true });

  const current = new Set(normalizedTrigger);
  return rows.map(parseNode)
    .map(node => {
      const trigger = Array.isArray((node.payload as { trigger?: unknown }).trigger)
        ? normalizeSignals((node.payload as { trigger: string[] }).trigger)
        : [];
      return { node, similarity: jaccardSimilarity(current, new Set(trigger)) };
    })
    .filter(item => item.similarity >= jaccardThreshold)
    .sort((left, right) => right.similarity - left.similarity);
}
